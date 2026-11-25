// Evidence-gated task board for a room. Lives in its own Redis key
// (`task-board:{code}`) with the same TTL as the room, like turn state, so the
// room JSON stays small and the board can churn independently.
//
// This module is the server-side enforcement of the delivery state machine
// described in @agent-room/shared's Task types. The whole point is that the
// rules below cannot be talked around by an agent — they are checked here, not
// in a prompt:
//   - submitTask REQUIRES the artifact half (fileListing + fileExcerpt) plus
//     proof of checking — a run (runOutput + exitCode) or written checks;
//     missing either half throws EvidenceIncompleteError and the task does not move.
//   - A producer can only reach 'awaiting_review'. There is no code path that
//     lets the owner set 'done'.
//   - verifyTask is the ONLY way to reach 'done' / 'rejected', and it rejects
//     (NotVerifierError) anyone who is not the task's designated verifier — and
//     always rejects the owner verifying their own task (OwnerCannotVerifyError).
import type { ClientKind, Room, SubTask, Task, TaskBoard, TaskEvidence, TaskRoleChange, TaskState, TaskWaitReason } from '@agent-room/shared';
import {
  ROOM_TTL_SECONDS,
  TASK_BLOCK_DEMOTE_THRESHOLD,
  activeTaskLease,
  capabilityGaps,
  currentCapabilities,
  normalizeTaskRequirements,
  participantMemberId,
  recordTaskTimeline,
  taskLeaseTtl,
} from '@agent-room/shared';
import type { UpstashClient } from './client.js';
import { ConcurrencyError, UpstashError } from './errors.js';
import { applyTaskPolicy, type TaskRoster } from './taskPolicy.js';
import {
  assertTaskExecution,
  currentAttempt,
  executionActor,
  finishTaskAttempt,
  reconcileTaskExecution,
  startTaskAttempt,
  TaskExecutionError,
  type TaskExecutionRequest,
} from './taskExecution.js';

export class TaskNotFoundError extends UpstashError {
  constructor(id: string) { super(`Task ${id} not found`); this.name = 'TaskNotFoundError'; }
}
export class TaskExistsError extends UpstashError {
  constructor(id: string) { super(`Task ${id} already exists`); this.name = 'TaskExistsError'; }
}
export class EvidenceIncompleteError extends UpstashError {
  constructor(missing: string) {
    super(
      `Evidence incomplete: ${missing}. A submission needs fileListing and fileExcerpt, `
      + 'plus either runOutput with a numeric exitCode, or checks — each done-when '
      + 'criterion and how you verified it.',
    );
    this.name = 'EvidenceIncompleteError';
  }
}
export class NotVerifierError extends UpstashError {
  constructor(id: string, verifier?: string) {
    super(verifier
      ? `Only the designated verifier (${verifier}) can verify task ${id}.`
      : `Only a non-owner agent can verify task ${id}.`);
    this.name = 'NotVerifierError';
  }
}
export class OwnerCannotVerifyError extends UpstashError {
  constructor(id: string) {
    super(`The producer of task ${id} cannot verify their own delivery — a different agent must rule on the evidence.`);
    this.name = 'OwnerCannotVerifyError';
  }
}
export class VerifierCannotClaimError extends UpstashError {
  constructor(id: string, verifier: string) {
    super(
      `The designated verifier (${verifier}) cannot claim task ${id} — that would make the producer also the only allowed verifier (owner==verifier deadlock).`,
    );
    this.name = 'VerifierCannotClaimError';
  }
}
export class TaskStateError extends UpstashError {
  constructor(message: string) { super(message); this.name = 'TaskStateError'; }
}

/** True when a claim would set owner to the task's designated verifier (T-13 deadlock). */
function claimerIsDesignatedVerifier(
  task: Task,
  claimer: { name: string; client: ClientKind },
): boolean {
  if (!task.verifier) return false;
  const sameName = task.verifier.trim().toLowerCase() === claimer.name.trim().toLowerCase();
  if (!sameName) return false;
  // Client-tolerant (same direction as verifyTask in #318): if verifierClient is
  // unset, a name match alone is enough to block; if set, require client match too.
  if (task.verifierClient === undefined) return true;
  return task.verifierClient === claimer.client;
}

/**
 * Case/whitespace-tolerant agent-name match. Room display names are user-typed, so
 * exact equality would let "qwen" act as if it were "Qwen".
 */
function sameAgentName(a: string | undefined, b: string): boolean {
  return Boolean(a?.trim()) && a!.trim().toLowerCase() === b.trim().toLowerCase();
}

// Now that casWriteTaskBoard is a real CAS that rejects on conflict, the
// important mutations (claim/submit/verify/reassign) must survive a few lost
// races under contention (poll review + cron + multiple agents writing). 3 was
// fine when the write was unconditional; give more headroom now.
const CAS_MAX_ATTEMPTS = 6;

function taskBoardKey(code: string): string {
  return `task-board:${code}`;
}

// Index of rooms that have ever had a task created, so a periodic cron sweep
// can find boards to review without SCANning all of Redis. Rooms are pruned
// from this set by the sweep when their board is gone / all-done / the room
// ended. The set self-expires (refreshed on each register) so an abandoned
// deploy doesn't leak it forever.
const BOARD_ROOMS_KEY = 'task-board:rooms';

async function roomRetentionSeconds(client: UpstashClient, code: string, known?: string | null): Promise<number> {
  const raw = known !== undefined ? known : await client.command<string | null>(['GET', `room:${code}`]);
  if (!raw) return ROOM_TTL_SECONDS;
  try {
    const value = (JSON.parse(raw) as { retentionSeconds?: unknown }).retentionSeconds;
    return typeof value === 'number' && Number.isFinite(value) && value > 0
      ? Math.floor(value)
      : ROOM_TTL_SECONDS;
  } catch {
    return ROOM_TTL_SECONDS;
  }
}

export async function registerBoardRoom(client: UpstashClient, code: string): Promise<void> {
  const ttlSeconds = await roomRetentionSeconds(client, code);
  await client.pipeline([
    ['SADD', BOARD_ROOMS_KEY, code],
    ['EXPIRE', BOARD_ROOMS_KEY, ttlSeconds],
  ]);
}

export async function unregisterBoardRoom(client: UpstashClient, code: string): Promise<void> {
  await client.command(['SREM', BOARD_ROOMS_KEY, code]);
}

export async function listBoardRooms(client: UpstashClient): Promise<string[]> {
  const members = await client.command<string[] | null>(['SMEMBERS', BOARD_ROOMS_KEY]);
  return Array.isArray(members) ? members : [];
}

async function getTaskBoardRaw(client: UpstashClient, code: string): Promise<string | null> {
  const raw = await client.command<string | null>(['GET', taskBoardKey(code)]);
  return raw === null || raw === undefined ? null : raw;
}

export async function getTaskBoard(client: UpstashClient, code: string): Promise<TaskBoard | null> {
  const raw = await getTaskBoardRaw(client, code);
  if (raw === null) return null;
  try {
    return JSON.parse(raw) as TaskBoard;
  } catch {
    return null;
  }
}

// Atomic compare-and-swap write, run server-side in Redis via EVAL: set the
// board to nextRaw ONLY if the stored value is still exactly what we last read
// (expectedRaw), or still absent when expectedRaw is null. Returns true if it
// wrote, false on a conflict. This is the real CAS the previous unconditional
// SET lacked — without it, two concurrent writers (a verify, a board-review
// stamp, a marker apply, the cron) both read vN and both wrote vN+1, so the
// later write clobbered the earlier one (a 'done' would flash then revert), and
// a transient null read made the mutator run on an empty board and blank the
// whole board to 0. The CAS makes both cases retry against fresh state instead.
const CAS_SCRIPT =
  "local cur = redis.call('GET', KEYS[1])\n" +
  "if ARGV[1] == 'absent' then\n" +
  "  if cur then return 0 end\n" +
  "else\n" +
  "  if cur ~= ARGV[2] then return 0 end\n" +
  "end\n" +
  "redis.call('SET', KEYS[1], ARGV[3], 'EX', tonumber(ARGV[4]))\n" +
  "return 1";

// Execution-protected variant (fenced claim/submit/renew/recover/handoff).
// Same CAS, plus two checks inside the same script: the room record is still
// exactly the snapshot the mutator authorised against (a removed or replaced
// seat cannot commit), and the task's execution lease is still in the state
// the caller relied on, using Redis's own clock. -1 = room changed or closed,
// -2 = lease timing changed.
export const GUARDED_CAS_SCRIPT =
  "-- task-board-guarded-cas\n" +
  "if (redis.call('GET', KEYS[2]) or '') ~= ARGV[5] then return -1 end\n" +
  "local room = cjson.decode(ARGV[5])\n" +
  "if ARGV[7] ~= 'snapshot' and room.status ~= 'active' then return -1 end\n" +
  "local clock = redis.call('TIME'); local now = tonumber(clock[1]) * 1000 + math.floor(tonumber(clock[2]) / 1000)\n" +
  "if ARGV[6] and ARGV[6] ~= '' then\n" +
  "  local guard = cjson.decode(ARGV[6]); local boardRaw = redis.call('GET', KEYS[1])\n" +
  "  if boardRaw then for _, task in ipairs(cjson.decode(boardRaw).tasks or {}) do\n" +
  "    if task.id == guard.id and task.execution and task.execution ~= cjson.null then\n" +
  "      local sameSession = true\n" +
  "      for _, attempt in ipairs(task.attempts or {}) do if attempt.id == task.execution.attemptId and attempt.roomSessionStartedAt and attempt.roomSessionStartedAt ~= cjson.null then sameSession = attempt.roomSessionStartedAt == (room.reactivatedAt or room.createdAt) end end\n" +
  "      local lease = task.lease; local active = sameSession and lease and lease ~= cjson.null and lease.status == 'active' and tonumber(lease.expiresAt) > now\n" +
  "      if guard.mode == 'active' and (not active or task.execution.attemptId ~= guard.attemptId) then return -2 end\n" +
  "      if guard.mode == 'recover' and active then return -2 end\n" +
  "    end\n" +
  "  end end\n" +
  "end\n" +
  "local cur = redis.call('GET', KEYS[1])\n" +
  "if ARGV[1] == 'absent' then\n" +
  "  if cur then return 0 end\n" +
  "else\n" +
  "  if cur ~= ARGV[2] then return 0 end\n" +
  "end\n" +
  "redis.call('SET', KEYS[1], ARGV[3], 'EX', tonumber(ARGV[4]))\n" +
  "return 1";

