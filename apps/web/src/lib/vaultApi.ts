// Browser side of the vault.
//
// Two upload paths, chosen by size:
//   · up to ~3.5 MB  → one multipart POST to /api/files (server stores it)
//   · larger         → ask the server to presign, PUT straight to the object
//                      store, then tell the server to record it
//
// The second exists because a Vercel function request body is capped at 4.5 MB,
// and a video or a zip of source files does not fit. When the backend has no
// presigned upload (Vercel Blob), the cap is reported honestly instead of
// failing halfway through an upload.

import type { VaultFile, VaultFolder, VaultUsage } from '@agent-room/shared';
import { formatVaultBytes, vaultVersionLabel } from '@agent-room/shared';
import { roomProof } from './roomApi.js';

export type VaultKind = 'material' | 'deliverable';

/** A listing row as the server returns it. */
export type VaultRow = Omit<VaultFile, 'extractedText'> & {
  url: string | null;
  previewUrl: string | null;
};

export interface VaultListResult {
  files: VaultRow[];
  folders: VaultFolder[];
  usage: VaultUsage;
}

export interface VaultUploadMeta {
  folderId?: string;
  tags?: string[];
  taskId?: string;
  description?: string;
  producer?: string;
}

export class VaultError extends Error {
  constructor(message: string, readonly code: string, readonly status: number) {
    super(message);
    this.name = 'VaultError';
  }
}

const INLINE_LIMIT = 3.5 * 1024 * 1024;

function proof(code: string) {
  const { hostKey, seatKey } = roomProof(code);
  return { hostKey, seatKey };
}

async function request<T>(body: Record<string, unknown>, code: string): Promise<T> {
  const response = await fetch('/api/files', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ...body, roomCode: code, ...proof(code) }),
    cache: 'no-store',
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new VaultError(payload.message ?? `File request failed (${response.status}).`, payload.error ?? 'vault_failed', response.status);
  }
  return payload as T;
}

export function listVault(
  code: string,
  kind: VaultKind,
  filter: { folderId?: string | null; tag?: string; taskId?: string; query?: string; all?: boolean } = {},
): Promise<VaultListResult> {
  return request<VaultListResult>({ op: 'list', kind, ...filter }, code);
}

export function searchVault(code: string, query: string): Promise<{ files: VaultRow[] }> {
  return request<{ files: VaultRow[] }>({ op: 'search', query }, code);
}

export function createVaultFolder(code: string, name: string): Promise<{ folder: VaultFolder }> {
  return request<{ folder: VaultFolder }>({ op: 'createFolder', name }, code);
}

export function deleteVaultFolder(code: string, folderId: string): Promise<{ deleted: boolean; detached: number }> {
  return request<{ deleted: boolean; detached: number }>({ op: 'deleteFolder', folderId }, code);
}

export function updateVaultFile(
  code: string,
  fileId: string,
  patch: { name?: string; folderId?: string | null; tags?: string[]; description?: string; taskId?: string | null; starred?: boolean },
): Promise<{ file: VaultRow | null }> {
  return request<{ file: VaultRow | null }>({ op: 'update', fileId, ...patch }, code);
}

export function deleteVaultFile(code: string, fileId: string): Promise<{ deleted: boolean }> {
  return request<{ deleted: boolean }>({ op: 'delete', fileId }, code);
}

/**
 * Upload one file, splitting on the size the deployment can carry.
 * Returns the stored record so the caller can append it to the list at once.
 */
export async function uploadVaultFile(
  code: string,
  kind: VaultKind,
  file: File,
  meta: VaultUploadMeta = {},
): Promise<VaultRow> {
  if (file.size === 0) throw new VaultError(`${file.name} is empty.`, 'empty_file', 400);
  const { hostKey, seatKey } = proof(code);
  if (file.size <= INLINE_LIMIT) return uploadInline(code, kind, file, meta, seatKey, hostKey);
  return uploadDirect(code, kind, file, meta, seatKey, hostKey);
}

async function uploadInline(
  code: string,
  kind: VaultKind,
  file: File,
  meta: VaultUploadMeta,
  seatKey: string | null | undefined,
  hostKey: string | null | undefined,
): Promise<VaultRow> {
  const form = new FormData();
  form.append('file', file);
  form.append('roomCode', code);
  form.append('kind', kind);
  if (meta.folderId) form.append('folderId', meta.folderId);
  if (meta.tags?.length) form.append('tags', meta.tags.join(','));
  if (meta.taskId) form.append('taskId', meta.taskId);
  if (meta.description) form.append('description', meta.description);
  if (meta.producer) form.append('producer', meta.producer);
  const headers: Record<string, string> = {};
  if (seatKey) headers.Authorization = `Bearer ${seatKey}`;
  if (hostKey) headers['X-Host-Key'] = hostKey;
  const response = await fetch('/api/files', { method: 'POST', headers, body: form });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    const failure = Array.isArray(payload.failures) ? payload.failures[0] : undefined;
    throw new VaultError(failure?.message ?? payload.message ?? `Upload failed (${response.status}).`, failure?.error ?? payload.error ?? 'upload_failed', response.status);
  }
  const saved = Array.isArray(payload.files) ? payload.files[0] : undefined;
  if (!saved) {
    const failure = Array.isArray(payload.failures) ? payload.failures[0] : undefined;
    throw new VaultError(failure?.message ?? 'Upload failed.', failure?.error ?? 'upload_failed', 400);
  }
  return saved as VaultRow;
}

