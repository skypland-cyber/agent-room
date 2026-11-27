// In-memory Upstash REST stand-in for task-board integration tests.
//
// It interprets the commands upstash-client sends, including the three Lua
// scripts the task board uses — recognised by their leading `-- tag` comment
// and re-implemented here in JavaScript with the same return codes. This is a
// behavioural model of those scripts, not Redis: it does not execute Lua.
import { vi } from 'vitest';

type Value = string | string[] | Set<string>;

export interface FakeRedis {
  store: Map<string, Value>;
  /** Every command the client sent, for cost assertions. */
  log: unknown[][];
  /** Make the next command matching `match` throw once. */
  failOnce(match: (cmd: unknown[]) => boolean): void;
}

function str(store: Map<string, Value>, key: string): string | null {
  const v = store.get(key);
  return typeof v === 'string' ? v : null;
}
function list(store: Map<string, Value>, key: string): string[] {
  const v = store.get(key);
  if (Array.isArray(v)) return v;
  const next: string[] = [];
  store.set(key, next);
  return next;
}

function guardedCas(store: Map<string, Value>, cmd: unknown[]): number {
  const [boardKey, roomKey, mode, expected, next, , roomRaw, leaseGuard, snapshot] =
    [cmd[3], cmd[4], cmd[5], cmd[6], cmd[7], cmd[8], cmd[9], cmd[10], cmd[11]].map(v => (v === undefined ? undefined : String(v)));
  if ((str(store, roomKey!) ?? '') !== roomRaw) return -1;
  const room = JSON.parse(roomRaw!) as { status: string; reactivatedAt?: number; createdAt: number };
  if (snapshot !== 'snapshot' && room.status !== 'active') return -1;
  const now = Date.now();
  if (leaseGuard) {
    const guard = JSON.parse(leaseGuard) as { id: string; attemptId?: string; mode: 'active' | 'recover' };
    const boardRaw = str(store, boardKey!);
    if (boardRaw) {
      for (const task of (JSON.parse(boardRaw).tasks ?? []) as any[]) {
        if (task.id !== guard.id || !task.execution) continue;
        let sameSession = true;
        for (const attempt of task.attempts ?? []) {
          if (attempt.id === task.execution.attemptId && attempt.roomSessionStartedAt !== undefined) {
            sameSession = attempt.roomSessionStartedAt === (room.reactivatedAt ?? room.createdAt);
          }
        }
        const lease = task.lease;
        const active = sameSession && !!lease && lease.status === 'active' && Number(lease.expiresAt) > now;
        if (guard.mode === 'active' && (!active || task.execution.attemptId !== guard.attemptId)) return -2;
        if (guard.mode === 'recover' && active) return -2;
      }
    }
  }
  const cur = str(store, boardKey!);
  if (mode === 'absent' ? cur !== null : cur !== expected) return 0;
  store.set(boardKey!, next!);
  return 1;
}

// Office documents use their own CAS: same contract as the board's, without
// the TTL (the office outlives every meeting).
function officeCas(store: Map<string, Value>, cmd: unknown[]): number {
  const evalKey = String(cmd[3]);
  const mode = String(cmd[4]);
  const cur = str(store, evalKey);
  const ok = mode === 'absent' ? cur === null : cur === String(cmd[5]);
  if (!ok) return 0;
  store.set(evalKey, String(cmd[6]));
  return 1;
}

function taskNotification(store: Map<string, Value>, cmd: unknown[]): number {
  const keys = cmd.slice(3, 7).map(String);
  const argv = cmd.slice(7).map(String);
  const [roomKey, msgsKey, countKey, boardKey] = keys as [string, string, string, string];
  const raw = str(store, boardKey);
  if (!raw) return 0;
  const board = JSON.parse(raw);
  const task = (board.tasks as any[]).find(t => t.id === argv[3]);
  if (!task?.notification) return 0;
  const notice = task.notification;
  if (notice.id !== argv[4] || notice.deliveredAt !== undefined) return 0;
  const waiting = !!task.waiting && task.waiting.resumedAt === undefined;
  if (notice.kind === 'review_requested' && (task.state !== 'awaiting_review' || task.reviewStatus === 'waiting_for_capability' || task.verifier !== notice.target || waiting)) return 0;
  if (notice.kind === 'work_requested' && (task.owner !== notice.target || (task.state !== 'in_progress' && task.state !== 'rejected') || waiting || task.execution?.decisionRequired === true)) return 0;
  if (notice.kind === 'waiting' && !waiting) return 0;
  if (String(board.version) !== argv[5]) return 2;
  const roomRaw = str(store, roomKey);
  if (!roomRaw) return 0;
  const room = JSON.parse(roomRaw);
  if (room.status !== 'active' || String(room.reactivatedAt ?? room.createdAt) !== argv[0]) return 0;
  const msgs = list(store, msgsKey);
  msgs.push(argv[1]!);
  store.set(countKey, String(Number(str(store, countKey) ?? '0') + 1));
  const keep = -Number(argv[2]);
  if (msgs.length > keep) msgs.splice(0, msgs.length - keep);
  store.set(boardKey, argv[6]!);
  return 1;
}

