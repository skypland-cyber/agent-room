// Brute-force protection for the one password that opens the office.
//
// The existing limiter answers "more than ten attempts in a minute from this
// address" — which blunts a script but not a patient one: ten guesses a minute
// for an hour is still six hundred tries, and the address is only as stable as
// the proxy header in front of it. Two counters fix that:
//
//   - per address, in a fifteen-minute window: five failures and the address
//     waits out the rest of the window. A human who mistyped twice is never
//     affected; a script spends most of its time locked out.
//   - globally, in the same window: thirty failures in total and sign-in pauses
//     for everybody. The office has one user, so a global brake cannot lock out
//     a second person — and a distributed attempt from a botnet stops being
//     cheaper than a single one.
//
// Both live in Redis with the existing INCR/EXPIRE commands (the free tier's
// command budget does not notice two counters per attempt), and both are keyed
// by a digest of the address so no raw IP is ever stored.
import type { UpstashClient } from '@agent-room/upstash-client';
import { digest } from './_roomAccess.js';

export const LOGIN_WINDOW_SECONDS = 15 * 60;
export const LOGIN_IP_LIMIT = 5;
export const LOGIN_GLOBAL_LIMIT = 30;

const slot = (now: number) => Math.floor(now / (LOGIN_WINDOW_SECONDS * 1000));
const ipKey = (address: string, now: number) => `office:login:fail:${digest(address).slice(0, 24)}:${slot(now)}`;
const globalKey = (now: number) => `office:login:fail:all:${slot(now)}`;

export interface LoginGuardState {
  allowed: boolean;
  /** 'ip' or 'global' when a lock is in force. */
  lockedBy?: 'ip' | 'global';
  /** Seconds until the window ends (the lock's maximum lifetime). */
  retryAfterSeconds: number;
  /** Failures recorded for this address in the current window. */
  failures: number;
  globalFailures: number;
}

async function bump(store: UpstashClient, key: string): Promise<number> {
  const count = Number(await store.command<number>([
    'EVAL',
    // Tagged so the in-memory test Redis can model it without executing Lua.
    // ARGV[1] is the TTL, so one script serves the one-minute limiter and the
    // fifteen-minute lockout window (a 60s TTL under a 15-minute key would
    // reset the lock the moment the script stopped knocking).
    "-- rate-limit\nlocal ttl = tonumber(ARGV[1]) or 60\nlocal n = redis.call('INCR', KEYS[1]); if n == 1 then redis.call('EXPIRE', KEYS[1], ttl) end; return n",
    1,
    key,
    String(LOGIN_WINDOW_SECONDS),
  ]).catch(() => 0));
  return Number.isFinite(count) && count > 0 ? count : 0;
}

/**
 * The current verdict for one address.
 *
 * Reads, does not write: a page load or a wrong password both call this first,
 * and only a failure increments.
 */
export async function loginGuardState(
  store: UpstashClient,
  address: string,
  now: number = Date.now(),
): Promise<LoginGuardState> {
  const retryAfterSeconds = Math.max(
    1,
    Math.ceil(((slot(now) + 1) * LOGIN_WINDOW_SECONDS * 1000 - now) / 1000),
  );
  const rows = await store.pipeline<string | null>([
    ['GET', ipKey(address, now)],
    ['GET', globalKey(now)],
  ]).catch(() => [null, null] as Array<string | null>);
  const failures = Number(rows[0] ?? 0);
  const globalFailures = Number(rows[1] ?? 0);
  const ipLocked = Number.isFinite(failures) && failures >= LOGIN_IP_LIMIT;
  const globalLocked = Number.isFinite(globalFailures) && globalFailures >= LOGIN_GLOBAL_LIMIT;
  return {
    allowed: !ipLocked && !globalLocked,
    ...(globalLocked ? { lockedBy: 'global' as const } : ipLocked ? { lockedBy: 'ip' as const } : {}),
    retryAfterSeconds,
    failures: Number.isFinite(failures) ? failures : 0,
    globalFailures: Number.isFinite(globalFailures) ? globalFailures : 0,
  };
}

/** Count one wrong password. Returns the state after the increment. */
export async function recordLoginFailure(
  store: UpstashClient,
  address: string,
  now: number = Date.now(),
): Promise<LoginGuardState> {
  const failures = await bump(store, ipKey(address, now));
  const globalFailures = await bump(store, globalKey(now));
  const state = await loginGuardState(store, address, now);
  return { ...state, failures: failures || state.failures, globalFailures: globalFailures || state.globalFailures };
}

/** A successful sign-in clears this address's counter (not the global one). */
export async function clearLoginFailures(
  store: UpstashClient,
  address: string,
  now: number = Date.now(),
): Promise<void> {
  await store.command(['DEL', ipKey(address, now)]).catch(() => 0);
}
