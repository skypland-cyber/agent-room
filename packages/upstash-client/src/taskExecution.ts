// Fenced MCP task execution (ported from the hosted deployment's #748).
//
// Every claim/recovery mints a new attempt and a task lease bound to the
// claimer's seat identity. Protected writes (submit, renew, release, handoff)
// must present the current attemptId and prove the seat with its private
// seatKey, so a disconnected or replaced process cannot commit a late result.
//
// This is a record of a seat, not an OS process lock, and it does not undo
// side effects a stale process already performed outside the room. In this
// deployment the browser also holds the storage write token (KNOWN-GAPS 10),
// so the fence protects against other MCP callers, not against someone who
// writes to Redis directly.
import type { AgentCapabilityReport, ClientKind, Participant, Room, Task, TaskAttempt } from '@agent-room/shared';
import { activeTaskLease, capabilityGaps, currentCapabilities, participantMemberId, sessionStartedAt, taskLeaseTtl } from '@agent-room/shared';
import { sha256Hex } from './sha256.js';
import { seatHashMatches } from './rooms.js';
import type { TaskRoster } from './taskPolicy.js';

export interface TaskExecutionRequest { seatKey?: string; attemptId?: string; ttlMs?: number }
export interface ExecutionActor { name: string; client: ClientKind; memberId: string; participant: Participant; roomSessionStartedAt?: number }
export class TaskExecutionError extends Error {
  constructor(readonly code: string, message: string) { super(message); this.name = `task_execution_${code}`; }
}

const uuid = (): string => (globalThis as unknown as { crypto: Crypto }).crypto.randomUUID();

function rosterSession(room: TaskRoster | null): number | undefined {
  return room && typeof room.createdAt === 'number' ? sessionStartedAt(room as Pick<Room, 'createdAt' | 'reactivatedAt'>) : undefined;
}

export async function executionActor(room: TaskRoster | null, actor: { name: string; client: ClientKind }, request?: TaskExecutionRequest): Promise<ExecutionActor> {
  const participant = room?.participants.find(p => p.name === actor.name && p.client === actor.client && p.client === 'cc' && p.canSpeak !== false);
  const memberId = participant && participantMemberId(participant);
  const presented = request?.seatKey ? await sha256Hex(request.seatKey) : undefined;
  if (!participant || !memberId || !seatHashMatches(participant.seatKeyHash, presented)) {
    throw new TaskExecutionError('identity_required', 'Prove the current agent seat with the seatKey room_join returned. Display names and attempt ids are not identity proof.');
  }
  return { name: participant.name, client: participant.client, memberId, participant, roomSessionStartedAt: rosterSession(room) };
}

export function currentAttempt(task: Task): TaskAttempt | undefined {
  return task.attempts?.find(a => a.id === task.execution?.attemptId);
}

export function finishTaskAttempt(task: Task, status: Exclude<TaskAttempt['status'], 'running'>, reason: string, now: number): Task {
  if (!task.execution) return task;
  const attempt = currentAttempt(task);
  const endedAt = reason === 'lease_expired' ? task.lease?.expiresAt ?? now : now;
  return { ...task, execution: { ...task.execution, recoveryRequired: !['done', 'cancelled', 'aborted'].includes(task.state) && !['submitted', 'cancelled'].includes(status) },
    lease: task.lease ? { ...task.lease, status: reason === 'lease_expired' ? 'expired' : 'released', releasedAt: endedAt, handoff: undefined } : undefined,
    attempts: task.attempts?.map(a => a.id === attempt?.id && a.status === 'running' ? { ...a, status, endedAt, endReason: reason } : a) };
}

export function reconcileTaskExecution(task: Task, previous: Task | undefined, now: number, currentRoomSession?: number): Task {
  if (!task.execution) return task;
  const attempt = currentAttempt(task);
  if (['done', 'cancelled', 'aborted'].includes(task.state) && attempt?.status !== 'running'
    && (task.execution.recoveryRequired || task.execution.decisionRequired)) {
    return { ...task, execution: { ...task.execution, recoveryRequired: false, decisionRequired: false } };
  }
  if (previous?.state === 'awaiting_review' && ['in_progress', 'rejected'].includes(task.state) && attempt?.status === 'submitted') {
    return { ...task, execution: { ...task.execution, recoveryRequired: true } };
  }
  if (attempt?.status !== 'running') return task;
  if (attempt.roomSessionStartedAt !== undefined && currentRoomSession !== undefined && attempt.roomSessionStartedAt !== currentRoomSession) {
    return finishTaskAttempt(task, 'interrupted', 'room_reopened', now);
  }
  if (task.state === 'rejected' && previous?.state !== 'rejected') return finishTaskAttempt(task, 'interrupted', 'host_rejected', now);
  if (task.state === 'done') return finishTaskAttempt(task, 'interrupted', 'task_closed_by_host', now);
  if (task.state === 'cancelled' || task.state === 'aborted') return finishTaskAttempt(task, 'cancelled', 'task_closed', now);
  if (task.state === 'awaiting_review') return finishTaskAttempt(task, 'submitted', 'submitted_for_review', now);
  if (task.state === 'blocked') return finishTaskAttempt(task, 'waiting', 'waiting_for_input', now);
  if (task.state === 'paused') return finishTaskAttempt(task, 'waiting', 'task_paused', now);
  if (previous?.execution?.attemptId === task.execution.attemptId
    && (previous.owner !== task.owner || previous.dod !== task.dod
      || JSON.stringify(previous.requirements?.owner) !== JSON.stringify(task.requirements?.owner))) return finishTaskAttempt(task, 'interrupted', 'assignment_or_scope_changed', now);
  if (!activeTaskLease(task.lease, now)) return finishTaskAttempt(task, 'interrupted', 'lease_expired', now);
  return task;
}