type LeaseGuard = { id: string; attemptId?: string; mode: 'active' | 'recover' };

async function casWriteTaskBoard(
  client: UpstashClient,
  code: string,
  expectedRaw: string | null,
  nextRaw: string,
  roomRaw?: string | null,
  guard?: { roomRaw: string; lease?: LeaseGuard; snapshotOnly?: boolean },
): Promise<boolean> {
  const ttlSeconds = await roomRetentionSeconds(client, code, roomRaw);
  if (guard) {
    const res = Number(await client.command<number>([
      'EVAL', GUARDED_CAS_SCRIPT, '2', taskBoardKey(code), `room:${code}`,
      expectedRaw === null ? 'absent' : 'present',
      expectedRaw ?? '',
      nextRaw,
      String(ttlSeconds),
      guard.roomRaw,
      guard.lease ? JSON.stringify(guard.lease) : '',
      guard.snapshotOnly ? 'snapshot' : '',
    ]));
    if (res === -2) throw new TaskExecutionError('lease_not_active', 'Execution lease timing changed before commit. Read the current task and recover or renew explicitly.');
    // -1: the room changed under us; the caller retries against a fresh snapshot.
    return res === 1;
  }
  const res = await client.command<number>([
    'EVAL', CAS_SCRIPT, '1', taskBoardKey(code),
    expectedRaw === null ? 'absent' : 'present',
    expectedRaw ?? '',
    nextRaw,
    String(ttlSeconds),
  ]);
  return Number(res) === 1;
}

function parseRoster(raw: string | null | undefined): TaskRoster | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as Room;
    return Array.isArray(parsed.participants) ? parsed : null;
  } catch {
    return null;
  }
}

const sleep = (ms: number): Promise<void> => new Promise(r => setTimeout(r, ms));

// CAS wrapper. The mutator returns the next board; it may throw to abort (e.g. a
// validation error), which propagates out. On a write conflict we re-read the
// fresh board and re-run the mutator, so a concurrent change is never clobbered.
//
// Every write also runs applyTaskPolicy (review assignment, waits, execution
// reconciliation, notification intent) and records the task timeline, against
// the room roster re-read on each attempt so a revoked seat is never used.
// `guardRoom` makes the write fail unless the room is unchanged and active;
// 'snapshot' only requires it unchanged (closed-room reconciliation).
async function casTaskBoard(
  client: UpstashClient,
  code: string,
  mutator: (current: TaskBoard, room: TaskRoster | null) => TaskBoard | Promise<TaskBoard>,
  guardRoom: boolean | 'snapshot' = false,
  leaseGuard?: LeaseGuard,
): Promise<TaskBoard> {
  let lastError: unknown;
  for (let attempt = 0; attempt < CAS_MAX_ATTEMPTS; attempt++) {
    const roomRaw = await client.command<string | null>(['GET', `room:${code}`]);
    const room = parseRoster(roomRaw);
    if (guardRoom && (!roomRaw || (guardRoom === true && room?.status !== 'active'))) {
      throw new TaskExecutionError('room_closed', 'An active room is required for task execution.');
    }
    const raw = await getTaskBoardRaw(client, code);
    let current: TaskBoard;
    if (raw === null) {
      current = { code, tasks: [], version: 0 };
    } else {
      try { current = JSON.parse(raw) as TaskBoard; }
      catch { current = { code, tasks: [], version: 0 }; } // corrupt → reset; CAS still guards
    }
    let next: TaskBoard;
    try {
      next = await mutator(current, room);
    } catch (e) {
      if (e instanceof ConcurrencyError) { lastError = e; continue; }
      throw e;
    }
    for (const task of next.tasks) {
      const old = current.tasks.find(t => t.id === task.id);
      const rolesChanged = !old || task.owner !== old.owner || task.verifier !== old.verifier
        || task.ownerClient !== old.ownerClient || task.verifierClient !== old.verifierClient;
      if (!rolesChanged) continue;
      for (const value of [task.owner, task.verifier]) {
        if (value !== undefined && !value.trim()) throw new TaskStateError('Task role names cannot be empty.');
      }
      if (task.owner && task.verifier && task.owner.trim().toLowerCase() === task.verifier.trim().toLowerCase()) {
        throw new TaskStateError('Task owner and verifier must be different participants — a producer cannot verify their own delivery.');
      }
      if (room) {
        // Canonicalise to the seated spelling and client kind, so later
        // name/client gates compare against the real roster entry.
        const seat = (name?: string) => room.participants.find(p => !!name && p.name.trim().toLowerCase() === name.trim().toLowerCase());
        const owner = seat(task.owner);
        const verifier = seat(task.verifier);
        // A role named after somebody who is not in the room can never act on
        // it. Only a newly set name is checked: a holder who has since left
        // stays on record, and review policy reassigns their reviews.
        for (const [role, name, found, before] of [['owner', task.owner, owner, old?.owner], ['verifier', task.verifier, verifier, old?.verifier]] as const) {
          if (name && !found && name !== before) {
            const here = room.participants.map(p => p.name).join(', ') || '(nobody)';
            throw new TaskStateError(`The ${role} ${name} is not in this room. Pick one of: ${here}.`);
          }
        }
        const canonical = { ...task, ...(owner ? { owner: owner.name, ownerClient: owner.client } : {}),
          ...(verifier ? { verifier: verifier.name, verifierClient: verifier.client } : {}) };
        next = { ...next, tasks: next.tasks.map(t => t.id === task.id ? canonical : t) };
      }
    }
    const touchedAt = next.tasks.reduce((latest, t) => {
      const old = current.tasks.find(x => x.id === t.id);
      return old !== t ? Math.max(latest, t.updatedAt) : latest;
    }, 0) || Date.now();
    next = applyTaskPolicy(next, current, room, touchedAt);
    if (next === current) return current;
    const recordedAt = Date.now();
    next = { ...next, version: current.version + 1, tasks: next.tasks.map(task =>
      recordTaskTimeline(current.tasks.find(old => old.id === task.id), task, current.version + 1, recordedAt)) };
    const guard = guardRoom ? { roomRaw: roomRaw!, lease: leaseGuard, snapshotOnly: guardRoom === 'snapshot' } : undefined;
    if (await casWriteTaskBoard(client, code, raw, JSON.stringify(next), roomRaw, guard)) {
      return next;
    }
    // Lost the race — another writer changed the board between our read and
    // write. Back off briefly and retry against the fresh state.
    lastError = new ConcurrencyError();
    await sleep(20 + Math.floor(Math.random() * 50));
  }
  throw lastError instanceof ConcurrencyError ? lastError : new ConcurrencyError();
}

/**
 * Repair historical unassigned reviews, offline reviewers and ended
 * executions. A stable board costs one board read and one room read, no write.
 */
export async function reconcileTaskReviews(client: UpstashClient, code: string): Promise<TaskBoard | null> {
  const board = await getTaskBoard(client, code);
  if (!board) return null;
  const roster = parseRoster(await client.command<string | null>(['GET', `room:${code}`]));
  if (applyTaskPolicy(board, board, roster, Date.now()) === board) return board;
  if (roster && board.tasks.some(task => task.execution)) return casTaskBoard(client, code, current => current, 'snapshot');
  return casTaskBoard(client, code, current => current);
}

function findTask(board: TaskBoard, id: string): Task {
  const t = board.tasks.find(x => x.id === id);
  if (!t) throw new TaskNotFoundError(id);
  return t;
}

function replaceTask(board: TaskBoard, next: Task): TaskBoard {
  return { ...board, tasks: board.tasks.map(t => (t.id === next.id ? next : t)) };
}

export interface CreateTaskInput {
  id?: string;            // optional; auto-assigned T-NN when omitted
  title: string;
  /** Important work: starts in pending_approval and only the boss may release it. */
  requiresApproval?: boolean;
  /** Automatic retry ceiling for this task (falls back to the office setting). */
  maxRetries?: number;
  /** Office project / template this board belongs to (stamped once, at creation). */
  projectId?: string;
  templateId?: string;
  owner?: string;
  ownerClient?: ClientKind;
  verifier?: string;
  verifierClient?: ClientKind;
  dod?: string;
  requirements?: Task['requirements'];
  createdBy: string;
}

function nextTaskId(board: TaskBoard): string {
  let max = 0;
  for (const t of board.tasks) {
    const m = /^T-(\d+)$/.exec(t.id);
    if (m) max = Math.max(max, Number(m[1]));
  }
  return `T-${String(max + 1).padStart(2, '0')}`;
}

export async function createTask(
  client: UpstashClient,
  code: string,
  input: CreateTaskInput,
  now: number = Date.now(),
): Promise<{ board: TaskBoard; task: Task }> {
  let requirements: Task['requirements'];
  try { requirements = normalizeTaskRequirements(input.requirements); } catch (error) { throw new TaskStateError((error as Error).message); }
  // Validate before touching Redis so a bad creation fails fast. A task whose
  // designated verifier IS the owner would be self-verifiable, defeating the
  // whole evidence gate — verifyTask would then let the producer rule on their
  // own delivery. Compare case-insensitively so "gpt" vs "GPT" can't slip by.
  const ownerName = input.owner?.trim().toLowerCase();
  const verifierName = input.verifier?.trim().toLowerCase();
  if (ownerName && verifierName && ownerName === verifierName) {
    throw new TaskStateError(
      `Task verifier (${input.verifier}) must be different from the owner (${input.owner}) — a producer cannot verify their own delivery.`,
    );
  }
  let created: Task;
  const board = await casTaskBoard(client, code, (current) => {
    const id = input.id?.trim() || nextTaskId(current);
    if (current.tasks.some(t => t.id === id)) throw new TaskExistsError(id);
    created = {
      id,
      title: input.title,
      owner: input.owner,
      ownerClient: input.ownerClient,
      verifier: input.verifier,
      verifierClient: input.verifierClient,
      dod: input.dod,
      ...(requirements ? { requirements } : {}),
      // Approval gate: an important task is born blocked. Creating it must not
      // be a way around the boss's sign-off, so the state itself is the gate —
      // not a flag a caller could forget to check.
      ...(input.requiresApproval
        ? { state: 'pending_approval' as const,
          approval: { required: true as const, status: 'pending' as const, requestedBy: input.createdBy, requestedAt: now } }
        : { state: 'todo' as const }),
      ...(typeof input.maxRetries === 'number' ? { maxRetries: input.maxRetries } : {}),
      createdBy: input.createdBy,
      createdAt: now,
      updatedAt: now,
    };
    return {
      ...current,
      tasks: [...current.tasks, created],
      lastProgressAt: now,
      ...(input.projectId && !current.projectId ? { projectId: input.projectId } : {}),
      ...(input.templateId && !current.templateId ? { templateId: input.templateId } : {}),
    };
  });
  // Index this room for the periodic board-review sweep (best-effort).
  await registerBoardRoom(client, code).catch(() => { /* best-effort */ });
  return { board, task: findTask(board, created!.id) };
}

