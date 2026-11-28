// Vercel Function: the AI office.
//
//   GET  /api/office                    → the same `status` action (handy curl)
//   POST /api/office { action, … }      → every office operation
//
// ONE function for the whole feature on purpose. A Vercel Hobby project gets a
// small number of Serverless Functions and this repo already uses eight of
// them; a dozen endpoints for the office would push a deployment over the
// limit and break features that have nothing to do with the office. So the
// operation is an `action` field, dispatched here, with shared auth in front.
//
// Auth model: everything except `status`, `login` and `logout` requires the
// signed session cookie from api/_officeAuth.ts. While ADMIN_PASSWORD is unset
// no session can exist, so the whole surface stays locked and `status` reports
// what to set — a missing password must never mean an open office.
import type { VercelRequest, VercelResponse } from '@vercel/node';
import { generateCode, isValidCode } from '@agent-room/shared';
import type { ClientKind, Task, TaskBoard } from '@agent-room/shared';
import {
  OfficeInputError,
  archiveMatches,
  archiveSnippet,
  filterAudit,
  kstDay,
  normalizeAgentInput,
  normalizeGuidelineInput,
  normalizeMemoryInput,
  normalizeOfficeSettings,
  normalizeProjectInput,
  normalizeTemplateInput,
  planTemplateRun,
  usageLevel,
} from '@agent-room/shared';
import type { OfficeAuditEntry } from '@agent-room/shared';
import * as office from '@agent-room/upstash-client';
import { OfficeBackupError } from '@agent-room/upstash-client';
import { createRemoteRoomClient } from './_mcpRoomClient.js';
import { digest, withinRateLimit } from './_roomAccess.js';
import { siteUrl } from './_siteUrl.js';
import { signVaultToken } from './_fileAccess.js';
import { handoffRoom } from './_officeHandoff.js';
import { clearLoginFailures, loginGuardState, recordLoginFailure } from './_loginGuard.js';
import { syncEvent } from './_notion/sync.js';
import {
  clearSessionCookie,
  officeAuthState,
  sessionFromRequest,
  setSessionCookie,
  setupInstructions,
  signSession,
  verifyPassword,
} from './_officeAuth.js';
import {
  OfficeApiError,
  assertAgentCapacity,
  audit,
  captureRoomArchive,
  getCachedOverview,
  invalidateOfficeOverview,
  mcpGrantCount,
  noteAgentTask,
  officeStore,
  roomSummaries,
  seatAgents,
  storageConfigured,
  sweepAutoCloseRooms,
} from './_office.js';

export const maxDuration = 60;

const OWNER: OfficeAuditEntry['actor'] = { name: 'owner', kind: 'owner' };
const WEB: { name: string; client: ClientKind } = { name: 'owner', client: 'web' };

const WRITE_ACTIONS = new Set([
  'login', 'logout',
  'agents.save', 'agents.delete', 'agents.pause', 'agents.resume',
  'projects.save', 'projects.delete', 'projects.memory.add', 'projects.memory.update', 'projects.memory.delete',
  'projects.guideline.add', 'projects.guideline.update', 'projects.guideline.delete', 'projects.link',
  'tasks.pause', 'tasks.resume', 'tasks.abort', 'tasks.approve', 'tasks.reject', 'tasks.retry', 'tasks.qa', 'tasks.requestApproval',
  'archives.capture', 'archives.delete',
  'rooms.end', 'rooms.delete', 'rooms.handoff',
  'templates.save', 'templates.delete', 'templates.apply',
  'settings.save',
  'backup.restore',
]);

function str(value: unknown, max = 500): string {
  return typeof value === 'string' ? value.trim().slice(0, max) : '';
}
function num(value: unknown): number | undefined {
  const n = Number(value);
  return Number.isFinite(n) ? n : undefined;
}
function bool(value: unknown): boolean {
  return value === true || value === 'true' || value === 1;
}
function stringList(value: unknown, max = 50): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === 'string' && item.trim().length > 0)
    .map(item => item.trim().slice(0, 120)).slice(0, max);
}

function send(res: VercelResponse, status: number, payload: unknown): void {
  res.status(status).json(payload);
}

function fail(res: VercelResponse, error: unknown): void {
  if (error instanceof OfficeApiError) {
    send(res, error.status, { error: error.code, message: error.message });
    return;
  }
  if (error instanceof OfficeInputError) {
    send(res, 400, { error: 'invalid_input', field: error.field, message: error.message });
    return;
  }
  if (error instanceof OfficeBackupError) {
    send(res, error.status, { error: error.code, message: error.message });
    return;
  }
  const name = (error as { name?: string }).name ?? '';
  const message = error instanceof Error ? error.message : 'The office request failed.';
  switch (name) {
    case 'RoomNotFoundError':
      send(res, 404, { error: 'room_not_found', message: 'That room no longer exists (rooms expire 30 days after creation).' });
      return;
    case 'RoomCodeTakenError':
      send(res, 409, { error: 'room_code_taken', message });
      return;
    case 'TaskNotFoundError':
    case 'TaskExistsError':
      send(res, 404, { error: 'task_not_found', message });
      return;
    case 'TaskStateError':
    case 'TaskDoneImmutableError':
    case 'EvidenceIncompleteError':
    case 'NotVerifierError':
    case 'OwnerCannotVerifyError':
    case 'VerifierCannotClaimError':
    case 'TaskExecutionError':
      send(res, 409, { error: 'task_conflict', message });
      return;
    case 'UpstashError':
    case 'NetworkError':
    case 'RateLimitError':
      send(res, 503, { error: 'storage_unavailable', message: 'Office storage is unavailable. Try again shortly.' });
      return;
    default:
      send(res, 400, { error: 'office_error', message });
  }
}