/**
 * Straight-to-storage upload.
 *
 * The object key is minted by the server (it owns the layout) and the record is
 * created only after the server has seen the object, so a browser that dies
 * mid-PUT leaves an unreferenced object, never a listed file with no bytes.
 */
async function uploadDirect(
  code: string,
  kind: VaultKind,
  file: File,
  meta: VaultUploadMeta,
  seatKey: string | null | undefined,
  hostKey: string | null | undefined,
): Promise<VaultRow> {
  const fileId = mintFileId();
  const signed = await request<{
    fileId: string;
    storageKey: string;
    upload: { url: string; method: string; headers: Record<string, string> };
    maxBytes: number;
  }>({ op: 'sign', kind, name: file.name, size: file.size, mime: file.type || 'application/octet-stream', fileId }, code).catch((error: unknown) => {
    if (error instanceof VaultError && error.status === 501) {
      throw new VaultError(
        `${file.name} is ${formatVaultBytes(file.size)}; this deployment can only take files up to 3.5 MB. `
        + 'Use a Vercel Blob or R2 store with presigned uploads to raise the cap.',
        'direct_upload_unavailable',
        501,
      );
    }
    throw error;
  });
  if (file.size > signed.maxBytes) {
    throw new VaultError(`${file.name} exceeds the ${formatVaultBytes(signed.maxBytes)} per-file limit.`, 'file_too_large', 413);
  }
  const put = await fetch(signed.upload.url, { method: 'PUT', headers: signed.upload.headers, body: file });
  if (!put.ok) throw new VaultError(`Upload to storage failed (${put.status}).`, 'storage_failed', put.status);
  const done = await request<{ file: VaultRow }>({
    op: 'complete',
    kind,
    fileId: signed.fileId,
    storageKey: signed.storageKey,
    name: file.name,
    mime: file.type || 'application/octet-stream',
    ...meta,
  }, code);
  void seatKey; void hostKey;
  return done.file;
}

/** Same shape as the server's ids, so `sign` accepts it. */
function mintFileId(): string {
  const bytes = new Uint8Array(8);
  crypto.getRandomValues(bytes);
  return `vf_${Array.from(bytes, byte => byte.toString(16).padStart(2, '0')).join('')}`;
}

/** A new revision of an existing file (deliverables keep their history). */
export async function uploadVaultVersion(
  code: string,
  fileId: string,
  file: File,
  note?: string,
): Promise<VaultRow> {
  const { hostKey, seatKey } = proof(code);
  const form = new FormData();
  form.append('file', file);
  form.append('roomCode', code);
  form.append('versionOf', fileId);
  if (note) form.append('note', note);
  const headers: Record<string, string> = {};
  if (seatKey) headers.Authorization = `Bearer ${seatKey}`;
  if (hostKey) headers['X-Host-Key'] = hostKey;
  const response = await fetch('/api/files', { method: 'POST', headers, body: form });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok || !payload.file) {
    throw new VaultError(payload.message ?? `Upload failed (${response.status}).`, payload.error ?? 'upload_failed', response.status);
  }
  return payload.file as VaultRow;
}

/** A download URL for a version the record's links do not cover (history rows). */
export function mintVaultLink(code: string, fileId: string): Promise<{ url: string | null }> {
  return request<{ url: string | null }>({ op: 'mint', fileId }, code);
}

export function vaultFileLabel(file: Pick<VaultFile, 'version'>): string {
  return vaultVersionLabel(file.version ?? 1);
}

/** Text of a previewable file, fetched through its signed inline URL. */
export async function fetchVaultText(urlFlag: string | null, maxBytes = 400_000): Promise<string> {
  if (!urlFlag) throw new VaultError('This file has no preview link.', 'no_preview', 400);
  const response = await fetch(urlFlag);
  if (!response.ok) throw new VaultError(`Preview failed (${response.status}).`, 'preview_failed', response.status);
  const size = Number(response.headers.get('content-length') ?? 0);
  if (size > maxBytes) {
    const text = await response.text();
    return text.slice(0, maxBytes);
  }
  return response.text();
}