// A producer claims a task → 'in_progress'. Records ownership if not already set.
// Rejects when the claimer is the designated verifier — otherwise owner==verifier
// and the task can never be verified (T-13 deadlock). Mirrors createTask's guard.
// Terminal states (done / rejected) require an explicit host reopen before claim.
//
// T-03: these guards used to live only in the hosted path (evaluateClaimGuard),
// so the MCP/API taskClaim route — which calls this directly — could steal a
// task another agent was actively working on, or yank a submission back out of
// review before its verifier ruled. The state machine belongs here, at the one
// place every caller goes through.
export async function claimTask(
  client: UpstashClient,
  code: string,
  id: string,
  owner: { name: string; client: ClientKind },
  now: number = Date.now(),
  execution?: TaskExecutionRequest,
): Promise<{ board: TaskBoard; task: Task }> {
  let updated: Task;
  const board = await casTaskBoard(client, code, async (current, room) => {
    const task = findTask(current, id);
    if (task.lease && !task.execution) throw new TaskExecutionError('legacy_lease', 'This task carries a fleet lease; do not overwrite it through the name-only claim path.');
    if (task.state === 'done' || task.state === 'rejected' || task.state === 'cancelled') {
      throw new TaskStateError(
        `Task ${id} is ${task.state}; reopen it (host Set state) before claiming.`,
      );
    }
    if (task.state === 'awaiting_review') {
      throw new TaskStateError(
        `Task ${id} is awaiting_review — its verifier must rule before it can be claimed again.`,
      );
    }
    // A `todo` owned by someone else stays claimable on purpose (nominal
    // ownership of unstarted work must not deadlock the board — see the note on
    // evaluateClaimGuard). `in_progress` is different: somebody is actually
    // working on it, and silently reassigning it loses their work.
    if (task.state === 'in_progress' && task.owner && !sameAgentName(task.owner, owner.name)) {
      throw new TaskStateError(
        `Task ${id} is in_progress under ${task.owner} — ask the host to reassign it instead of claiming it.`,
      );
    }
    if (task.state === 'blocked') throw new TaskStateError(`Task ${id} is waiting; use room_task resume with a resolution before claiming it.`);
    if (task.state === 'pending_approval') {
      throw new TaskStateError(`Task ${id} is waiting for the boss's approval; it cannot be claimed until the office releases it.`);
    }
    if (task.state === 'paused') throw new TaskStateError(`Task ${id} is paused; the office resumes it before anyone claims it.`);
    if (task.state === 'aborted') throw new TaskStateError(`Task ${id} was aborted by the boss; create a new task instead of reviving it.`);
    if (claimerIsDesignatedVerifier(task, owner)) {
      throw new VerifierCannotClaimError(id, task.verifier!);
    }
    if (execution || task.execution || task.requirements?.owner) {
      const actor = await executionActor(room, owner, execution);
      if (task.execution) {
        if (activeTaskLease(task.lease, now) && task.lease?.holderId === actor.memberId) return current;
        throw new TaskExecutionError('recovery_required', 'Read task attempts and use recover with a resolution; claiming must not silently restart managed work.');
      }
      updated = startTaskAttempt(task, actor, now, execution?.ttlMs);
      return { ...replaceTask(current, updated), lastProgressAt: now };
    }
    updated = {
      ...task,
      owner: owner.name,
      ownerClient: owner.client,
      state: 'in_progress',
      updatedAt: now,
    };
    return { ...replaceTask(current, updated), lastProgressAt: now };
  }, !!execution);
  return { board, task: findTask(board, id) };
}

/**
 * Explicit execution operations on a fenced task: renew the lease, recover a
 * new attempt after expiry or interruption, release it, or hand it to another
 * seated agent. Every one needs the seatKey; renew/release/handoff also the
 * current attemptId.
 */
export async function operateTaskExecution(client: UpstashClient, code: string, id: string,
  actorInput: { name: string; client: ClientKind }, action: 'renew' | 'recover' | 'release' | 'handoff',
  request: TaskExecutionRequest, options: { resolution?: string; to?: string } = {}, now = Date.now(),
): Promise<{ board: TaskBoard; task: Task }> {
  const board = await casTaskBoard(client, code, async (current, room) => {
    let task = findTask(current, id);
    const actor = await executionActor(room, actorInput, request);
    task = reconcileTaskExecution(task, task, now, actor.roomSessionStartedAt);
    if (task.execution?.decisionRequired) throw new TaskExecutionError('decision_required', 'This task needs an explicit reopen/cancel decision before execution can restart.');
    if (!task.execution || !['in_progress', 'rejected'].includes(task.state)) throw new TaskExecutionError('not_running', 'This task has no recoverable execution; claim new work or resolve the recorded wait first.');
    if (action === 'recover') {
      if (activeTaskLease(task.lease, now)) {
        if (task.lease!.holderId === actor.memberId) {
          await assertTaskExecution(task, room, actorInput, { ...request, attemptId: task.execution.attemptId }, now);
          return current;
        }
        throw new TaskExecutionError('lease_held', 'Another verified seat still holds this task. Ask for handoff or wait for expiry.');
      }
      if (!options.resolution?.trim()) throw new TaskExecutionError('resolution_required', 'Read the task evidence/history and explain what work you will recover.');
      if (task.owner !== actor.name && currentAttempt(task)?.endReason === 'assignment_or_scope_changed') {
        // An explicit reassignment names the intended next owner; expiry alone
        // leaves the task available for a verified replacement to recover.
        throw new TaskExecutionError('owner_required', 'This task was assigned for recovery by its named owner. Reassign it before a different owner takes over.');
      }
      task = finishTaskAttempt(task, 'interrupted', 'lease_expired', now);
      const next = startTaskAttempt(task, actor, now, request.ttlMs);
      const attempt = next.attempts![next.attempts!.length - 1]!;
      next.attempts = next.attempts!.map(a => a.id === attempt.id ? { ...a, endReason: undefined, recoveryNote: options.resolution!.trim() } : a);
      if (task.owner !== actor.name) next.roleHistory = [...(task.roleHistory ?? []), { by: actor.name, byClient: actor.client, at: now, field: 'owner', from: task.owner, to: actor.name }];
      return { ...replaceTask(current, next), lastProgressAt: now };
    }
    await assertTaskExecution(task, room, actorInput, request, now, action === 'release' || action === 'handoff');
    if (action === 'release') return replaceTask(current, finishTaskAttempt(task, 'released', 'holder_released', now));
    if (action === 'renew') {
      let ttl: number;
      try { ttl = taskLeaseTtl(request.ttlMs); } catch { throw new TaskExecutionError('ttl_invalid', 'Invalid task lease TTL.'); }
      return replaceTask(current, { ...task, lease: { ...task.lease!, expiresAt: now + ttl, renewedAt: now },
        attempts: task.attempts!.map(a => a.id === task.execution!.attemptId ? { ...a, confirmedAt: now } : a) });
    }
    const recipient = room?.participants.find(p => p.name === options.to && p.client === 'cc' && p.canSpeak !== false);
    const memberId = recipient && participantMemberId(recipient);
    if (!recipient || !memberId || memberId === actor.memberId) throw new TaskExecutionError('handoff_target_invalid', 'Choose a different joined agent with a stable seat.');
    task = finishTaskAttempt(task, 'interrupted', 'handed_off', now);
    const next = startTaskAttempt(task, { name: recipient.name, client: recipient.client, memberId, participant: recipient, roomSessionStartedAt: actor.roomSessionStartedAt }, now, request.ttlMs);
    next.roleHistory = [...(task.roleHistory ?? []), { by: actor.name, byClient: actor.client, at: now, field: 'owner', from: task.owner, to: recipient.name }];
    return { ...replaceTask(current, next), lastProgressAt: now };
  }, true, { id, attemptId: request.attemptId, mode: action === 'recover' ? 'recover' : 'active' });
  return { board, task: findTask(board, id) };
}

// Moderator-mode reassignment: hand a blocked agent's task to a different agent.
// The task is reset to 'todo' (fresh work for the new owner) with any stale
// evidence/verdict cleared, and the OLD owner's reliability `blocks` tally is
// incremented; crossing TASK_BLOCK_DEMOTE_THRESHOLD marks them low-capability
// (demotedAt). `demoted` in the result is true only on the turn it first
// crosses, so the caller can announce it once.
export async function reassignTask(
  client: UpstashClient,
  code: string,
  id: string,
  newOwner: { name: string; client: ClientKind },
  now: number = Date.now(),
): Promise<{ board: TaskBoard; task: Task; fromOwner?: string; demoted: boolean; blocks: number }> {
  let updated: Task;
  let fromOwner: string | undefined;
  let demoted = false;
  let blocks = 0;
  const board = await casTaskBoard(client, code, (current) => {
    const task = findTask(current, id);
    if (task.state === 'done') {
      throw new TaskStateError(`Task ${id} is already done; reopen it before reassigning.`);
    }
    fromOwner = task.owner;
    updated = {
      ...task,
      owner: newOwner.name,
      ownerClient: newOwner.client,
      state: 'todo',
      evidence: undefined,
      verdict: undefined,
      readinessNote: undefined,
      updatedAt: now,
    };
    let next: TaskBoard = { ...replaceTask(current, updated), lastProgressAt: now };
    // Only tally a block when we actually moved it off a *different* owner.
    if (fromOwner && fromOwner !== newOwner.name) {
      const rel = { ...(next.reliability ?? {}) };
      const prev = rel[fromOwner] ?? { blocks: 0 };
      blocks = prev.blocks + 1;
      const justCrossed = prev.demotedAt === undefined && blocks >= TASK_BLOCK_DEMOTE_THRESHOLD;
      demoted = justCrossed;
      rel[fromOwner] = { blocks, demotedAt: prev.demotedAt ?? (justCrossed ? now : undefined) };
      next = { ...next, reliability: rel };
    }
    return next;
  });
  return { board, task: findTask(board, updated!.id), fromOwner, demoted, blocks };
}