function requireCode(body: Record<string, unknown>): string {
  const code = str(body.code, 20).toUpperCase();
  if (!isValidCode(code)) throw new OfficeInputError('A valid room code is required.', 'code');
  return code;
}

function requireId(body: Record<string, unknown>, field = 'id'): string {
  const id = str(body[field], 60);
  if (!id) throw new OfficeInputError(`Missing ${field}.`, field);
  return id;
}

async function pushBoardNotification(store: Parameters<typeof office.getTaskBoard>[0], code: string): Promise<void> {
  // The dashboard has no listen loop; publishing the board's notification
  // intent is what tells the assigned agent something changed.
  await office.publishTaskNotifications(store, code).catch(() => undefined);
}

// ─── Handlers ─────────────────────────────────────────────────────────────

async function handleStatus(req: VercelRequest, res: VercelResponse, store: ReturnType<typeof officeStore> | null): Promise<void> {
  const state = officeAuthState();
  const session = sessionFromRequest(req);
  const payload: Record<string, unknown> = {
    configured: state.configured,
    authenticated: Boolean(session),
    needsSetup: !state.configured,
    weakPassword: state.weakPassword,
    usingSessionSecret: state.usingSessionSecret,
    siteUrl: siteUrl(),
  };
  if (!state.configured) payload.setup = setupInstructions(state);
  if (session && store) {
    const [counts, usage] = await Promise.all([
      Promise.all([office.listAgents(store), office.listProjects(store), office.listTemplates(store), office.listArchives(store, 1)]),
      office.getOfficeSettings(store),
    ]);
    payload.counts = {
      agents: counts[0].length,
      projects: counts[1].length,
      templates: counts[2].length,
      archives: counts[3].length,
    };
    payload.settings = usage;
    payload.integrations = { redis: true, storage: storageConfigured(), mcpGrants: mcpGrantCount() };
  }
  send(res, 200, payload);
}

async function handleLogin(req: VercelRequest, res: VercelResponse, store: ReturnType<typeof officeStore>): Promise<void> {
  const state = officeAuthState();
  if (!state.configured) {
    send(res, 503, {
      error: 'admin_not_configured',
      message: 'Set ADMIN_PASSWORD on the deployment before signing in.',
      setup: setupInstructions(state),
    });
    return;
  }
  const ip = req.headers['x-vercel-forwarded-for'] ?? req.socket?.remoteAddress ?? 'unknown';
  const address = String(ip);
  if (!await withinRateLimit(store, `office-login:${digest(address)}`, 10)) {
    res.setHeader('Retry-After', '60');
    send(res, 429, { error: 'rate_limited', message: 'Too many sign-in attempts. Wait a minute.' });
    return;
  }
  // The fifteen-minute guard sits behind the minute limiter: the first stops a
  // script, the second stops a patient one. Both answer with how long to wait,
  // and the lockout is audited once per attempt so the boss can see it happen.
  const guard = await loginGuardState(store, address);
  if (!guard.allowed) {
    res.setHeader('Retry-After', String(guard.retryAfterSeconds));
    await audit(store, { name: 'unknown', kind: 'system' }, 'login.locked', {
      detail: `${guard.lockedBy ?? 'ip'} lock, ${guard.failures} failures from this address`,
    });
    send(res, 429, {
      error: 'login_locked',
      message: guard.lockedBy === 'global'
        ? 'Sign-in is paused after too many failed attempts in the last 15 minutes. Try again later.'
        : 'Too many failed attempts from this address. Try again in 15 minutes.',
      retryAfterSeconds: guard.retryAfterSeconds,
    });
    return;
  }
  if (!verifyPassword(req.body?.password)) {
    const after = await recordLoginFailure(store, address);
    await audit(store, { name: 'unknown', kind: 'system' }, 'login.failed', {
      // A digest, not the address: enough to tell attempts apart, not enough to
      // keep a visitor's IP in office history.
      detail: `${digest(address).slice(0, 12)} (${after.failures}/${5} this window)`,
    });
    send(res, 401, { error: 'invalid_password', message: 'That password does not match ADMIN_PASSWORD.' });
    return;
  }
  const token = signSession();
  if (!token) {
    send(res, 503, { error: 'admin_not_configured', message: 'Set ADMIN_PASSWORD before signing in.' });
    return;
  }
  setSessionCookie(req, res, token);
  await clearLoginFailures(store, address);
  await audit(store, OWNER, 'login', { detail: state.weakPassword ? 'weak password' : undefined });
  send(res, 200, { authenticated: true, expiresInSeconds: 12 * 60 * 60 });
}

async function handleAgents(store: ReturnType<typeof officeStore>, action: string, body: Record<string, unknown>, res: VercelResponse): Promise<void> {
  if (action === 'agents.list') {
    const agents = await office.listAgents(store);
    send(res, 200, { agents });
    return;
  }
  if (action === 'agents.save') {
    const input = body.agent as Record<string, unknown> | undefined;
    const normalized = normalizeAgentInput(input ?? {});
    const existing = input && typeof input.id === 'string' ? await office.getAgent(store, str(input.id)) : null;
    if (input && typeof input.id === 'string' && !existing) throw new OfficeApiError('That AI staff member no longer exists.', 404, 'agent_not_found');
    const agent = await office.upsertAgent(store, {
      ...(existing ? { id: existing.id } : {}),
      ...normalized,
    }, 'owner', Date.now());
    await audit(store, OWNER, existing ? 'agent.update' : 'agent.create', { target: agent.id, detail: agent.name });
    // The manual row mirrors the roster (role, tags, daily limit, brief, active);
    // the fields a person writes by hand are never touched by this.
    syncEvent(store, { kind: 'staff.mirror', agent });
    send(res, 200, { agent });
    return;
  }
  if (action === 'agents.delete') {
    const id = requireId(body);
    const removed = await office.deleteAgent(store, id);
    if (!removed) throw new OfficeApiError('That AI staff member no longer exists.', 404, 'agent_not_found');
    await audit(store, OWNER, 'agent.delete', { target: id });
    send(res, 200, { removed: true });
    return;
  }
  if (action === 'agents.pause' || action === 'agents.resume') {
    const id = requireId(body);
    const existing = await office.getAgent(store, id);
    if (!existing) throw new OfficeApiError('That AI staff member no longer exists.', 404, 'agent_not_found');
    const paused = action === 'agents.pause';
    const agent = await office.upsertAgent(store, { ...existing, paused }, 'owner', Date.now());
    await audit(store, OWNER, paused ? 'agent.pause' : 'agent.resume', { target: agent.id, detail: agent.name });
    syncEvent(store, { kind: 'staff.mirror', agent });
    send(res, 200, { agent });
    return;
  }
  throw new OfficeApiError(`Unknown agents action ${action}.`, 400, 'bad_request');
}

