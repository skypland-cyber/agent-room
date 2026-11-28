// Storage for the auto-close plan (see roomAutoClose.ts in @agent-room/shared
// for the rule itself).
//
// The plan lives on the room document, so a reader that already has the room
// needs no second read to know the room is scheduled to close. What that alone
// cannot answer is "which rooms are due?", and answering that by walking every
// board room on every dashboard poll is exactly the kind of cost that spends a
// free tier's command budget. So armed rooms are mirrored into one set, and the
// sweep reads that set first: an office with no scheduled room pays one
// SMEMBERS, and a due room is found without touching the rest.
//
// The set is a hint, never the truth. Every entry is re-checked against the room
// document before anything is closed, and an entry whose room is gone or has
// already ended is dropped on sight.
import type { Room, RoomAutoClose } from '@agent-room/shared';
import { ROOM_TTL_SECONDS } from '@agent-room/shared';
import type { UpstashClient } from './client.js';
import { casRoom, getRoom } from './rooms.js';

/** Rooms with a stored plan. Self-expiring, like the board-room index. */
export const AUTO_CLOSE_ROOMS_KEY = 'room:auto-close';

export async function listArmedAutoCloseRooms(client: UpstashClient): Promise<string[]> {
  const members = await client.command<string[] | null>(['SMEMBERS', AUTO_CLOSE_ROOMS_KEY]);
  return Array.isArray(members) ? members : [];
}

export async function indexRoomAutoClose(client: UpstashClient, code: string): Promise<void> {
  await client.pipeline([
    ['SADD', AUTO_CLOSE_ROOMS_KEY, code],
    // Refreshed on every arm: the index can only outlive a room by its own
    // lifetime, and a stale entry costs one GET, not an error.
    ['EXPIRE', AUTO_CLOSE_ROOMS_KEY, ROOM_TTL_SECONDS],
  ]);
}

export async function unindexRoomAutoClose(client: UpstashClient, code: string): Promise<void> {
  await client.command(['SREM', AUTO_CLOSE_ROOMS_KEY, code]);
}

/**
 * Write (or move) the room's plan, and keep the due index in step with it.
 *
 * The room document keeps its 30-day TTL (casRoom writes with KEEPTTL), so
 * scheduling a close never extends a room's life. Indexing here rather than at
 * the call site is deliberate: a plan that is not in the index is a room that
 * never closes, and the two writes belong to one idea — `clearRoomAutoClose`
 * and `closeRoomByAutoClose` each drop the entry for the same reason.
 */
export async function writeRoomAutoClose(
  client: UpstashClient,
  code: string,
  plan: RoomAutoClose,
): Promise<Room> {
  const room = await casRoom(client, code, current => ({ ...current, autoClose: plan }));
  await indexRoomAutoClose(client, code).catch(() => undefined);
  return room;
}

/**
 * Remove the plan. Returns false when the room no longer exists — an expired
 * room needs no cancelling, and the caller should not treat that as an error.
 */
export async function clearRoomAutoClose(client: UpstashClient, code: string): Promise<boolean> {
  try {
    await casRoom(client, code, current => {
      if (!current.autoClose) return current;
      const { autoClose: _dropped, ...rest } = current;
      return rest;
    });
    await unindexRoomAutoClose(client, code).catch(() => undefined);
    return true;
  } catch {
    return false;
  }
}

/**
 * Close the room as the auto-close rule, and mark how it ended.
 *
 * One compare-and-set does both jobs — status, `endedAt`, the `autoClosedAt`
 * marker and dropping the plan that caused it — so a room can never be left
 * "ended with a pending auto-close plan", which the dashboard would draw as a
 * scheduled close that never happens.
 *
 * Returns the room as written; `autoClosedAt === at` says this call is the one
 * that closed it (a room already ended by somebody else comes back untouched).
 */
export async function closeRoomByAutoClose(
  client: UpstashClient,
  code: string,
  at: number,
): Promise<Room> {
  const room = await casRoom(client, code, current => {
    if (current.status !== 'active') return current;
    const { autoClose: _dropped, ...rest } = current;
    return { ...rest, status: 'ended' as const, endedAt: at, autoClosedAt: at };
  });
  await unindexRoomAutoClose(client, code).catch(() => undefined);
  return room;
}

/**
 * Find a room for the auto-close paths.
 *
 * "Gone" and "could not be read" must not look the same here: an expired room
 * should be dropped from the index, while a transient storage failure must
 * leave the entry alone — un-indexing a live room on a network blip would be a
 * room that silently never closes.
 */
export type ArmedRoomLookup =
  | { state: 'found'; room: Room }
  | { state: 'missing' }
  | { state: 'failed' };

export async function lookupArmedRoom(client: UpstashClient, code: string): Promise<ArmedRoomLookup> {
  try {
    return { state: 'found', room: await getRoom(client, code) };
  } catch (error) {
    const name = (error as { name?: string }).name;
    return name === 'RoomNotFoundError' ? { state: 'missing' } : { state: 'failed' };
  }
}
