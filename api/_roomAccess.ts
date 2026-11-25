import { createHash } from 'node:crypto';
import { isValidCode, type Room } from '@agent-room/shared';
import { seatHashMatches, type UpstashClient } from '@agent-room/upstash-client';

export const digest = (value: string): string => createHash('sha256').update(value).digest('hex');

export function findSeat(room: Room, client: 'web' | 'cc', key: unknown) {
  if (typeof key !== 'string' || !/^[a-f0-9]{64}$/.test(key)) return undefined;
  const hash = digest(key);
  return room.participants.find(p => p.client === client && seatHashMatches(p.seatKeyHash, hash));
}

export async function withinRateLimit(store: UpstashClient, key: string, limit: number) {
  const count = await store.command<number>([
    'EVAL',
    // Tagged so the in-memory test Redis can model it without executing Lua.
    "-- rate-limit\nlocal n = redis.call('INCR', KEYS[1]); if n == 1 then redis.call('EXPIRE', KEYS[1], 60) end; return n",
    1, `agent-room:rate:${key}:${Math.floor(Date.now() / 60000)}`,
  ]);
  return Number.isSafeInteger(count) && count > 0 && count <= limit;
}

export interface McpGrant {
  rooms: '*' | string[];
  create?: boolean;
  profile?: 'core' | 'full';
  requestsPerMinute?: number;
}

export function authenticateMcp(header: unknown, config: string | undefined) {
  if (!config) throw new Error('MCP credentials are not configured.');
  const grants: unknown = JSON.parse(config);
  if (!grants || typeof grants !== 'object' || Array.isArray(grants)) throw new Error('Invalid MCP grants.');
  const token = typeof header === 'string' ? /^Bearer ([A-Za-z0-9_-]{32,256})$/i.exec(header)?.[1] : undefined;
  if (!token) return null;
  const id = digest(token);
  if (!Object.prototype.hasOwnProperty.call(grants, id)) return null;
  const grant = (grants as Record<string, McpGrant>)[id];
  if (!grant || (grant.rooms !== '*' && (!Array.isArray(grant.rooms) ||
      grant.rooms.some(code => typeof code !== 'string' || !isValidCode(code)))) ||
      (grant.create !== undefined && (grant.create !== true && grant.create !== false || grant.create && grant.rooms !== '*')) ||
      (grant.profile !== undefined && grant.profile !== 'core' && grant.profile !== 'full') ||
      (grant.requestsPerMinute !== undefined && (!Number.isSafeInteger(grant.requestsPerMinute) ||
        grant.requestsPerMinute < 1 || grant.requestsPerMinute > 600))) {
    throw new Error('Invalid MCP grant.');
  }
  return { id, grant };
}