async function handleProjects(store: ReturnType<typeof officeStore>, action: string, body: Record<string, unknown>, res: VercelResponse): Promise<void> {
  const now = Date.now();
  if (action === 'projects.list') {
    const projects = await office.listProjects(store);
    send(res, 200, { projects });
    return;
  }
  if (action === 'projects.get') {
    const project = await office.getProject(store, requireId(body));
    if (!project) throw new OfficeApiError('That project no longer exists.', 404, 'project_not_found');
    send(res, 200, { project });
    return;
  }
  if (action === 'projects.save') {
    const input = (body.project ?? body) as Record<string, unknown>;
    const normalized = normalizeProjectInput(input);
    const id = typeof input.id === 'string' ? str(input.id) : '';
    if (id) {
      const existing = await office.getProject(store, id);
      if (!existing) throw new OfficeApiError('That project no longer exists.', 404, 'project_not_found');
      const project = await office.mutateProject(store, id, current => ({
        ...current,
        ...normalized,
        agentIds: input.agentIds !== undefined ? stringList(input.agentIds) : current.agentIds,
        roomCodes: input.roomCodes !== undefined ? stringList(input.roomCodes) : current.roomCodes,
        updatedAt: now,
      }));
      await audit(store, OWNER, 'project.update', { target: project.id, detail: project.name });
      syncEvent(store, { kind: 'project.upsert', project });
      send(res, 200, { project });
      return;
    }
    const project = await office.createProject(store, {
      ...normalized,
      ...(input.agentIds !== undefined ? { agentIds: stringList(input.agentIds) } : {}),
      ...(input.roomCodes !== undefined ? { roomCodes: stringList(input.roomCodes) } : {}),
    }, 'owner', now);
    await audit(store, OWNER, 'project.create', { target: project.id, detail: project.name });
    syncEvent(store, { kind: 'project.upsert', project });
    send(res, 200, { project });
    return;
  }
  if (action === 'projects.delete') {
    const id = requireId(body);
    const removed = await office.deleteProject(store, id);
    if (!removed) throw new OfficeApiError('That project no longer exists.', 404, 'project_not_found');
    await audit(store, OWNER, 'project.delete', { target: id });
    // The Notion row is kept and marked 보관 — the knowledge it points at must
    // outlive the project (§6.5).
    syncEvent(store, { kind: 'project.deleted', projectId: id });
    send(res, 200, { removed: true });
    return;
  }
  if (action.startsWith('projects.memory.')) {
    const projectId = requireId(body, 'projectId');
    const now2 = Date.now();
    if (action === 'projects.memory.add') {
      const input = normalizeMemoryInput(body.memory ?? body);
      const { project, entry } = await office.addProjectMemory(store, projectId, input, 'owner', now2);
      await audit(store, OWNER, 'project.memory.add', { target: projectId, detail: entry.title });
      // A memory entry is knowledge: the same text becomes a 지식 베이스 row, so
      // the AI staff can find it through knowledge_search without a room.
      syncEvent(store, { kind: 'memory.upsert', project, entry });
      send(res, 200, { project, entry });
      return;
    }
    const memoryId = requireId(body, 'memoryId');
    if (action === 'projects.memory.update') {
      const input = normalizeMemoryInput(body.memory ?? body);
      const project = await office.updateProjectMemory(store, projectId, memoryId, input, 'owner', now2);
      await audit(store, OWNER, 'project.memory.update', { target: projectId, detail: memoryId });
      const entry = project.memory.find(item => item.id === memoryId);
      if (entry) syncEvent(store, { kind: 'memory.upsert', project, entry });
      send(res, 200, { project });
      return;
    }
    if (action === 'projects.memory.delete') {
      const project = await office.deleteProjectMemory(store, projectId, memoryId, now2);
      await audit(store, OWNER, 'project.memory.delete', { target: projectId, detail: memoryId });
      send(res, 200, { project });
      return;
    }
  }
  if (action.startsWith('projects.guideline.')) {
    const projectId = requireId(body, 'projectId');
    const now2 = Date.now();
    if (action === 'projects.guideline.add') {
      const { project, guideline } = await office.addProjectGuideline(store, projectId, normalizeGuidelineInput(body.guideline ?? body), 'owner', now2);
      await audit(store, OWNER, 'project.guideline.add', { target: projectId, detail: guideline.title });
      send(res, 200, { project, guideline });
      return;
    }
    const guidelineId = requireId(body, 'guidelineId');
    if (action === 'projects.guideline.update') {
      const project = await office.updateProjectGuideline(store, projectId, guidelineId, normalizeGuidelineInput(body.guideline ?? body), 'owner', now2);
      await audit(store, OWNER, 'project.guideline.update', { target: projectId, detail: guidelineId });
      send(res, 200, { project });
      return;
    }
    if (action === 'projects.guideline.delete') {
      const project = await office.deleteProjectGuideline(store, projectId, guidelineId, now2);
      await audit(store, OWNER, 'project.guideline.delete', { target: projectId, detail: guidelineId });
      send(res, 200, { project });
      return;
    }
  }
  if (action === 'projects.link') {
    const projectId = requireId(body, 'projectId');
    const code = body.code === undefined ? undefined : requireCode(body);
    const taskId = str(body.taskId, 20);
    const project = await office.linkProjectWork(store, projectId, {
      ...(code ? { roomCode: code } : {}),
      ...(code && taskId ? { taskRef: { code, id: taskId } } : {}),
      ...(typeof body.fileId === 'string' && body.fileId ? { fileId: str(body.fileId, 60) } : {}),
    }, now);
    await audit(store, OWNER, 'project.link', { target: projectId, ...(code ? { roomCode: code } : {}) });
    send(res, 200, { project });
    return;
  }
  throw new OfficeApiError(`Unknown projects action ${action}.`, 400, 'bad_request');
}

