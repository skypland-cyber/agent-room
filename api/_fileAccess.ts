// Who may touch a room's files, and the one URL shape that carries a grant.
//
// Reading is the part that leaks. A vault file's download URL must not be
// usable by whoever happens to see it, and it must not bake a seatKey or a
// hostKey into a query string that ends up in a log, a Referer header or a
// shared screenshot. So the server issues a short-lived token that names ONE
// file and expires — signed with a server secret, verifiable without a Redis
// round trip, and worthless for anything else.
//
// Agent access rides on the existing seats: a `cc` seatKey for an agent that
// joined, an MCP grant token for a hosted client, the hostKey for the host.
// Files are room-scoped, so every check ends at the room document, which is
// already the source of truth for who is in the meeting.

import { createHmac, timingSafeEqual } from 'node:crypto';
import type { VaultFileKind } from '@agent-room/shared';
import { isValidCode } from '@agent-room/shared';
import type { UpstashClient } from '@agent-room/upstash-client';
import { digest, authenticateMcp, findSeat, type McpGrant } from './_roomAccess.js';
import { assertHostFor } from './_mcpRoomClient.js';
import { RemoteRoomApiError } from './_mcpRoomClient.js';
import { getRoom } from '@agent-room/upstash-client';

export type VaultPrincipal = {
  name: string;
  client: 'web' | 'cc';
  isHost: boolean;
  via: 'seat' | 'host' | 'mcp';
  grant?: McpGrant;
  /** Durable project the room belongs to, when it has one (Room.projectId). */
  projectId?: string;
  projectName?: string;
};

export interface VaultTokenPayload {
  /** Room code the token is scoped to. */
  c: string;
  /** File kind + id, so the token cannot be re-pointed at another file. */
  k: VaultFileKind;
  f: string;
  /** Expiry, epoch ms. */
  e: number;
}

/**
 * Secret used to sign download URLs.
 *
 * FILES_SIGNING_SECRET is the documented one. Falling back to a deployment
 * secret that already exists keeps a fresh install working without extra
 * setup; rotating any of them only invalidates links that were going to expire
 * in minutes anyway.
 */
function signingSecret(): string | null {
  const explicit = process.env.FILES_SIGNING_SECRET;
  if (explicit && explicit.length >= 16) return explicit;
  const fallback = process.env.BLOB_READ_WRITE_TOKEN
    ?? process.env.R2_SECRET_ACCESS_KEY
    ?? process.env.MCP_AUTH_GRANTS
    ?? null;
  return fallback ? `agent-room-vault:${fallback}` : null;
}

export function vaultSigningConfigured(): boolean {
  return signingSecret() !== null;
}

const b64url = (value: Buffer | string): string =>
  Buffer.from(value).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

function fromB64url(value: string): Buffer {
  const padded = value.replace(/-/g, '+').replace(/_/g, '/');
  return Buffer.from(padded + '='.repeat((4 - (padded.length % 4)) % 4), 'base64');
}

/** Sign a download grant for one file. Returns null when no secret is set. */
export function signVaultToken(payload: Omit<VaultTokenPayload, 'e'> & { ttlMs?: number }): string | null {
  const secret = signingSecret();
  if (!secret) return null;
  const body: VaultTokenPayload = { c: payload.c, k: payload.k, f: payload.f, e: Date.now() + (payload.ttlMs ?? 15 * 60_000) };
  const encoded = b64url(JSON.stringify(body));
  const signature = b64url(createHmac('sha256', secret).update(encoded).digest());
  return `${encoded}.${signature}`;
}

/** Verify a download grant. Null when it is invalid, expired or malformed. */
export function verifyVaultToken(token: unknown): VaultTokenPayload | null {
  if (typeof token !== 'string' || !token.includes('.')) return null;
  const secret = signingSecret();
  if (!secret) return null;
  const [encoded, signature] = token.split('.');
  if (!encoded || !signature) return null;
  const expected = b64url(createHmac('sha256', secret).update(encoded).digest());
  const a = Buffer.from(signature);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
  let payload: VaultTokenPayload;
  try {
    payload = JSON.parse(fromB64url(encoded).toString('utf8')) as VaultTokenPayload;
  } catch {
    return null;
  }
  if (!payload || typeof payload.c !== 'string' || !isValidCode(payload.c)) return null;
  if (payload.k !== 'material' && payload.k !== 'deliverable') return null;
  if (typeof payload.f !== 'string' || !payload.f) return null;
  if (typeof payload.e !== 'number' || payload.e < Date.now()) return null;
  return payload;
}