export interface ReassignTaskRolesPatch {
  owner?: string;
  ownerClient?: ClientKind;
  verifier?: string;
  verifierClient?: ClientKind;
}

// Role reassignment (host / moderator escape hatch): change a task's owner
// and/or verifier WITHOUT touching its state — the in-system path for handing
// work off an agent whose client is tool-blocked. Unlike reassignTask above
// it does not reset the task to 'todo', clear evidence, or tally reliability
// blocks; it only swaps who is responsible, and appends each change to the
// task's roleHistory so the escape hatch stays auditable (who, when, from → to).
//
// AUTHORIZATION IS THE CALLER'S JOB (api/room.ts gates this on the proven
// host or any joined room participant) — this function only enforces the
// state machine:
//   - terminal states ('done', 'rejected') are locked;
//   - the RESULTING owner and verifier always differ, including solo rooms: a
//     solo submission waits for a reviewer instead of reviewing itself.
export async function reassignTaskRoles(
  client: UpstashClient,
  code: string,
  id: string,
  patch: ReassignTaskRolesPatch,
  actor: { name: string; client: ClientKind },
  now: number = Date.now(),
  /** @deprecated Solo rooms no longer allow self-review; ignored. */
  _eligibleAgentCount?: number,
): Promise<{ board: TaskBoard; task: Task }> {
  const newOwner = patch.owner?.trim();
  const newVerifier = patch.verifier?.trim();
  if (patch.owner !== undefined && !newOwner) throw new TaskStateError('New owner name cannot be empty.');
  if (patch.verifier !== undefined && !newVerifier) throw new TaskStateError('New verifier name cannot be empty.');
  if (newOwner === undefined && newVerifier === undefined) {
    throw new TaskStateError('Reassigning task roles requires a new owner and/or verifier.');
  }
  let updated: Task;
  const board = await casTaskBoard(client, code, (current) => {
    const task = findTask(current, id);
    if (task.state === 'done') throw new TaskDoneImmutableError(id);
    if (task.state === 'rejected' || task.state === 'cancelled') {
      throw new TaskStateError(`Task ${id} is ${task.state} — reopen it before reassigning roles.`);
    }
    // Validate the RESULT of applying the patch — a new owner colliding with
    // the existing verifier (or vice versa) must not create self-review.
    const resultingOwner = newOwner ?? task.owner;
    const resultingVerifier = newVerifier ?? task.verifier;
    if (resultingOwner && resultingVerifier
      && resultingOwner.trim().toLowerCase() === resultingVerifier.trim().toLowerCase()) {
      throw new TaskStateError(
        `Task verifier (${resultingVerifier}) must be different from the owner (${resultingOwner}) — a producer cannot verify their own delivery.`,
      );
    }
    const audit: TaskRoleChange[] = [];
    if (newOwner !== undefined && newOwner !== task.owner) {
      audit.push({ by: actor.name, byClient: actor.client, at: now, field: 'owner', from: task.owner, to: newOwner });
    }
    if (newVerifier !== undefined && newVerifier !== task.verifier) {
      audit.push({ by: actor.name, byClient: actor.client, at: now, field: 'verifier', from: task.verifier, to: newVerifier });
    }
    updated = {
      ...task,
      ...(newOwner !== undefined ? { owner: newOwner, ownerClient: patch.ownerClient } : {}),
      ...(newVerifier !== undefined ? { verifier: newVerifier, verifierClient: patch.verifierClient } : {}),
      ...(audit.length ? { roleHistory: [...(task.roleHistory ?? []), ...audit] } : {}),
      ...(newVerifier !== undefined && newVerifier !== task.verifier && task.state === 'awaiting_review' ? { reviewRequestedAt: now } : {}),
      updatedAt: now,
    };
    return { ...replaceTask(current, updated), lastProgressAt: now };
  });
  return { board, task: findTask(board, id) };
}

/** True when a task has submitted work that must be preserved until reopen. */
function taskHasSubmittedEvidence(task: Task): boolean {
  return !!(task.evidence || task.readinessNote?.trim());
}

// Participant archive: move a task to terminal 'cancelled' (visible history,
// not open work). Safe only for tasks without submitted evidence — todo and
// in_progress duplicates can be archived; done and evidence-backed tasks stay
// locked. Authorization is the caller's job (any joined participant / host).
export async function cancelTask(
  client: UpstashClient,
  code: string,
  id: string,
  actor: { name: string; client: ClientKind },
  reason?: string,
  now: number = Date.now(),
): Promise<{ board: TaskBoard; task: Task }> {
  let updated: Task;
  const board = await casTaskBoard(client, code, (current) => {
    const task = findTask(current, id);
    if (task.state === 'done') throw new TaskDoneImmutableError(id);
    if (task.state === 'cancelled') {
      throw new TaskStateError(`Task ${id} is already cancelled.`);
    }
    if (taskHasSubmittedEvidence(task)) {
      throw new TaskStateError(
        `Task ${id} has submitted evidence — reopen it to todo/in_progress before cancelling.`,
      );
    }
    const cleanReason = reason?.trim();
    updated = {
      ...task,
      state: 'cancelled',
      cancellation: {
        by: actor.name,
        byClient: actor.client,
        at: now,
        ...(cleanReason ? { reason: cleanReason } : {}),
      },
      updatedAt: now,
    };
    return { ...replaceTask(current, updated), lastProgressAt: now };
  });
  return { board, task: findTask(board, updated!.id) };
}

// ─── Office controls: approval, pause, abort, QA and retries ──────────────
//
// These live on the same board as everything else, behind the same CAS, so a
// boss's pause and an agent's submit cannot both win. They are additive: a
// board written before these states existed keeps working, because every new
// field is optional and 'todo'/'in_progress' behave exactly as before.

const OPEN_FOR_PAUSE: ReadonlySet<TaskState> = new Set<TaskState>(['todo', 'pending_approval', 'in_progress', 'blocked', 'rejected']);

/** Suspend a task without losing anything. Reversible; the reason is kept. */
export async function pauseTask(
  client: UpstashClient,
  code: string,
  id: string,
  actor: { name: string; client: ClientKind },
  reason?: string,
  now: number = Date.now(),
): Promise<{ board: TaskBoard; task: Task }> {
  let updated: Task;
  const board = await casTaskBoard(client, code, (current) => {
    const task = findTask(current, id);
    if (task.state === 'paused') return current;
    if (task.state === 'done' || task.state === 'cancelled' || task.state === 'aborted') {
      throw new TaskStateError(`Task ${id} is ${task.state} — a closed task cannot be paused.`);
    }
    if (!OPEN_FOR_PAUSE.has(task.state)) {
      throw new TaskStateError(`Task ${id} is ${task.state}; finish or reject the review before pausing it.`);
    }
    const clean = reason?.trim().slice(0, 500);
    const paused = finishTaskAttempt(task, 'waiting', 'task_paused', now);
    updated = {
      ...paused,
      state: 'paused',
      pause: {
        by: actor.name, byClient: actor.client, at: now,
        resumeState: task.state,
        ...(clean ? { reason: clean } : {}),
      },
      updatedAt: now,
    };
    return { ...replaceTask(current, updated), lastProgressAt: now };
  });
  return { board, task: findTask(board, id) };
}

/** Put a paused task back where it was. */
export async function unpauseTask(
  client: UpstashClient,
  code: string,
  id: string,
  actor: { name: string; client: ClientKind },
  now: number = Date.now(),
): Promise<{ board: TaskBoard; task: Task }> {
  let updated: Task;
  const board = await casTaskBoard(client, code, (current) => {
    const task = findTask(current, id);
    if (task.state !== 'paused') throw new TaskStateError(`Task ${id} is ${task.state}, not paused.`);
    const back: TaskState = task.pause?.resumeState && task.pause.resumeState !== 'paused'
      ? task.pause.resumeState : 'todo';
    updated = {
      ...task,
      state: back,
      pause: task.pause
        ? { ...task.pause, resumedAt: now, resumedBy: actor.name, resumedClient: actor.client }
        : task.pause,
      updatedAt: now,
    };
    return { ...replaceTask(current, updated), lastProgressAt: now };
  });
  return { board, task: findTask(board, id) };
}

/** Stop a task for good. Terminal: the reason stays on the archived task. */
export async function abortTask(
  client: UpstashClient,
  code: string,
  id: string,
  actor: { name: string; client: ClientKind },
  reason?: string,
  now: number = Date.now(),
): Promise<{ board: TaskBoard; task: Task }> {
  let updated: Task;
  const board = await casTaskBoard(client, code, (current) => {
    const task = findTask(current, id);
    if (task.state === 'done') throw new TaskDoneImmutableError(id);
    if (task.state === 'aborted') return current;
    const clean = reason?.trim().slice(0, 500);
    const stopped = finishTaskAttempt(task, 'cancelled', 'task_aborted', now);
    updated = {
      ...stopped,
      state: 'aborted',
      abort: { by: actor.name, byClient: actor.client, at: now, ...(clean ? { reason: clean } : {}) },
      updatedAt: now,
    };
    return { ...replaceTask(current, updated), lastProgressAt: now };
  });
  return { board, task: findTask(board, id) };
}