async function handleTasks(store: ReturnType<typeof officeStore>, action: string, body: Record<string, unknown>, res: VercelResponse): Promise<void> {
  const code = requireCode(body);
  const id = requireId(body);
  const now = Date.now();
  const reason = str(body.reason ?? body.note, 1000);
  switch (action) {
    case 'tasks.pause': {
      const result = await office.pauseTask(store, code, id, WEB, reason, now);
      await audit(store, OWNER, 'task.pause', { target: id, roomCode: code, detail: reason || undefined });
      await pushBoardNotification(store, code);
      send(res, 200, { task: result.task, board: result.board });
      return;
    }
    case 'tasks.resume': {
      const result = await office.unpauseTask(store, code, id, WEB, now);
      await audit(store, OWNER, 'task.resume', { target: id, roomCode: code });
      await pushBoardNotification(store, code);
      send(res, 200, { task: result.task, board: result.board });
      return;
    }
    case 'tasks.abort': {
      const result = await office.abortTask(store, code, id, WEB, reason, now);
      await audit(store, OWNER, 'task.abort', { target: id, roomCode: code, detail: reason || undefined });
      await pushBoardNotification(store, code);
      send(res, 200, { task: result.task, board: result.board });
      return;
    }
    case 'tasks.approve':
    case 'tasks.reject': {
      const decision = action === 'tasks.approve' ? 'approved' as const : 'rejected' as const;
      const result = await office.decideTaskApproval(store, code, id, decision, WEB, reason, now);
      await audit(store, OWNER, decision === 'approved' ? 'task.approve' : 'task.reject', {
        target: id, roomCode: code, detail: reason || undefined,
      });
      if (decision === 'approved') {
        // Capacity was checked at request time; approval is the moment work is
        // actually released, so both the count and the owner check happen here.
        if (result.task.owner) {
          try { await assertAgentCapacity(store, result.task.owner, now); } catch (error) {
            await audit(store, OWNER, 'task.approve.capacity_warning', { target: id, roomCode: code, detail: (error as Error).message });
          }
        }
        await pushBoardNotification(store, code);
      }
      send(res, 200, { task: result.task, board: result.board });
      return;
    }
    case 'tasks.requestApproval': {
      const result = await office.requireTaskApproval(store, code, id, WEB, reason, now);
      await audit(store, OWNER, 'task.request_approval', { target: id, roomCode: code, detail: reason || undefined });
      send(res, 200, { task: result.task, board: result.board });
      return;
    }
    case 'tasks.retry': {
      const target = str(body.to, 80);
      const settings = await office.getOfficeSettings(store);
      const result = await office.retryTask(store, code, id, WEB, {
        reason,
        ...(target ? { to: target } : {}),
        maxRetries: num(body.maxRetries) ?? settings.autoRetryLimit,
      }, now);
      await audit(store, OWNER, target ? 'task.handoff' : 'task.retry', { target: id, roomCode: code, detail: target || reason || undefined });
      if (result.task.owner && !target) await noteAgentTask(store, result.task.owner, now);
      await pushBoardNotification(store, code);
      send(res, 200, { task: result.task, board: result.board });
      return;
    }
    case 'tasks.qa': {
      const status = str(body.status, 20);
      if (!['pending', 'passed', 'failed'].includes(status)) throw new OfficeInputError('QA status must be pending, passed or failed.', 'status');
      const reviewer = str(body.reviewer, 80) || 'owner';
      const result = await office.recordTaskQa(store, code, id, { name: reviewer, client: reviewer === 'owner' ? 'web' : 'cc' },
        status as 'pending' | 'passed' | 'failed', reason, now);
      await audit(store, OWNER, 'task.qa', { target: id, roomCode: code, detail: `${reviewer}: ${status}` });
      send(res, 200, { task: result.task, board: result.board });
      return;
    }
    default:
      throw new OfficeApiError(`Unknown tasks action ${action}.`, 400, 'bad_request');
  }
}

/**
 * Room lifecycle for a room nobody can host any more.
 *
 * A room is normally ended by its host with the hostKey `room_create` returned.
 * Rooms opened from the office side (`templates.apply`) or by an agent that
 * misread its brief have no such key in any client — the server keeps only its
 * hash — so neither `room_end` nor the room UI can close them. The office owner
 * can: `rooms.end` closes the room and archives its minutes, `rooms.delete`
 * ends it without an archive and drops the room's data so it leaves the
 * dashboard instead of sitting there as an empty ended room.
 */