/** `Authorization: Bearer <token>` → token. */
export function bearerToken(header: unknown): string | undefined {
  if (typeof header !== 'string') return undefined;
  return /^Bearer\s+([A-Za-z0-9._-]{16,4096})$/i.exec(header.trim())?.[1];
}

export interface VaultAuthInput {
  store: UpstashClient;
  code: string;
  seatKey?: unknown;
  hostKey?: unknown;
  authorization?: unknown;
  /** Name the caller claims; when given it must match the proven seat. */
  name?: unknown;
}

/**
 * Resolve the caller into a principal, or null.
 *
 * Order matters: a hostKey is the strongest claim the host holds, a seatKey is
 * a joined seat, and an MCP grant is a deployment-level credential that may
 * still only touch the rooms it was scoped to.
 */
export async function authorizeVault(input: VaultAuthInput): Promise<VaultPrincipal | null> {
  const { store, code } = input;
  if (!isValidCode(code)) return null;

  const hostKey = typeof input.hostKey === 'string' ? input.hostKey : undefined;
  if (hostKey) {
    try {
      const room = await assertHostFor(store, code, hostKey);
      return {
        name: room.createdBy, client: 'web', isHost: true, via: 'host',
        ...(room.projectId ? { projectId: room.projectId } : {}),
        ...(room.projectName ? { projectName: room.projectName } : {}),
      };
    } catch {
      // Not the host: fall through to seat proof, the caller may still be a
      // participant who happened to send a stale key.
    }
  }

  const room = await getRoom(store, code).catch(() => null);
  if (!room) return null;

  const seatKey = typeof input.seatKey === 'string' ? input.seatKey : undefined;
  if (seatKey) {
    const webSeat = findSeat(room, 'web', seatKey);
    const agentSeat = webSeat ? undefined : findSeat(room, 'cc', seatKey);
    const seat = webSeat ?? agentSeat;
    if (seat) {
      if (typeof input.name === 'string' && input.name.trim() && input.name.trim() !== seat.name) return null;
      return {
        name: seat.name,
        client: seat.client,
        isHost: seat.name === room.createdBy && seat.client === 'web',
        via: 'seat',
        ...(room.projectId ? { projectId: room.projectId } : {}),
        ...(room.projectName ? { projectName: room.projectName } : {}),
      };
    }
  }

  const token = bearerToken(input.authorization);
  if (token) {
    let access: { id: string; grant: McpGrant } | null = null;
    try {
      access = authenticateMcp(`Bearer ${token}`, process.env.MCP_AUTH_GRANTS);
    } catch {
      access = null;
    }
    if (access) {
      const allowed = access.grant.rooms === '*' || access.grant.rooms.includes(code);
      if (allowed) {
        const seat = findSeat(room, 'cc', input.seatKey);
        const claimed = typeof input.name === 'string' ? input.name.trim() : '';
        // A grant lets the caller act for a seated agent only; naming someone
        // else is an impersonation the room would not otherwise catch.
        const project = {
          ...(room.projectId ? { projectId: room.projectId } : {}),
          ...(room.projectName ? { projectName: room.projectName } : {}),
        };
        if (seat && (!claimed || claimed === seat.name)) {
          return { name: seat.name, client: 'cc', isHost: false, via: 'mcp', grant: access.grant, ...project };
        }
        if (!claimed) return { name: '', client: 'cc', isHost: false, via: 'mcp', grant: access.grant, ...project };
      }
    }
  }
  return null;
}

/** True when the principal may read every file in the room. */
export function canReadWholeRoom(principal: VaultPrincipal): boolean {
  return principal.isHost || principal.via === 'mcp';
}

/**
 * Files are visible to every joined participant: the vault is the room's shared
 * desk, not a private drive. Deletion is narrower — the uploader, a deliverable's
 * producer, or the host — and that check lives next to the delete handler.
 */
export function canDeleteFile(principal: VaultPrincipal, file: { uploadedBy: string; producer?: string }): boolean {
  if (principal.isHost) return true;
  if (!principal.name) return false;
  return file.uploadedBy === principal.name || file.producer === principal.name;
}

export function unauthorized(message = 'Join the room before using its file vault.'): RemoteRoomApiError {
  return new RemoteRoomApiError(message, 403, 'vault_unauthorized');
}

/** Hex digest of a seat key, for audit lines that must not carry the key. */
export const seatDigestForAudit = (seatKey: string): string => digest(seatKey).slice(0, 12);