/** Put an existing task behind the boss's gate (from todo only). */
export async function requireTaskApproval(
  client: UpstashClient,
  code: string,
  id: string,
  actor: { name: string; client: ClientKind },
  note?: string,
  now: number = Date.now(),
): Promise<{ board: TaskBoard; task: Task }> {
  let updated: Task;
  const board = await casTaskBoard(client, code, (current) => {
    const task = findTask(current, id);
    if (task.state === 'pending_approval') return current;
    if (task.state !== 'todo') {
      throw new TaskStateError(`Task ${id} is ${task.state}; only an unstarted task can be sent for approval.`);
    }
    const clean = note?.trim().slice(0, 500);
    updated = {
      ...task,
      state: 'pending_approval',
      approval: {
        required: true, status: 'pending', requestedBy: actor.name, requestedAt: now,
        ...(clean ? { note: clean } : {}),
      },
      updatedAt: now,
    };
    return { ...replaceTask(current, updated), lastProgressAt: now };
  });
  return { board, task: findTask(board, id) };
}

/**
 * The boss's ruling on an important task. Approving releases it to the board as
 * 'todo'; rejecting archives it with the note, because "not approved" means the
 * work should not be done — not that the producer failed to do it.
 */
export async function decideTaskApproval(
  client: UpstashClient,
  code: string,
  id: string,
  decision: 'approved' | 'rejected',
  actor: { name: string; client: ClientKind },
  note?: string,
  now: number = Date.now(),
): Promise<{ board: TaskBoard; task: Task }> {
  let updated: Task;
  const board = await casTaskBoard(client, code, (current) => {
    const task = findTask(current, id);
    if (task.state !== 'pending_approval' || task.approval?.status !== 'pending') {
      throw new TaskStateError(`Task ${id} is not waiting for approval (${task.state}).`);
    }
    const clean = note?.trim().slice(0, 1000);
    const approval = {
      ...task.approval,
      status: decision,
      decidedBy: actor.name,
      decidedAt: now,
      ...(clean ? { note: clean } : {}),
    };
    updated = decision === 'approved'
      ? { ...task, state: 'todo', approval, updatedAt: now }
      : {
        ...task,
        state: 'cancelled',
        approval,
        cancellation: {
          by: actor.name, byClient: actor.client, at: now,
          reason: `Approval rejected${clean ? `: ${clean}` : ''}`,
        },
        updatedAt: now,
      };
    return { ...replaceTask(current, updated), lastProgressAt: now };
  });
  return { board, task: findTask(board, id) };
}

/**
 * Peer quality check. Deliberately a separate record from the completion
 * verdict: the verifier answers "does this meet the definition of done", QA
 * answers "is this good", and a producer can never QA its own work.
 */
export async function recordTaskQa(
  client: UpstashClient,
  code: string,
  id: string,
  reviewer: { name: string; client: ClientKind },
  status: 'pending' | 'passed' | 'failed',
  notes?: string,
  now: number = Date.now(),
): Promise<{ board: TaskBoard; task: Task }> {
  let updated: Task;
  const board = await casTaskBoard(client, code, (current) => {
    const task = findTask(current, id);
    if (task.owner && sameAgentName(task.owner, reviewer.name)) {
      throw new TaskStateError('The producer cannot run QA on their own delivery — a different agent must check it.');
    }
    if (task.state !== 'awaiting_review' && task.state !== 'done') {
      throw new TaskStateError(`Task ${id} is ${task.state}; QA runs on submitted or completed work.`);
    }
    const clean = notes?.trim().slice(0, 2000);
    updated = {
      ...task,
      qa: { reviewer: reviewer.name, reviewerClient: reviewer.client, status, at: now, ...(clean ? { notes: clean } : {}) },
      updatedAt: now,
    };
    return { ...replaceTask(current, updated), lastProgressAt: now };
  });
  return { board, task: findTask(board, id) };
}

/**
 * One automatic retry after a rejection: back to in_progress with the attempt
 * counted, optionally handed to another agent. The retry ceiling is enforced
 * here rather than by the caller, so a loop of retries cannot outrun the limit.
 */
export async function retryTask(
  client: UpstashClient,
  code: string,
  id: string,
  actor: { name: string; client: ClientKind },
  options: { reason?: string; to?: string; maxRetries?: number } = {},
  now: number = Date.now(),
): Promise<{ board: TaskBoard; task: Task }> {
  let updated: Task;
  const board = await casTaskBoard(client, code, (current, room) => {
    const task = findTask(current, id);
    if (task.state !== 'rejected') {
      throw new TaskStateError(`Task ${id} is ${task.state}; only a rejected task is retried.`);
    }
    const ceiling = options.maxRetries ?? task.maxRetries;
    const retryCount = (task.retryCount ?? 0) + 1;
    if (typeof ceiling === 'number' && retryCount > ceiling) {
      throw new TaskStateError(`Task ${id} has already used its ${ceiling} retries — the boss must decide what happens next.`);
    }
    const to = options.to?.trim();
    if (to && room && !room.participants.some(p => p.name.trim().toLowerCase() === to.toLowerCase())) {
      throw new TaskStateError(`The hand-off target ${to} is not in this room.`);
    }
    if (to && task.verifier && to.toLowerCase() === task.verifier.trim().toLowerCase()) {
      throw new TaskStateError('The verifier cannot take over the work they are meant to check.');
    }
    const reason = options.reason?.trim().slice(0, 500) || 'Retry after rejection';
    updated = {
      ...task,
      state: 'in_progress',
      retryCount,
      retries: [...(task.retries ?? []), { at: now, reason, attempt: retryCount,
        ...(task.owner ? { from: task.owner } : {}), ...(to ? { to } : {}) }].slice(-20),
      ...(to ? { owner: to, ownerClient: 'cc' as ClientKind } : {}),
      updatedAt: now,
    };
    return { ...replaceTask(current, updated), lastProgressAt: now };
  });
  return { board, task: findTask(board, id) };
}

/**
 * The artifact half is always required; the check half accepts either shape.
 *
 * Requiring a test run made submit unreachable for every task that is not code
 * — write a document, do the research, draft the plan — and the producer's only
 * ways out were to stall or to invent an exitCode. Neither is evidence. `checks`
 * (the done-when criteria and how each was verified) is a weaker guarantee than
 * a green suite and a much stronger one than a fabricated zero.
 *
 * Half a run is still rejected: output with no exit code, or an exit code with
 * no output, is a claim rather than a record.
 */
function assertEvidenceComplete(e: Partial<TaskEvidence>): void {
  if (!e.fileListing || !e.fileListing.trim()) throw new EvidenceIncompleteError('fileListing is empty');
  if (!e.fileExcerpt || !e.fileExcerpt.trim()) throw new EvidenceIncompleteError('fileExcerpt is empty');
  const hasOutput = Boolean(e.runOutput && e.runOutput.trim());
  const hasCode = typeof e.exitCode === 'number' && Number.isFinite(e.exitCode);
  if (hasOutput !== hasCode) {
    throw new EvidenceIncompleteError(
      hasOutput ? 'runOutput was given without a numeric exitCode' : 'exitCode was given without runOutput',
    );
  }
  if (!hasOutput && !(e.checks && e.checks.trim())) {
    throw new EvidenceIncompleteError(
      'no proof of checking: give runOutput + exitCode for work with a run, or checks '
      + '(each done-when criterion and how you verified it) for work without one',
    );
  }
}

/**
 * T-03: shared submit-side state machine for submitTask / submitForReview.
 *
 * Two holes this closes, both reachable from the MCP/API task routes that call
 * these directly and so never saw evaluateSubmitGuard:
 *   - a `done` (or `cancelled`) task could be resubmitted straight back to
 *     awaiting_review, contradicting hostSetTaskState's "done is terminal";
 *   - anyone could submit on a task another agent had claimed.
 * Resubmitting a `rejected` task is deliberate and stays allowed (the reject →
 * fix → resubmit loop is the point of the gate). A `todo` task with only a
 * nominal owner also stays submittable, same reasoning as the claim path.
 */
function assertCanSubmit(task: Task, submitter: { name: string }): void {
  if (task.state === 'blocked' || (task.waiting && task.waiting.resumedAt === undefined)) {
    throw new TaskStateError(`Task ${task.id} is waiting; resolve the recorded wait with room_task resume before submitting.`);
  }
  if (task.state === 'done') throw new TaskDoneImmutableError(task.id);
  if (task.state === 'cancelled') {
    throw new TaskStateError(
      `Task ${task.id} is cancelled — the host must reopen it before new evidence can be submitted.`,
    );
  }
  if ((task.state === 'in_progress' || task.state === 'awaiting_review')
    && task.owner && !sameAgentName(task.owner, submitter.name)) {
    throw new TaskStateError(
      `Task ${task.id} is owned by ${task.owner} — only its owner can submit it for review.`,
    );
  }
}

// Producer submits evidence → 'awaiting_review'. THIS is the gate: a submission
// with any missing evidence part is rejected and the task does not move. The
// submitter becomes the recorded owner if none was set.
export async function submitTask(
  client: UpstashClient,
  code: string,
  id: string,
  submitter: { name: string; client: ClientKind },
  evidence: Omit<TaskEvidence, 'submittedBy' | 'submittedClient' | 'at'>,
  now: number = Date.now(),
  execution?: TaskExecutionRequest,
): Promise<{ board: TaskBoard; task: Task }> {
  // Validate before touching Redis so a bad submission fails fast.
  assertEvidenceComplete(evidence);
  let updated: Task;
  const board = await casTaskBoard(client, code, async (current, room) => {
    const task = findTask(current, id);
    assertCanSubmit(task, submitter);
    if (task.requirements?.owner && !task.execution) throw new TaskExecutionError('recovery_required', 'Claim a verified execution before submitting work with capability requirements.');
    await assertTaskExecution(task, room, submitter, execution, now);
    const fullEvidence: TaskEvidence = {
      fileListing: evidence.fileListing,
      fileExcerpt: evidence.fileExcerpt,
      ...(evidence.runOutput ? { runOutput: evidence.runOutput } : {}),
      ...(typeof evidence.exitCode === 'number' ? { exitCode: evidence.exitCode } : {}),
      ...(evidence.checks ? { checks: evidence.checks } : {}),
      submittedBy: submitter.name,
      submittedClient: submitter.client,
      at: now,
    };
    updated = {
      ...task,
      owner: task.owner ?? submitter.name,
      ownerClient: task.ownerClient ?? submitter.client,
      state: 'awaiting_review',
      evidence: fullEvidence,
      ...(task.execution ? { submittedAttemptId: task.execution.attemptId } : {}),
      reviewRequestedAt: now,
      updatedAt: now,
    };
    return { ...replaceTask(current, updated), lastProgressAt: now };
  }, !!execution, execution ? { id, attemptId: execution.attemptId, mode: 'active' } : undefined);
  return { board, task: findTask(board, id) };
}