export function startTaskAttempt(task: Task, actor: ExecutionActor, now: number, ttlMs?: number): Task {
  let ttl: number;
  try { ttl = taskLeaseTtl(ttlMs); } catch (error) { throw new TaskExecutionError('ttl_invalid', String((error as Error).message)); }
  const report = currentCapabilities(actor.participant);
  const gaps = capabilityGaps(task.requirements?.owner, report);
  if (gaps.length) throw new TaskExecutionError('capability_required', `Execution requirements are not met: ${gaps.join('; ')}. Report current capabilities before claiming.`);
  const id = `attempt-${uuid()}`;
  const leaseId = `task-lease-${uuid()}`;
  const context: TaskAttempt['context'] = report ? { workspaceId: report.workspaceId, repository: report.repository, revision: report.revision } : undefined;
  const attempt: TaskAttempt = { id, leaseId, memberId: actor.memberId, name: actor.name, client: actor.client,
    status: 'running', startedAt: now, confirmedAt: now, roomSessionStartedAt: actor.roomSessionStartedAt, context };
  return { ...task, owner: actor.name, ownerClient: actor.client, state: 'in_progress',
    execution: { attemptId: id, recoveryRequired: false }, attempts: [...(task.attempts ?? []), attempt],
    lease: { id: leaseId, holderId: actor.memberId, holderName: actor.name, holderClient: actor.client,
      status: 'active', grantedAt: now, expiresAt: now + ttl }, updatedAt: now };
}

export async function assertTaskExecution(task: Task, room: TaskRoster | null, actor: { name: string; client: ClientKind }, request: TaskExecutionRequest | undefined, now: number, allowContextChange = false) {
  if (!task.execution) {
    if (task.lease) throw new TaskExecutionError('legacy_lease', 'This task carries a fleet lease. Use its authenticated lease service; the name-only submit path cannot bypass it.');
    return undefined;
  }
  const verified = await executionActor(room, actor, request);
  const attempt = currentAttempt(task);
  if (attempt?.roomSessionStartedAt !== undefined && verified.roomSessionStartedAt !== undefined && attempt.roomSessionStartedAt !== verified.roomSessionStartedAt) {
    throw new TaskExecutionError('lease_not_active', 'The room was reopened. Read the task history and recover a new attempt in the current room session.');
  }
  if (!request?.attemptId || request.attemptId !== task.execution.attemptId || attempt?.leaseId !== task.lease?.id) {
    throw new TaskExecutionError('stale_attempt', 'The attempt has changed. Read the current task and recover explicitly; do not resubmit an old result.');
  }
  if (!activeTaskLease(task.lease, now) || task.lease?.holderId !== verified.memberId || attempt?.status !== 'running') {
    throw new TaskExecutionError('lease_not_active', 'This seat has no active execution lease. Read the task history and recover or request a handoff.');
  }
  const report = currentCapabilities(verified.participant);
  if (!allowContextChange && ((attempt.context?.workspaceId && report?.workspaceId !== attempt.context.workspaceId)
    || (attempt.context?.repository && report?.repository !== attempt.context.repository))) {
    throw new TaskExecutionError('context_changed', 'The reported workspace/repository changed during execution. Release and recover in the correct context.');
  }
  if (!allowContextChange) {
    const { revision: _startingRevision, ...ongoing } = task.requirements?.owner ?? {};
    const gaps = capabilityGaps(ongoing, report);
    if (gaps.length) throw new TaskExecutionError('capability_required', gaps.join('; '));
  }
  return verified;
}

export function sanitizeCapabilityReport(input: unknown, memberId: string, now: number): AgentCapabilityReport {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new TaskExecutionError('capability_invalid', 'Capabilities must be an object.');
  const data = input as Record<string, unknown>;
  const text = (key: string) => {
    const value = data[key];
    if (value === undefined) return undefined;
    if (typeof value !== 'string' || !value.trim() || value.length > 500) throw new TaskExecutionError('capability_invalid', `Invalid ${key}.`);
    return value.trim();
  };
  const tools: AgentCapabilityReport['tools'] = {};
  const raw = data.tools as Record<string, unknown> | undefined;
  if (raw !== undefined && (!raw || typeof raw !== 'object' || Array.isArray(raw))) throw new TaskExecutionError('capability_invalid', 'tools must be an object.');
  for (const key of ['commands', 'room_files', 'native_continuation'] as const) {
    const value = raw?.[key];
    if (value !== undefined && !['yes', 'no', 'unknown'].includes(String(value))) throw new TaskExecutionError('capability_invalid', `Invalid ${key}.`);
    if (value !== undefined) tools[key] = value as 'yes' | 'no' | 'unknown';
  }
  return { source: 'agent_report', memberId, reportedAt: now, workspaceId: text('workspaceId'), repository: text('repository'), revision: text('revision'), tools };
}