async function handleRooms(store: ReturnType<typeof officeStore>, action: string, body: Record<string, unknown>, res: VercelResponse): Promise<void> {
  if (action !== 'rooms.end' && action !== 'rooms.delete' && action !== 'rooms.handoff') {
    throw new OfficeApiError(`Unknown rooms action ${action}.`, 400, 'bad_request');
  }
  const code = requireCode(body);
  const room = await office.getRoom(store, code).catch(() => undefined);
  if (!room) throw new OfficeApiError(`No room ${code} (rooms expire 30 days after creation).`, 404, 'room_not_found');
  if (action === 'rooms.handoff') {
    // The successor is opened, the open cards are recreated with their ids, the
    // note explains where they came from, and the source is archived. Ending
    // the source is a separate, explicit choice (`endSource`).
    const result = await handoffRoom(store, code, OWNER, {
      ...(str(body.ownerName, 80) ? { ownerName: str(body.ownerName, 80) } : {}),
      endSource: bool(body.endSource),
    });
    send(res, 200, result);
    return;
  }
  const messages = await office.listMessages(store, code, 0).catch(() => []);
  const summary = {
    code, topic: room.topic, createdBy: room.createdBy, status: room.status,
    participants: room.participants.length, messages: messages.length,
  };
  if (action === 'rooms.end') {
    const ended = room.status === 'active' ? await office.endRoom(store, code) : room;
    // Best-effort, exactly as the room UI treats it: ending must not fail
    // because the archive is unavailable.
    await captureRoomArchive(store, code, OWNER).catch(() => undefined);
    // A scheduled auto-close on a room that is already over is a plan that
    // would fire on nothing; the sweep would tidy it later, but tidying it here
    // keeps the room document honest for whoever reads it next.
    await office.clearRoomAutoClose(store, code).catch(() => false);
    await audit(store, OWNER, 'room.end', { roomCode: code, detail: room.topic.slice(0, 120) });
    send(res, 200, { room: { ...summary, status: ended.status, endedAt: ended.endedAt } });
    return;
  }
  // Deliverables are meant to outlive their room, so deleting a room that
  // produced any archives them first: the room and then the transcript go, the
  // files and their index stay. Deleting the minutes of a room that produced
  // work is not something "delete the room" was ever asking for.
  const deliverables = await office.listVaultFiles(store, 'deliverable', code).catch(() => []);
  const archived = deliverables.length > 0
    ? await captureRoomArchive(store, code, OWNER).catch(() => null)
    : null;
  await office.unregisterBoardRoom(store, code);
  await office.unregisterOfficeRoom(store, code);
  await office.deleteRoomData(store, code);
  await audit(store, OWNER, 'room.delete', {
    roomCode: code,
    detail: `${room.topic.slice(0, 100)} · ${messages.length} messages discarded`
      + (archived ? ` · ${deliverables.length} deliverables kept in archive ${archived.id}` : ''),
  });
  send(res, 200, { deleted: true, ...summary, ...(archived ? { archiveId: archived.id, keptDeliverables: deliverables.length } : {}) });
}

async function handleArchives(store: ReturnType<typeof officeStore>, action: string, body: Record<string, unknown>, res: VercelResponse): Promise<void> {
  if (action === 'archives.list') {
    const query = str(body.query, 200);
    const archives = query
      ? await office.searchArchives(store, query, num(body.limit) ?? 50)
      : await office.listArchives(store, num(body.limit) ?? 50);
    send(res, 200, {
      archives: archives.map(archive => ({
        id: archive.id, roomCode: archive.roomCode, topic: archive.topic,
        archivedAt: archive.archivedAt, summary: archive.summary,
        messageCount: archive.messageCount, participants: archive.participants,
        tags: archive.tags, projectId: archive.projectId,
        deliverableCount: archive.deliverables?.length ?? 0,
        ...(archive.successorRoomCode ? { successorRoomCode: archive.successorRoomCode } : {}),
        snippet: query ? archiveSnippet(archive, query) : archive.summary,
        matched: query ? archiveMatches(archive, query) : true,
      })),
      query,
    });
    return;
  }
  if (action === 'archives.get') {
    const id = requireId(body);
    const archive = await office.getArchive(store, id);
    if (!archive) throw new OfficeApiError('That archive no longer exists.', 404, 'archive_not_found');
    await audit(store, OWNER, 'archive.read', { target: id });
    send(res, 200, { archive });
    return;
  }
  if (action === 'archives.capture') {
    const code = requireCode(body);
    const result = await captureRoomArchive(store, code, OWNER);
    send(res, 200, result);
    return;
  }
  if (action === 'archives.delete') {
    const id = requireId(body);
    const removed = await office.deleteArchive(store, id);
    if (!removed) throw new OfficeApiError('That archive no longer exists.', 404, 'archive_not_found');
    await audit(store, OWNER, 'archive.delete', { target: id });
    send(res, 200, { removed: true });
    return;
  }
  throw new OfficeApiError(`Unknown archives action ${action}.`, 400, 'bad_request');
}