// Light "ready for review" path for marker-driven hosted-agent rooms: the
// owner states what they did (a non-code task has no runnable 3-part evidence)
// and the task moves to 'awaiting_review'. A NON-owner peer must still confirm
// via verifyTask to reach 'done', so peer verification — the actual
// anti-phantom-delivery property — is preserved; only the machine-checkable
// 3-part code evidence is relaxed. Code tasks should still use submitTask.
export async function submitForReview(
  client: UpstashClient,
  code: string,
  id: string,
  submitter: { name: string; client: ClientKind },
  note: string,
  now: number = Date.now(),
  execution?: TaskExecutionRequest,
): Promise<{ board: TaskBoard; task: Task }> {
  const clean = note.trim();
  if (!clean) throw new TaskStateError('A readiness note is required to submit for review.');
  let updated: Task;
  const board = await casTaskBoard(client, code, async (current, room) => {
    const task = findTask(current, id);
    assertCanSubmit(task, submitter);
    if (task.requirements?.owner && !task.execution) throw new TaskExecutionError('recovery_required', 'Claim a verified execution before submitting work with capability requirements.');
    await assertTaskExecution(task, room, submitter, execution, now);
    updated = {
      ...task,
      owner: task.owner ?? submitter.name,
      ownerClient: task.ownerClient ?? submitter.client,
      state: 'awaiting_review',
      readinessNote: clean,
      ...(task.execution ? { submittedAttemptId: task.execution.attemptId } : {}),
      reviewRequestedAt: now,
      updatedAt: now,
    };
    return { ...replaceTask(current, updated), lastProgressAt: now };
  }, !!execution, execution ? { id, attemptId: execution.attemptId, mode: 'active' } : undefined);
  return { board, task: findTask(board, id) };
}

export interface VerifyTaskOptions {
  /** Agent reviewers of fenced or capability-constrained tasks prove their seat. */
  reviewerProof?: TaskExecutionRequest;
  /**
   * The room host ruling from the web board. The caller has already
   * established that the viewer is the host; the owner still cannot rule on
   * their own delivery.
   */
  hostOverride?: boolean;
}

// The ONLY path to 'done' / 'rejected'. Enforces:
//   - the task is awaiting review (you cannot verify thin air);
//   - the caller is not the owner (no self-verification, ever);
//   - if a verifier is designated, the caller must be that verifier (or the
//     host ruling from the board);
//   - an open review wait is resolved first;
//   - agent reviewers of fenced or constrained tasks prove their seat and meet
//     the review requirements.
export async function verifyTask(
  client: UpstashClient,
  code: string,
  id: string,
  verifier: { name: string; client: ClientKind },
  verdict: 'done' | 'rejected',
  note: string | undefined,
  now: number = Date.now(),
  options: VerifyTaskOptions = {},
): Promise<{ board: TaskBoard; task: Task }> {
  let updated: Task;
  const board = await casTaskBoard(client, code, async (current, room) => {
    const task = findTask(current, id);
    if (verifier.client === 'cc' && (task.execution || task.requirements?.review || options.reviewerProof)) {
      const actor = await executionActor(room, verifier, options.reviewerProof);
      const gaps = capabilityGaps(task.requirements?.review, currentCapabilities(actor.participant));
      if (gaps.length) throw new TaskExecutionError('capability_required', `Review requirements are not met: ${gaps.join('; ')}`);
    }
    if (task.state === 'done' || task.state === 'cancelled') throw new TaskDoneImmutableError(id);
    if (task.state !== 'awaiting_review') {
      throw new TaskStateError(`Task ${id} is '${task.state}', not 'awaiting_review' — nothing to verify. The producer must submit evidence first.`);
    }
    if (task.waiting && task.waiting.resumedAt === undefined) {
      throw new TaskStateError(`Task ${id} has an open review wait; resolve it with room_task resume before issuing a verdict.`);
    }
    // Owner can never verify their own delivery. When ownerClient was never
    // recorded (createTask accepts an owner name alone), the safe direction is
    // to BLOCK on a bare name match — otherwise the producer could self-verify
    // just because the client kind was missing.
    if (task.owner && sameAgentName(task.owner, verifier.name)
      && (task.ownerClient === undefined || task.ownerClient === verifier.client)) {
      throw new OwnerCannotVerifyError(id);
    }
    // If a verifier is designated, only they may rule. When verifierClient was
    // never recorded, match on name alone — requiring an undefined client to
    // equal the caller's made such tasks permanently unverifiable.
    if (task.verifier && !options.hostOverride && !(sameAgentName(task.verifier, verifier.name)
      && (task.verifierClient === undefined || task.verifierClient === verifier.client))) {
      throw new NotVerifierError(id, task.verifier);
    }
    updated = {
      ...task,
      state: verdict === 'done' ? 'done' : 'rejected',
      verdict: { verdict, note, by: verifier.name, byClient: verifier.client, at: now },
      updatedAt: now,
    };
    return { ...replaceTask(current, updated), lastProgressAt: now };
  }, !!options.reviewerProof && verifier.client === 'cc');
  return { board, task: findTask(board, id) };
}

// Edit a task's mutable fields and/or correct its scope. This is the path the
// periodic board review uses to fix a task that turned out to be wrong, split,
// or off-track, and to REOPEN a task (done/rejected/awaiting_review → todo or
// in_progress). It deliberately CANNOT set 'done' or 'awaiting_review': those
// remain reachable only through submitTask (evidence) + verifyTask (peer
// ruling), so the anti-phantom-delivery gate can't be edited around.
export interface UpdateTaskInput {
  title?: string;
  dod?: string;
  verifier?: string;
  verifierClient?: ClientKind;
  /** Who made the change, for the verifier audit trail. */
  actor?: { name: string; client: ClientKind };
  /** Full replacement of the owner/review requirements (not a partial merge). */
  requirements?: Task['requirements'];
  /** Reopen / re-scope only. Allowed: 'todo' | 'in_progress' | 'rejected'. */
  state?: Extract<TaskState, 'todo' | 'in_progress' | 'rejected'>;
}

const REOPENABLE_TARGET_STATES: ReadonlySet<TaskState> = new Set<TaskState>(['todo', 'in_progress', 'rejected']);

export async function updateTask(
  client: UpstashClient,
  code: string,
  id: string,
  patch: UpdateTaskInput,
  now: number = Date.now(),
): Promise<{ board: TaskBoard; task: Task }> {
  let requirements: Task['requirements'];
  try { requirements = normalizeTaskRequirements(patch.requirements); } catch (error) { throw new TaskStateError((error as Error).message); }
  if (patch.state && !REOPENABLE_TARGET_STATES.has(patch.state)) {
    throw new TaskStateError(`updateTask cannot set state '${patch.state}'. Use submitTask (evidence) then verifyTask to reach 'awaiting_review'/'done'.`);
  }
  const board = await casTaskBoard(client, code, (current) => {
    const task = findTask(current, id);
    if (task.state === 'done') throw new TaskDoneImmutableError(id);
    if (task.waiting && task.waiting.resumedAt === undefined && patch.state && patch.state !== task.state) {
      throw new TaskStateError('Use room_task resume with a resolution note to release this wait.');
    }
    if ((patch.title === undefined || !patch.title.trim() || patch.title.trim() === task.title)
      && (patch.dod === undefined || patch.dod === task.dod)
      && (patch.requirements === undefined || JSON.stringify(requirements) === JSON.stringify(task.requirements))
      && (patch.verifier === undefined || (patch.verifier === task.verifier && patch.verifierClient === task.verifierClient))
      && (patch.state === undefined || patch.state === task.state)) return current;
    const verifier = patch.verifier?.trim();
    const updated: Task = {
      ...task,
      ...(patch.title !== undefined && patch.title.trim() ? { title: patch.title.trim() } : {}),
      ...(patch.dod !== undefined ? { dod: patch.dod } : {}),
      ...(patch.requirements !== undefined ? { requirements } : {}),
      ...(verifier !== undefined ? { verifier: verifier || undefined, verifierClient: verifier ? patch.verifierClient : undefined,
        ...(verifier !== task.verifier ? { roleHistory: [...(task.roleHistory ?? []), {
          by: patch.actor?.name ?? 'system', byClient: patch.actor?.client ?? 'cc', at: now,
          field: 'verifier' as const, from: task.verifier, to: verifier || undefined,
        }], ...(task.state === 'awaiting_review' ? { reviewRequestedAt: now } : {}) } : {}) } : {}),
      ...(patch.state ? { state: patch.state } : {}),
      updatedAt: now,
    };
    return { ...replaceTask(current, updated), lastProgressAt: now };
  });
  return { board, task: findTask(board, id) };
}

export interface TaskFilesPatch {
  inputs?: string[];
  deliverables?: string[];
}

/**
 * Record a task's vault links (materials it works from, deliverables it
 * produced) on the board itself.
 *
 * The vault keeps its own `task:{id}` index, so this is not how files are
 * found — it is what the BOARD shows: a card that says "🗂 2 deliverables" and
 * can open them. Both directions are written because either one alone produces
 * a lie: a card with no links while the vault knows the files, or a link to a
 * file that has been deleted.
 *
 * Append-only and idempotent. A revision of the same deliverable keeps its id,
 * so re-submitting does not grow the list. A done task is not frozen here: the
 * verifier may attach the deliverable it inspected after the fact.
 */
export async function setTaskFiles(
  client: UpstashClient,
  code: string,
  id: string,
  patch: TaskFilesPatch,
  now: number = Date.now(),
): Promise<{ board: TaskBoard; task: Task }> {
  const board = await casTaskBoard(client, code, (current) => {
    const task = findTask(current, id);
    const merge = (existing: string[] | undefined, incoming: string[] | undefined) => {
      if (!incoming || incoming.length === 0) return existing;
      const next = [...(existing ?? [])];
      for (const value of incoming) if (value && !next.includes(value)) next.push(value);
      return next.length > 0 ? next : undefined;
    };
    const inputs = merge(task.files?.inputs, patch.inputs);
    const deliverables = merge(task.files?.deliverables, patch.deliverables);
    if (JSON.stringify({ inputs, deliverables }) === JSON.stringify({ inputs: task.files?.inputs, deliverables: task.files?.deliverables })) {
      return current;
    }
    const files: NonNullable<Task['files']> = {
      ...(inputs ? { inputs } : {}),
      ...(deliverables ? { deliverables } : {}),
    };
    return { ...replaceTask(current, { ...task, files, updatedAt: now }), lastProgressAt: now };
  });
  return { board, task: findTask(board, id) };
}