function run(fake: FakeRedis, cmd: unknown[]): unknown {
  const { store } = fake;
  const op = String(cmd[0]).toUpperCase();
  const key = String(cmd[1]);
  switch (op) {
    case 'GET': return str(store, key);
    case 'SET': store.set(key, String(cmd[2])); return 'OK';
    case 'DEL': return cmd.slice(1).reduce<number>((n, k) => n + (store.delete(String(k)) ? 1 : 0), 0);
    case 'RPUSH': { const l = list(store, key); l.push(...cmd.slice(2).map(String)); return l.length; }
    case 'LPUSH': { const l = list(store, key); l.unshift(...cmd.slice(2).map(String)); return l.length; }
    case 'RPOP': {
      const l = Array.isArray(store.get(key)) ? store.get(key) as string[] : [];
      const value = l.pop();
      return value === undefined ? null : value;
    }
    case 'LPOP': {
      const l = Array.isArray(store.get(key)) ? store.get(key) as string[] : [];
      const value = l.shift();
      return value === undefined ? null : value;
    }
    case 'LREM': {
      const l = Array.isArray(store.get(key)) ? store.get(key) as string[] : [];
      const count = Number(cmd[2]);
      const value = String(cmd[3]);
      const limit = count === 0 ? Infinity : Math.abs(count);
      let removed = 0;
      if (count >= 0) {
        for (let i = 0; i < l.length && removed < limit;) {
          if (l[i] === value) { l.splice(i, 1); removed += 1; } else i += 1;
        }
      } else {
        for (let i = l.length - 1; i >= 0 && removed < limit; i -= 1) {
          if (l[i] === value) { l.splice(i, 1); removed += 1; }
        }
      }
      return removed;
    }
    case 'INCR': { const n = Number(str(store, key) ?? '0') + 1; store.set(key, String(n)); return n; }
    case 'LTRIM': {
      const l = Array.isArray(store.get(key)) ? store.get(key) as string[] : [];
      const start = Number(cmd[2]);
      const stop = Number(cmd[3]);
      const from = start < 0 ? Math.max(0, l.length + start) : start;
      const to = stop < 0 ? l.length + stop : stop;
      store.set(key, from > to ? [] : l.slice(from, to + 1));
      return 'OK';
    }
    case 'LLEN': return Array.isArray(store.get(key)) ? (store.get(key) as string[]).length : 0;
    case 'LRANGE': {
      const l = Array.isArray(store.get(key)) ? (store.get(key) as string[]) : [];
      const start = Number(cmd[2]);
      const stop = Number(cmd[3]);
      return l.slice(start < 0 ? Math.max(0, l.length + start) : start, stop < 0 ? l.length + stop + 1 : stop + 1);
    }
    case 'SADD': {
      const s = store.get(key) instanceof Set ? store.get(key) as Set<string> : new Set<string>();
      cmd.slice(2).forEach(v => s.add(String(v)));
      store.set(key, s);
      return 1;
    }
    case 'SREM': { const s = store.get(key); if (s instanceof Set) cmd.slice(2).forEach(v => s.delete(String(v))); return 1; }
    case 'SMEMBERS': { const s = store.get(key); return s instanceof Set ? [...s] : []; }
    case 'EXPIRE': case 'EXPIREAT': case 'PEXPIRE': return 1;
    case 'EVAL': {
      const script = String(cmd[1]);
      if (script.startsWith('-- office-cas')) return officeCas(store, cmd);
      if (script.startsWith('-- rate-limit')) {
        const rateKey = String(cmd[3]);
        const n = Number(str(store, rateKey) ?? '0') + 1;
        store.set(rateKey, String(n));
        return n;
      }
      if (script.startsWith('-- task-board-guarded-cas')) return guardedCas(store, cmd);
      if (script.startsWith('-- task-notification')) return taskNotification(store, cmd);
      // The plain board CAS: EVAL <src> 1 <key> <'absent'|'present'> <expected> <next> <ttl>
      const evalKey = String(cmd[3]);
      const mode = String(cmd[4]);
      const cur = str(store, evalKey);
      const ok = mode === 'absent' ? cur === null : cur === String(cmd[5]);
      if (ok) { store.set(evalKey, String(cmd[6])); return 1; }
      return 0;
    }
    default: return null;
  }
}

/** Install the fake as global fetch; returns its handle. */
export function installFakeRedis(): FakeRedis {
  const pending: Array<(cmd: unknown[]) => boolean> = [];
  const fake: FakeRedis = { store: new Map(), log: [], failOnce: m => { pending.push(m); } };
  const exec = (cmd: unknown[]) => {
    fake.log.push(cmd);
    const i = pending.findIndex(m => m(cmd));
    if (i >= 0) { pending.splice(i, 1); throw new Error('transient disconnect'); }
    return run(fake, cmd);
  };
  vi.stubGlobal('fetch', vi.fn(async (url: string, init: { body: string }) => {
    const body = JSON.parse(init.body);
    // The real REST API answers an empty /pipeline body with HTTP 400, which
    // the client would report as a storage outage. Modelling that here keeps
    // "a list that happens to be empty" from silently passing tests while it
    // fails in production (the 503 on a dashboard with no AI staff yet).
    if (String(url).endsWith('/pipeline') && (body as unknown[][]).length === 0) {
      return new Response(JSON.stringify({ error: 'invalid pipeline: no commands' }), {
        status: 400, headers: { 'Content-Type': 'application/json' },
      });
    }
    try {
      const result = String(url).endsWith('/pipeline')
        ? (body as unknown[][]).map(c => ({ result: exec(c) }))
        : { result: exec(body as unknown[]) };
      return new Response(JSON.stringify(result), { headers: { 'Content-Type': 'application/json' } });
    } catch (e) {
      return new Response(JSON.stringify({ error: (e as Error).message }), { status: 500, headers: { 'Content-Type': 'application/json' } });
    }
  }));
  return fake;
}