async function handleTemplates(store: ReturnType<typeof officeStore>, action: string, body: Record<string, unknown>, res: VercelResponse): Promise<void> {
  const now = Date.now();
  if (action === 'templates.list') {
    send(res, 200, { templates: await office.listTemplates(store) });
    return;
  }
  if (action === 'templates.save') {
    const input = (body.template ?? body) as Record<string, unknown>;
    const normalized = normalizeTemplateInput(input);
    const id = typeof input.id === 'string' ? str(input.id) : '';
    const template = id
      ? await office.updateTemplate(store, id, normalized, now)
      : await office.createTemplate(store, normalized, 'owner', now);
    await audit(store, OWNER, id ? 'template.update' : 'template.create', { target: template.id, detail: template.name });
    send(res, 200, { template });
    return;
  }
  if (action === 'templates.delete') {
    const id = requireId(body);
    const removed = await office.deleteTemplate(store, id);
    if (!removed) throw new OfficeApiError('That template no longer exists.', 404, 'template_not_found');
    await audit(store, OWNER, 'template.delete', { target: id });
    send(res, 200, { removed: true });
    return;
  }
  if (action === 'templates.apply') {
    const id = requireId(body);
    const template = await office.getTemplate(store, id);
    if (!template) throw new OfficeApiError('That template no longer exists.', 404, 'template_not_found');
    const [agents, settings] = await Promise.all([office.listAgents(store), office.getOfficeSettings(store)]);
    const load = await office.readAgentUsage(store, kstDay(now), agents.map(agent => agent.id));
    const plan = planTemplateRun(template, agents, load);

    // Open the room first. A room code is generated locally and retried on the
    // rare collision, exactly as room_create does.
    const client = createRemoteRoomClient(undefined);
    let code = '';
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const candidate = generateCode();
      if (attempt > 0 && !isValidCode(candidate)) continue;
      try {
        await office.createRoom(client.store, {
          code: candidate, createdBy: str(body.ownerName, 80) || 'Owner', topic: template.topic || template.name, requireUnusedCode: true,
        });
        code = candidate;
        break;
      } catch (error) {
        if ((error as { name?: string }).name === 'RoomCodeTakenError') continue;
        throw error;
      }
    }
    if (!code) throw new OfficeApiError('Could not allocate a room code. Try again.', 503, 'room_code_unavailable');

    // Task roles are validated against the room roster, so the staff the
    // template assigns must be seated before their tasks are created.
    const assignedAgents = plan
      .map(row => agents.find(agent => agent.id === row.agentId))
      .filter((agent): agent is (typeof agents)[number] => Boolean(agent));
    const seated = await seatAgents(client.store, code, assignedAgents, now);

    const created: Task[] = [];
    const skipped: string[] = [];
    for (const [index, task] of template.tasks.entries()) {
      const assignment = plan[index]!;
      const ownerName = assignment.agentName;
      try {
        const result = await office.createTask(client.store, code, {
          title: task.title,
          dod: task.dod,
          createdBy: str(body.ownerName, 80) || 'Owner',
          ...(ownerName ? { owner: ownerName, ownerClient: 'cc' as ClientKind } : task.owner ? { owner: task.owner, ownerClient: 'cc' as ClientKind } : {}),
          ...(task.verifier ? { verifier: task.verifier, verifierClient: 'cc' as ClientKind } : {}),
          ...(task.requiresApproval || assignment.requiresApproval ? { requiresApproval: true } : {}),
          ...(template.projectId ? { projectId: template.projectId } : {}),
          templateId: template.id,
        }, now);
        created.push(result.task);
        if (ownerName) await noteAgentTask(store, ownerName, now);
      } catch (error) {
        skipped.push(`${task.title} (${(error as Error).message})`);
      }
    }
    await office.registerOfficeRoom(store, code, { projectId: template.projectId, templateId: template.id, at: now });
    if (template.projectId) {
      await office.linkProjectWork(store, template.projectId, { roomCode: code }, now).catch(() => undefined);
    }
    if (template.guidelines) {
      await office.appendSystemMessage(client.store, code, {
        id: Date.now(), name: 'Office', role: 'system', color: 'gray', initials: 'OF', client: 'web',
        type: 'msg', text: `[GUIDELINES] ${template.guidelines}`, time: now,
      }).catch(() => undefined);
    }
    await audit(store, OWNER, 'template.apply', {
      target: template.id, roomCode: code,
      detail: `${created.length} tasks, ${settings.autoRetryLimit} retries allowed`,
    });
    send(res, 200, {
      roomCode: code,
      joinUrl: `${siteUrl()}/j/${code}`,
      roomUrl: `${siteUrl()}/r/${code}`,
      tasks: created,
      skipped,
      plan,
      seated,
    });
    return;
  }
  throw new OfficeApiError(`Unknown templates action ${action}.`, 400, 'bad_request');
}

async function handleBackup(store: ReturnType<typeof officeStore>, action: string, body: Record<string, unknown>, res: VercelResponse): Promise<void> {
  const now = Date.now();
  if (action === 'backup.export') {
    const boards: Record<string, TaskBoard> = {};
    if (bool(body.includeBoards)) {
      for (const code of (await office.listBoardRooms(store)).slice(0, 50)) {
        const board = await office.getTaskBoard(store, code).catch(() => null);
        if (board) boards[code] = board;
      }
    }
    const backup = await office.exportOffice(store, 'owner', now, bool(body.includeBoards) ? boards : undefined);
    await audit(store, OWNER, 'backup.export', { detail: `${backup.agents.length} agents, ${backup.projects.length} projects` });
    send(res, 200, { backup });
    return;
  }
  if (action === 'backup.verify') {
    // The preview: shape, version, digest and counts, with no write at all. The
    // dashboard shows this before the restore button becomes meaningful.
    const backup = body.backup;
    if (!backup || typeof backup !== 'object') throw new OfficeInputError('Send the backup file as `backup`.', 'backup');
    const validation = office.validateOfficeBackup(backup);
    send(res, 200, validation);
    return;
  }
  if (action === 'backup.snapshots') {
    send(res, 200, { snapshots: await office.listBackupSnapshots(store) });
    return;
  }
  if (action === 'backup.restore') {
    const backup = body.backup as Record<string, unknown> | undefined;
    if (!backup || typeof backup !== 'object') throw new OfficeInputError('Send the backup file as `backup`.', 'backup');
    if (JSON.stringify(backup).length > 4_000_000) throw new OfficeInputError('That backup is larger than one request can restore (4 MB).', 'backup');
    const mode = str(body.mode, 10) === 'replace' ? 'replace' as const : 'merge' as const;
    const dryRun = bool(body.dryRun);
    const result = await office.importOffice(
      store,
      backup as Parameters<typeof office.importOffice>[1],
      mode,
      now,
      { dryRun, allowChecksumMismatch: bool(body.allowChecksumMismatch), actor: 'owner' },
    );
    if (!dryRun) {
      await audit(store, OWNER, 'backup.restore', {
        detail: `${mode}: ${result.agents} agents, ${result.projects} projects, ${result.archives} archives`
          + `${result.snapshotId ? ` · snapshot ${result.snapshotId}` : ''}`
          + `${result.checksum ? ` · checksum ${result.checksum}` : ''}`,
      });
    }
    send(res, 200, { restored: result, mode, dryRun });
    return;
  }
  throw new OfficeApiError(`Unknown backup action ${action}.`, 400, 'bad_request');
}