export interface WaitTaskInput {
  scope: 'owner' | 'review';
  reasonCode: TaskWaitReason;
  reason: string;
  resumeWhen: string;
  waitingFor?: string;
}

const WAIT_REASONS = new Set<string>(['missing_user_input', 'missing_credential', 'tool_failure', 'dependency', 'other']);
const sameActor = (name: string | undefined, client: ClientKind | undefined, actor: { name: string; client: ClientKind }) =>
  !!name && name.trim().toLowerCase() === actor.name.trim().toLowerCase() && (!client || client === actor.client);

/**
 * The reviewer's explicit receipt (`ack`) or declared start (`review_start`).
 * Publication of a notification never claims the agent read or executed it;
 * this does, and only for the current reviewer and the current notice.
 */
export async function acknowledgeTaskReview(client: UpstashClient, code: string, id: string,
  actor: { name: string; client: ClientKind }, started: boolean, notificationId?: string, now = Date.now(),
  proof?: TaskExecutionRequest,
): Promise<{ board: TaskBoard; task: Task }> {
  const board = await casTaskBoard(client, code, async (current, room) => {
    const task = findTask(current, id);
    if (task.execution || task.requirements?.review || proof) {
      const verified = await executionActor(room, actor, proof);
      const gaps = capabilityGaps(task.requirements?.review, currentCapabilities(verified.participant));
      if (gaps.length) throw new TaskExecutionError('capability_required', gaps.join('; '));
    }
    if (task.state !== 'awaiting_review' || !sameActor(task.verifier, task.verifierClient, actor)
      || (task.waiting && task.waiting.resumedAt === undefined)) {
      throw new TaskStateError('Only the current available reviewer can acknowledge or start this review.');
    }
    if (notificationId && notificationId !== task.notification?.id) throw new TaskStateError('This review notification has been superseded. Read the current inbox.');
    const receipt = task.reviewReceipt;
    if (receipt?.by === actor.name && receipt.notificationId === task.notification?.id && (!started || receipt.startedAt !== undefined)) return current;
    return replaceTask(current, { ...task, reviewReceipt: { by: actor.name, byClient: actor.client,
      notificationId: task.notification?.id, readAt: receipt?.readAt ?? now,
      ...(started ? { startedAt: receipt?.startedAt ?? now } : {}) } });
  }, !!proof);
  return { board, task: findTask(board, id) };
}

/**
 * Declare that owner work or a review cannot proceed until something specific
 * happens. Owner waits move the task to `blocked`; review waits keep it in
 * awaiting_review with its evidence and reviewer. Neither is immediate work
 * in the inbox, and a repeated identical wait is a no-op (no second notice).
 */
export async function waitTask(client: UpstashClient, code: string, id: string,
  actor: { name: string; client: ClientKind }, input: WaitTaskInput, now = Date.now(), hostAuthorized = false,
  proof?: TaskExecutionRequest,
): Promise<{ board: TaskBoard; task: Task }> {
  if (!['owner', 'review'].includes(input.scope) || !WAIT_REASONS.has(input.reasonCode)
    || !input.reason?.trim() || !input.resumeWhen?.trim()) {
    throw new TaskStateError('Wait requires scope, reasonCode, a specific reason and resumeWhen.');
  }
  const board = await casTaskBoard(client, code, async (current, room) => {
    const task = findTask(current, id);
    if (task.execution && !hostAuthorized) {
      await executionActor(room, actor, proof);
      if (input.scope === 'owner' && activeTaskLease(task.lease, now)) await assertTaskExecution(task, room, actor, proof, now);
    }
    const reviewing = input.scope === 'review';
    if (reviewing ? task.state !== 'awaiting_review' : !['todo', 'in_progress', 'blocked'].includes(task.state)) {
      throw new TaskStateError('Owner waits require open owner work; review waits require awaiting_review.');
    }
    if (!hostAuthorized && !sameActor(reviewing ? task.verifier : task.owner, reviewing ? task.verifierClient : task.ownerClient, actor)) {
      throw new TaskStateError('Only the responsible owner/reviewer or the proven host can declare this wait.');
    }
    const waitingFor = input.waitingFor?.trim() || undefined;
    if (waitingFor && room && !room.participants.some(p => p.name.trim().toLowerCase() === waitingFor.toLowerCase())) {
      throw new TaskStateError(`waitingFor must name a room participant; ${waitingFor} is not in this room.`);
    }
    if (task.waiting && task.waiting.resumedAt === undefined && task.waiting.scope === input.scope
      && task.waiting.reasonCode === input.reasonCode && task.waiting.reason === input.reason.trim()
      && task.waiting.resumeWhen === input.resumeWhen.trim() && task.waiting.waitingFor === waitingFor) return current;
    const waiting = { by: actor.name, byClient: actor.client, at: now,
      scope: input.scope, reasonCode: input.reasonCode, reason: input.reason.trim(),
      resumeWhen: input.resumeWhen.trim(), waitingFor };
    return { ...replaceTask(current, { ...task, waiting, state: reviewing ? 'awaiting_review' : 'blocked',
      ...(!reviewing ? { blocked: { by: actor.name, byClient: actor.client, at: now, reason: waiting.reason } } : {}), updatedAt: now }), lastProgressAt: now };
  }, !!proof && !hostAuthorized);
  return { board, task: findTask(board, id) };
}

/**
 * Release a wait with a resolution note. The responsible agent, the named
 * unblocker or the proven host may resume. Ordinary chat never does.
 */
export async function resumeTask(client: UpstashClient, code: string, id: string,
  actor: { name: string; client: ClientKind }, resolution: string, now = Date.now(), hostAuthorized = false,
  proof?: TaskExecutionRequest,
): Promise<{ board: TaskBoard; task: Task }> {
  if (!resolution?.trim()) throw new TaskStateError('Resume requires a resolution explaining how the missing condition was met.');
  const board = await casTaskBoard(client, code, async (current, room) => {
    const task = findTask(current, id);
    if (task.execution && !hostAuthorized && actor.client === 'cc') await executionActor(room, actor, proof);
    const wait = task.waiting;
    if (task.state !== 'blocked' && !(task.state === 'awaiting_review' && wait && wait.resumedAt === undefined)) {
      throw new TaskStateError('This task is not waiting.');
    }
    const reviewing = wait?.scope === 'review' && wait.resumedAt === undefined;
    if (!hostAuthorized && !sameActor(reviewing ? task.verifier : task.owner, reviewing ? task.verifierClient : task.ownerClient, actor)
      && !sameActor(wait?.waitingFor, undefined, actor)) {
      throw new TaskStateError('Only the responsible agent, named unblocker or proven host can resume this task.');
    }
    return { ...replaceTask(current, { ...task, state: reviewing ? 'awaiting_review' : 'in_progress',
      ...(reviewing ? { reviewRequestedAt: now } : {}),
      ...(wait && wait.resumedAt === undefined ? { waiting: { ...wait, resumedAt: now, resumedBy: actor.name, resumedClient: actor.client, resolution: resolution.trim() } } : {}),
      updatedAt: now }), lastProgressAt: now };
  }, !!proof && !hostAuthorized && actor.client === 'cc');
  return { board, task: findTask(board, id) };
}

// Owner/host declares a task cannot proceed — missing deploy/access rights,
// missing input files, or a spec still ambiguous after one clarification.
// `blocked` stays OPEN work (it counts for end-room guards and shows on the
// board), and it is NOT a completion claim, so there is no verifier gate.
// Ownership enforcement lives at the marker/tool layer; reopen via updateTask
// or a [REOPEN] marker once the blocker is gone.
export async function blockTask(
  client: UpstashClient,
  code: string,
  id: string,
  by: { name: string; client: ClientKind },
  reason: string,
  now: number = Date.now(),
): Promise<{ board: TaskBoard; task: Task }> {
  const clean = reason.trim();
  if (!clean) throw new TaskStateError('A reason is required to block a task — say exactly what is missing.');
  let updated: Task;
  const board = await casTaskBoard(client, code, (current) => {
    const task = findTask(current, id);
    if (task.state !== 'todo' && task.state !== 'in_progress') {
      throw new TaskStateError(`Task ${id} is '${task.state}' — only todo / in_progress tasks can be blocked.`);
    }
    updated = {
      ...task,
      state: 'blocked',
      blocked: { by: by.name, byClient: by.client, at: now, reason: clean },
      updatedAt: now,
    };
    return { ...replaceTask(current, updated), lastProgressAt: now };
  });
  return { board, task: findTask(board, updated!.id) };
}

export class TaskDoneImmutableError extends UpstashError {
  constructor(id: string) {
    super(`Task ${id} is 'done' — completed tasks are locked and cannot be changed.`);
    this.name = 'TaskDoneImmutableError';
  }
}

// Host override: the human who owns the room is the ultimate authority on the
// board, so they may set any NOT-done task to any state — including straight
// to 'done', bypassing the evidence gate (the gate exists to stop AGENTS from
// phantom-delivering; the paying human ruling by hand is the point of the
// gate, not a violation of it). The one hard rule, per product decision:
// 'done' is terminal for hosts — a completed task can never be flipped back.
// Caller MUST have already authenticated the host (hostKey) — this function
// only enforces the state machine.
export async function hostSetTaskState(
  client: UpstashClient,
  code: string,
  id: string,
  state: TaskState,
  hostName: string,
  now: number = Date.now(),
): Promise<{ board: TaskBoard; task: Task }> {
  let updated: Task;
  const board = await casTaskBoard(client, code, (current) => {
    const task = findTask(current, id);
    if (task.state === 'done' || task.state === 'cancelled') throw new TaskDoneImmutableError(id);
    if (task.state === state) return current;
    updated = {
      ...task,
      state,
      ...(state === 'done' || state === 'rejected'
        ? { verdict: { verdict: state === 'done' ? 'done' as const : 'rejected' as const, note: 'Set by host', by: hostName, byClient: 'web' as ClientKind, at: now } }
        : {}),
      ...(state === 'blocked'
        ? { blocked: { by: hostName, byClient: 'web' as ClientKind, at: now, reason: 'Set by host' } }
        : {}),
      updatedAt: now,
    };
    return { ...replaceTask(current, updated), lastProgressAt: now };
  });
  return { board, task: findTask(board, id) };
}