/**
 * The permanent deliverables vault, read from the archive index.
 *
 * Deliverable bytes live under a prefix room cleanup never touches and their
 * records carry no TTL, so the files survive the room — but the room's own
 * vault keys do not, and that is where a reader used to find them. This is the
 * index that outlives the room: it is built from the archives, and every entry
 * gets a fresh signed download link (the `/api/files` token path checks the file
 * record, not the room).
 */
async function handleDeliverables(store: ReturnType<typeof officeStore>, action: string, body: Record<string, unknown>, res: VercelResponse): Promise<void> {
  if (action !== 'deliverables.list') throw new OfficeApiError(`Unknown deliverables action ${action}.`, 400, 'bad_request');
  const archiveId = str(body.archiveId, 60);
  const roomCode = str(body.code, 20).toUpperCase();
  const query = str(body.query, 120).toLowerCase();
  const limit = Math.max(1, Math.min(200, num(body.limit) ?? 200));
  const archives = archiveId
    ? [await office.getArchive(store, archiveId)].filter((archive): archive is NonNullable<typeof archive> => Boolean(archive))
    : await office.listArchives(store, 200);
  const files: Array<Record<string, unknown>> = [];
  for (const archive of archives) {
    if (roomCode && archive.roomCode !== roomCode) continue;
    for (const file of archive.deliverables ?? []) {
      const haystack = `${file.name} ${file.producer ?? ''} ${file.taskId ?? ''} ${archive.topic}`.toLowerCase();
      if (query && !haystack.includes(query)) continue;
      const token = signVaultToken({ c: archive.roomCode, k: 'deliverable', f: file.id, ttlMs: 60 * 60_000 });
      files.push({
        archiveId: archive.id,
        roomCode: archive.roomCode,
        topic: archive.topic,
        archivedAt: archive.archivedAt,
        ...file,
        downloadUrl: token
          ? `${siteUrl()}/api/files?token=${encodeURIComponent(token)}&name=${encodeURIComponent(file.name)}`
          : null,
      });
    }
  }
  files.sort((a, b) => Number(b.createdAt ?? 0) - Number(a.createdAt ?? 0));
  send(res, 200, { files: files.slice(0, limit), total: files.length });
}

async function handleUsage(store: ReturnType<typeof officeStore>, res: VercelResponse): Promise<void> {
  const [settings, usage, agents] = await Promise.all([
    office.getOfficeSettings(store), office.readUsage(store, kstDay(Date.now())), office.listAgents(store),
  ]);
  const perAgent = await office.readAgentUsage(store, kstDay(Date.now()), agents.map(agent => agent.id));
  send(res, 200, {
    settings,
    day: kstDay(Date.now()),
    requests: usage.requests,
    writes: usage.writes,
    requestBudget: settings.dailyRequestBudget,
    level: usageLevel(usage.requests, settings.dailyRequestBudget, settings.warnRatio),
    agents: agents.map(agent => ({
      id: agent.id,
      name: agent.name,
      tasksToday: perAgent[agent.id] ?? 0,
      limit: agent.dailyTaskLimit,
      paused: agent.paused,
      enabled: agent.enabled,
      level: usageLevel(perAgent[agent.id] ?? 0, agent.dailyTaskLimit, settings.warnRatio),
    })),
  });
}

// ─── Entry point ──────────────────────────────────────────────────────────

/**
 * Everything behind the session cookie, one branch per action.
 *
 * Kept out of the handler so the handler has exactly one thing to do after the
 * branches have run: a write changes what the dashboard would say, so today's
 * cached payload is dropped there rather than in twenty separate places.
 */