function nextSubtaskId(task: Task): string {
  let max = 0;
  for (const s of task.subtasks ?? []) {
    const m = /^S-(\d+)$/.exec(s.id);
    if (m) max = Math.max(max, Number(m[1]));
  }
  return `S-${String(max + 1).padStart(2, '0')}`;
}

// Add a checklist item under a task. Subtasks are not evidence-gated.
export async function addSubtask(
  client: UpstashClient,
  code: string,
  taskId: string,
  title: string,
  by: { name: string; client: ClientKind },
  now: number = Date.now(),
): Promise<{ board: TaskBoard; task: Task; subtask: SubTask }> {
  const clean = title.trim();
  if (!clean) throw new TaskStateError('Subtask title is required.');
  let updated: Task;
  let created: SubTask;
  const board = await casTaskBoard(client, code, (current) => {
    const task = findTask(current, taskId);
    created = { id: nextSubtaskId(task), title: clean, done: false, updatedAt: now };
    updated = { ...task, subtasks: [...(task.subtasks ?? []), created], updatedAt: now };
    return { ...replaceTask(current, updated), lastProgressAt: now };
  });
  return { board, task: findTask(board, taskId), subtask: created! };
}

// Tick / untick a subtask. Self-ticking is fine — the parent task still needs
// peer verification to reach 'done'.
export async function toggleSubtask(
  client: UpstashClient,
  code: string,
  taskId: string,
  subtaskId: string,
  done: boolean,
  by: { name: string; client: ClientKind },
  now: number = Date.now(),
): Promise<{ board: TaskBoard; task: Task }> {
  let updated: Task;
  const board = await casTaskBoard(client, code, (current) => {
    const task = findTask(current, taskId);
    const subs = task.subtasks ?? [];
    if (!subs.some(s => s.id === subtaskId)) {
      throw new TaskNotFoundError(`${taskId}/${subtaskId}`);
    }
    updated = {
      ...task,
      subtasks: subs.map(s => (s.id === subtaskId
        ? { ...s, done, doneBy: done ? by.name : undefined, doneClient: done ? by.client : undefined, updatedAt: now }
        : s)),
      updatedAt: now,
    };
    return { ...replaceTask(current, updated), lastProgressAt: now };
  });
  return { board, task: findTask(board, updated!.id) };
}

// Stamp lastReviewAt after a periodic board review pass. Best-effort bookkeeping
// (debounces the next review); does NOT bump lastProgressAt, so a no-op review
// doesn't reset the stall-nudge clock.
export async function recordBoardReview(client: UpstashClient, code: string, now: number = Date.now(), msgCount?: number): Promise<void> {
  await casTaskBoard(client, code, (current) => ({
    ...current,
    lastReviewAt: now,
    ...(msgCount !== undefined ? { lastReviewMsgCount: msgCount } : {}),
  }));
}

// True when the board has open work and it has been at least intervalMs since
// the last review pass (or there has never been one). Drives the ~20s review
// cadence; the caller debounces the actual agent wake-up off this.
export function boardNeedsReview(board: TaskBoard, intervalMs: number, now: number = Date.now()): boolean {
  if (openTasks(board).length === 0) return false;
  const last = board.lastReviewAt ?? 0;
  return now - last >= intervalMs;
}

export async function clearTaskBoard(client: UpstashClient, code: string): Promise<void> {
  await client.command(['DEL', taskBoardKey(code)]);
  await unregisterBoardRoom(client, code).catch(() => { /* best-effort */ });
}

// ── Board-sweep helpers (used by the server's periodic task-board sweep) ──

export function allTasksDone(board: TaskBoard): boolean {
  return board.tasks.length > 0 && board.tasks.every(t => t.state === 'done');
}

// Agents the moderator has marked low-capability (no new assignments). Reads the
// reliability tally maintained by reassignTask.
export function demotedAgents(board: TaskBoard): string[] {
  const rel = board.reliability ?? {};
  return Object.keys(rel).filter(name => rel[name]?.demotedAt !== undefined);
}

export function isAgentDemoted(board: TaskBoard, name: string): boolean {
  return board.reliability?.[name]?.demotedAt !== undefined;
}

export function agentBlocks(board: TaskBoard, name: string): number {
  return board.reliability?.[name]?.blocks ?? 0;
}

/**
 * Tasks that still need work — end-room guards, stall nudges, progress UI.
 * `blocked` stays included: it is open work waiting on an external unblock.
 * `rejected` is a terminal disposition (no further work unless explicitly
 * reopened), so it is excluded alongside `done`.
 */
export function openTasks(board: TaskBoard): Task[] {
  return board.tasks.filter(t => t.state !== 'done' && t.state !== 'rejected' && t.state !== 'cancelled');
}

/**
 * True when nothing actionable remains — every task is done or rejected.
 * Used to stop periodic board review / prune the cron index without treating
 * a mixed done+rejected board as “all verified done”.
 */
export function boardHasNoOpenWork(board: TaskBoard): boolean {
  return openTasks(board).length === 0;
}

export function doneTasks(board: TaskBoard): Task[] {
  return board.tasks.filter(t => t.state === 'done');
}

// Source of truth for "delivered" in minutes / room summaries: verified-done
// board tasks. Returns null when there is no board (caller falls back to LLM).
export function deliveredFromBoard(board: TaskBoard | null | undefined): boolean | null {
  if (!board?.tasks.length) return null;
  return doneTasks(board).length > 0;
}

export function formatDeliveredTask(task: Task): string {
  const verifier = task.verdict?.by ? ` (verified by ${task.verdict.by})` : '';
  const listing = task.evidence?.fileListing?.trim().split('\n').find(Boolean);
  const evidence = listing ? ` — ${listing}` : '';
  return `${task.id}: ${task.title}${verifier}${evidence}`;
}

export function deliverablesFromBoard(board: TaskBoard | null | undefined): string[] {
  if (!board) return [];
  return doneTasks(board).map(formatDeliveredTask);
}

// Prompt / report seed: verified-done tasks the analytics layer must honor.
export function boardDeliveredSection(board: TaskBoard | null | undefined): string {
  if (!board?.tasks.length) return '';
  const done = doneTasks(board);
  if (!done.length) {
    return [
      `任务板（${board.tasks.length} 项任务，尚无 verified-done）：`,
      summarizeBoard(board),
      '若任务板存在但无一 done，"delivered" 必须为 false。',
    ].join('\n');
  }
  return [
    '任务板 verified-done 交付（以此为准判断 delivered，勿被聊天 prose 误导）：',
    ...done.map(formatDeliveredTask),
  ].join('\n');
}

// Board summary for reminder messages / the listen payload.
// Actionable open tasks (todo / in_progress / awaiting_review) stay one line
// each; rejected terminals keep a visible history line; verified-done tasks
// collapse to a single trailing "✅ N done" line.
export function summarizeBoard(board: TaskBoard): string {
  const icon: Record<TaskState, string> = {
    todo: '⬜', pending_approval: '🛂', in_progress: '🔵', paused: '⏸️', awaiting_review: '🟡',
    blocked: '🟠', done: '✅', rejected: '🔴', cancelled: '🗑️', aborted: '⛔',
  };
  const open = openTasks(board);
  const rejected = board.tasks.filter(t => t.state === 'rejected');
  const cancelled = board.tasks.filter(t => t.state === 'cancelled');
  const doneCount = board.tasks.filter(t => t.state === 'done').length;
  const lines = [
    ...open.map((t) => {
      const blockedSuffix = t.state === 'blocked' && t.blocked?.reason?.trim()
        ? `: ${t.blocked.reason.trim().slice(0, 80)}`
        : '';
      return `${icon[t.state]} ${t.id} ${t.title}${t.owner ? ` (@${t.owner})` : ''} — ${t.state}${blockedSuffix}`;
    }),
    ...rejected.map(t => {
      const note = t.verdict?.note?.trim();
      const noteSuffix = note ? `: ${note.slice(0, 80)}` : '';
      return `${icon.rejected} ${t.id} ${t.title}${t.owner ? ` (@${t.owner})` : ''} — rejected${noteSuffix}`;
    }),
    ...cancelled.map(t => {
      const reason = t.cancellation?.reason?.trim();
      const reasonSuffix = reason ? `: ${reason.slice(0, 80)}` : '';
      const by = t.cancellation?.by ? ` by @${t.cancellation.by}` : '';
      return `${icon.cancelled} ${t.id} ${t.title}${t.owner ? ` (@${t.owner})` : ''} — cancelled${by}${reasonSuffix}`;
    }),
  ];
  if (doneCount > 0) lines.push(`✅ ${doneCount} done`);
  return lines.join('\n');
}

// Debounce bookkeeping writes. Best-effort; callers ignore failures.
// `newEpisode` restarts the count: the cap is meant to stop one stall being
// nagged forever, not to spend the room's whole allowance on its first quiet
// stretch and stay silent for the rest of the session.
export async function recordStallNudge(
  client: UpstashClient,
  code: string,
  now: number = Date.now(),
  newEpisode = false,
): Promise<void> {
  await casTaskBoard(client, code, (current) => ({
    ...current,
    lastStallNudgeAt: now,
    stallNudgeCount: newEpisode ? 1 : (current.stallNudgeCount ?? 0) + 1,
  }));
}

export async function recordCompletionAnnounced(client: UpstashClient, code: string, now: number = Date.now()): Promise<void> {
  await casTaskBoard(client, code, (current) => ({ ...current, completionAnnouncedAt: now }));
}

// Re-export the task state type so callers importing from upstash-client can
// reference the canonical union without also importing @agent-room/shared.
export type { Task, TaskBoard, TaskEvidence, TaskRoleChange, TaskState };