async function routeOffice(
  req: VercelRequest,
  res: VercelResponse,
  store: ReturnType<typeof officeStore>,
  action: string,
  body: Record<string, unknown>,
): Promise<void> {
  if (action === 'login') { await handleLogin(req, res, store); return; }
  if (action === 'logout') {
    clearSessionCookie(req, res);
    await audit(store, OWNER, 'logout');
    send(res, 200, { authenticated: false });
    return;
  }

  const state = officeAuthState();
  if (!state.configured) {
    send(res, 503, {
      error: 'admin_not_configured',
      message: 'The office is locked until ADMIN_PASSWORD is set on this deployment.',
      setup: setupInstructions(state),
    });
    return;
  }
  if (!sessionFromRequest(req)) {
    send(res, 401, { error: 'login_required', message: 'Sign in with the office password.' });
    return;
  }

  // Every authenticated call is counted, and writes separately, because the
  // dashboard's own polling is what the free tier's command budget pays for.
  if (WRITE_ACTIONS.has(action)) {
    // A write is the expensive, destructive half of this API: it is the one
    // worth a per-minute ceiling of its own. Sixty a minute is far above what
    // one person clicking a dashboard produces and far below what a script
    // that got hold of a session could use to burn the day's commands.
    const address = String(req.headers['x-vercel-forwarded-for'] ?? req.socket?.remoteAddress ?? 'unknown');
    if (!await withinRateLimit(store, `office-write:${digest(address)}`, 60)) {
      res.setHeader('Retry-After', '60');
      throw new OfficeApiError('Too many office changes in a minute. Wait a moment.', 429, 'rate_limited');
    }
    await office.bumpUsage(store, kstDay(Date.now()), 'writes').catch(() => 0);
  }
  await office.bumpUsage(store, kstDay(Date.now()), 'requests').catch(() => 0);

  if (action === 'overview') {
    // The poll is the deployment's most reliable clock: there is no daemon on
    // the free tier, and a room that finished its work has to close on a
    // deadline rather than on somebody remembering to press End. The sweep is
    // cheap when nothing is scheduled (one SMEMBERS) and bounded when things
    // are (three rooms at most), and it runs before the cache is read so a
    // close that just happened is not hidden behind a two-minute-old payload.
    const swept = await sweepAutoCloseRooms(store).catch(() => null);
    // `freshness: 'fresh'` is the boss asking again by hand (or straight after a
    // write): skip the cached copy, rebuild, and leave the new answer for the
    // polls. Anything else — including a client that sends nothing — reads
    // through the cache, which is the default because polling is the cost.
    const { overview, cache } = await getCachedOverview(store, {
      withoutRooms: bool(body.withoutRooms),
      ownerName: 'owner',
      fresh: str(body.freshness, 20) === 'fresh' || (swept?.closed ?? 0) > 0,
    });
    res.setHeader('X-Office-Cache', cache);
    send(res, 200, { overview });
    return;
  }
  if (action === 'rooms.list') {
    // Same tick as the overview: a room list read is a moment to close what is
    // due, so the list cannot show a room that should already be over.
    await sweepAutoCloseRooms(store).catch(() => undefined);
    send(res, 200, { rooms: await roomSummaries(store) });
    return;
  }
  if (action === 'rooms.end' || action === 'rooms.delete' || action === 'rooms.handoff') { await handleRooms(store, action, body, res); return; }
  if (action === 'audit.list') {
    // `body.action` is the router's opcode ("audit.list"); the log's action
    // filter is a separate field, or a `filter` object for convenience.
    const filter = (body.filter ?? {}) as Record<string, unknown>;
    const actionPrefix = str(body.filterAction) || str(filter.action);
    const entries = filterAudit(await office.readAudit(store, 500), {
      ...(str(body.actor) || str(filter.actor) ? { actor: str(body.actor) || str(filter.actor) } : {}),
      ...(actionPrefix ? { action: actionPrefix } : {}),
      ...(str(body.target) || str(filter.target) ? { target: str(body.target) || str(filter.target) } : {}),
      ...(str(body.roomCode) || str(filter.roomCode) ? { roomCode: str(body.roomCode) || str(filter.roomCode) } : {}),
      ...(num(body.from ?? filter.from) !== undefined ? { from: num(body.from ?? filter.from) } : {}),
      ...(num(body.to ?? filter.to) !== undefined ? { to: num(body.to ?? filter.to) } : {}),
      limit: num(body.limit ?? filter.limit) ?? 100,
    });
    send(res, 200, { entries });
    return;
  }
  if (action === 'settings.get') { send(res, 200, { settings: await office.getOfficeSettings(store) }); return; }
  if (action === 'settings.save') {
    const settings = await office.saveOfficeSettings(store, (body.settings ?? body) as Record<string, unknown>);
    await audit(store, OWNER, 'settings.save', { detail: `budget ${settings.dailyRequestBudget}` });
    send(res, 200, { settings });
    return;
  }
  if (action === 'settings.defaults') { send(res, 200, { settings: normalizeOfficeSettings({}) }); return; }
  if (action === 'usage.get') { await handleUsage(store, res); return; }
  if (action.startsWith('agents.')) { await handleAgents(store, action, body, res); return; }
  if (action.startsWith('projects.')) { await handleProjects(store, action, body, res); return; }
  if (action.startsWith('tasks.')) { await handleTasks(store, action, body, res); return; }
  if (action.startsWith('archives.')) { await handleArchives(store, action, body, res); return; }
  if (action.startsWith('deliverables.')) { await handleDeliverables(store, action, body, res); return; }
  if (action.startsWith('templates.')) { await handleTemplates(store, action, body, res); return; }
  if (action.startsWith('backup.')) { await handleBackup(store, action, body, res); return; }

  throw new OfficeApiError(`Unknown office action "${action}".`, 400, 'bad_request');
}

export default async function handler(req: VercelRequest, res: VercelResponse): Promise<void> {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  const queryAction = Array.isArray(req.query?.action) ? req.query.action[0] : req.query?.action;
  const action = str(req.method === 'GET' ? queryAction : req.body?.action, 60) || 'status';

  let store: ReturnType<typeof officeStore> | null = null;
  try {
    store = officeStore();
  } catch (error) {
    // Storage misconfigured: status can still explain the setup, everything
    // else must fail loudly rather than pretend to work.
    if (action !== 'status') { fail(res, error); return; }
  }

  try {
    if (action === 'status') {
      await handleStatus(req, res, store);
      return;
    }
    if (!store) throw new OfficeApiError('Office storage is not configured.', 503, 'not_configured');
    if (req.method !== 'POST') {
      res.setHeader('Allow', 'POST');
      send(res, 405, { error: 'method_not_allowed', message: 'POST { action } to use the office API.' });
      return;
    }
    const body = (req.body ?? {}) as Record<string, unknown>;

    await routeOffice(req, res, store, action, body);
    // The write has landed: drop today's cached dashboard so the next poll (and
    // not the poll after the TTL) shows it. A failed write threw above and kept
    // the cache, which is still an honest picture of the office.
    if (WRITE_ACTIONS.has(action)) await invalidateOfficeOverview(store);
  } catch (error) {
    fail(res, error);
  }
}
