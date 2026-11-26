// Server glue for the office: everything that needs Redis *and* the room layer
// lives here, so `api/office.ts` stays a router of small, auditable branches.
//
// Three jobs:
//   1. read the office's persistent collections plus a bounded set of live
//      boards and fold them into one dashboard payload,
//   2. capture a finished room into the permanent archive (called from room_end
//      and from the dashboard),
//   3. enforce the daily capacity rule on the paths that hand work to an agent.
import type { UpstashClient } from '@agent-room/upstash-client';
import {
  createClient,
  getRoom,
  joinRoom,
  getTaskBoard,
  listBoardRooms,
  listMessages,
  archiveRoom,
  bumpAgentTask,
  findAgentByName,
  listAgents,
  listArchives,
  listHeartbeats,
  listOfficeRooms,
  listProjects,
  listTemplates,
  readAgentUsage,
  readAudit,
  readUsage,
  getOfficeSettings,
  appendAuditSafe,
  auditEntry,
  agentCapacity,
  officeAgentUsageKey,
  registerOfficeRoom,
} from '@agent-room/upstash-client';
import type { Room, Task, TaskBoard } from '@agent-room/shared';
import { createBlobStore } from './_blobStore.js';
import {
  AVATAR_PALETTE,
  OFFICE_DEFAULT_SETTINGS,
  agentPresence,
  filterAudit,
  kstDay,
  usageLevel,
} from '@agent-room/shared';
import type {
  OfficeAgent,
  OfficeAgentView,
  OfficeAuditEntry,
  OfficeOverview,
  OfficeRoomSummary,
  OfficeTaskRef,
} from '@agent-room/shared';

/** How many rooms one dashboard request will walk. Bounded for cost, not vanity. */
export const OFFICE_OVERVIEW_ROOM_LIMIT = 24;

export class OfficeApiError extends Error {
  constructor(message: string, readonly status: number, readonly code: string) {
    super(message);
    this.name = 'OfficeApiError';
  }
}

export function officeStore(): UpstashClient {
  const url = process.env.UPSTASH_REDIS_REST_URL ?? process.env.KV_REST_API_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN ?? process.env.KV_REST_API_TOKEN;
  if (!url || !token) {
    throw new OfficeApiError(
      'Office storage is not configured. Set UPSTASH_REDIS_REST_URL and UPSTASH_REDIS_REST_TOKEN.',
      503,
      'not_configured',
    );
  }
  return createClient({ url, token });
}

export function storageConfigured(): boolean {
  try {
    return createBlobStore().ok;
  } catch {
    return false;
  }
}

export function mcpGrantCount(): number {
  const raw = process.env.MCP_GRANTS;
  if (!raw) return 0;
  try {
    const parsed = JSON.parse(raw) as unknown;
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? Object.keys(parsed).length : 0;
  } catch {
    return 0;
  }
}

export async function audit(
  store: UpstashClient,
  actor: OfficeAuditEntry['actor'],
  action: string,
  fields: Omit<OfficeAuditEntry, 'id' | 'at' | 'actor' | 'action'> & { at?: number } = {},
): Promise<void> {
  await appendAuditSafe(store, [auditEntry(actor, action, fields)]);
}

/** Every room the office knows about: boards first, then the office registry. */
export async function knownRoomCodes(store: UpstashClient): Promise<string[]> {
  const [boardRooms, officeRooms] = await Promise.all([
    listBoardRooms(store).catch(() => [] as string[]),
    listOfficeRooms(store).catch(() => [] as string[]),
  ]);
  return [...new Set([...boardRooms, ...officeRooms])].slice(0, OFFICE_OVERVIEW_ROOM_LIMIT * 2);
}

interface LoadedRoom {
  code: string;
  room?: Room;
  board?: TaskBoard;
}

async function loadRooms(store: UpstashClient, codes: string[]): Promise<LoadedRoom[]> {
  const rows = await Promise.all(codes.slice(0, OFFICE_OVERVIEW_ROOM_LIMIT).map(async code => {
    const [room, board] = await Promise.all([
      getRoom(store, code).catch(() => undefined),
      getTaskBoard(store, code).catch(() => null),
    ]);
    return { code, room, board: board ?? undefined } as LoadedRoom;
  }));
  return rows;
}

function taskRef(code: string, roomTopic: string, task: Task): OfficeTaskRef {
  return {
    code,
    roomTopic,
    id: task.id,
    title: task.title,
    state: task.state,
    ...(task.owner ? { owner: task.owner } : {}),
    ...(task.verifier ? { verifier: task.verifier } : {}),
    updatedAt: task.updatedAt,
    ...(task.approval?.required ? { requiresApproval: true } : {}),
    ...(typeof task.retryCount === 'number' ? { retryCount: task.retryCount } : {}),
    ...(task.qa ? { qaStatus: task.qa.status } : {}),
    ...(task.approval?.note ? { approvalNote: task.approval.note } : {}),
  };
}

/** True for states that still ask something of somebody. */
export function isOpenTask(task: Pick<Task, 'state'>): boolean {
  return task.state !== 'done' && task.state !== 'rejected' && task.state !== 'cancelled' && task.state !== 'aborted';
}

export interface OverviewOptions {
  /** Skip the live board walk (used by the setup screen and cheap polls). */
  withoutRooms?: boolean;
  ownerName?: string | null;
}

/**
 * The dashboard payload. One round of reads, no writes: a page that refreshes
 * every half minute must not be the reason the Redis quota runs out, so room
 * reads are capped and every collection is read once.
 */
export async function buildOverview(store: UpstashClient, options: OverviewOptions = {}): Promise<OfficeOverview> {
  const now = Date.now();
  const day = kstDay(now);
  const [settings, agents, projects, templates, archives, usage, auditRows, codes] = await Promise.all([
    getOfficeSettings(store),
    listAgents(store),
    listProjects(store),
    listTemplates(store),
    listArchives(store, 50),
    readUsage(store, day),
    readAudit(store, 40),
    options.withoutRooms ? Promise.resolve([] as string[]) : knownRoomCodes(store),
  ]);
  const loaded = options.withoutRooms ? [] : await loadRooms(store, codes);
  const heartbeats = await listHeartbeats(store, agents.map(agent => agent.name));
  const agentUsage = await readAgentUsage(store, day, agents.map(agent => agent.id));

  const rooms: OfficeRoomSummary[] = [];
  const openTaskRefs: OfficeTaskRef[] = [];
  const approvals: OfficeTaskRef[] = [];
  const qaQueue: OfficeTaskRef[] = [];
  const failed: OfficeTaskRef[] = [];
  const ownedByAgent = new Map<string, Array<{ code: string; id: string }>>();
  const reviewsByAgent = new Map<string, Array<{ code: string; id: string }>>();
  let openTasks = 0;
  let doneTasks = 0;

  for (const { code, room, board } of loaded) {
    if (!room) continue;
    if (room.status === 'ended' && !board) continue;
    const topic = room.topic || code;
    let roomOpen = 0;
    let roomDone = 0;
    let roomApprovals = 0;
    for (const task of board?.tasks ?? []) {
      const ref = taskRef(code, topic, task);
      if (task.state === 'pending_approval') { approvals.push(ref); roomApprovals += 1; openTasks += 1; continue; }
      if (task.state === 'done') { roomDone += 1; doneTasks += 1; continue; }
      if (isOpenTask(task)) {
        roomOpen += 1;
        openTasks += 1;
        openTaskRefs.push(ref);
      }
      if (task.state === 'awaiting_review' && task.verifier) {
        if (task.qa && task.qa.status === 'pending') qaQueue.push(ref);
        const list = reviewsByAgent.get(task.verifier.toLowerCase()) ?? [];
        list.push({ code, id: task.id });
        reviewsByAgent.set(task.verifier.toLowerCase(), list);
      }
      if (task.state === 'rejected') failed.push(ref);
      if (task.owner && (task.state === 'in_progress' || task.state === 'rejected')) {
        const list = ownedByAgent.get(task.owner.toLowerCase()) ?? [];
        list.push({ code, id: task.id });
        ownedByAgent.set(task.owner.toLowerCase(), list);
      }
    }
    rooms.push({
      code,
      topic,
      status: room.status,
      createdAt: room.createdAt,
      participants: room.participants.length,
      agents: room.participants.filter(p => p.client === 'cc').length,
      openTasks: roomOpen,
      doneTasks: roomDone,
      pendingApproval: roomApprovals,
    });
  }

  const agentViews: OfficeAgentView[] = agents.map(agent => {
    const heartbeat = heartbeats[agent.name.trim().toLowerCase()];
    const presence = agentPresence(agent, {
      ...(heartbeat ? { heartbeatAt: heartbeat.at } : {}),
      active: ownedByAgent.get(agent.name.toLowerCase()) ?? [],
      reviews: reviewsByAgent.get(agent.name.toLowerCase()) ?? [],
    }, now);
    const used = agentUsage[agent.id] ?? 0;
    return {
      ...agent,
      presence,
      tasksToday: used,
      remainingToday: agent.dailyTaskLimit > 0 ? Math.max(0, agent.dailyTaskLimit - used) : Number.POSITIVE_INFINITY,
    };
  });

  const onlineAgents = agentViews.filter(agent => agent.presence.status !== 'offline' && agent.presence.status !== 'paused').length;
  const requestLevel = usageLevel(usage.requests, settings.dailyRequestBudget, settings.warnRatio);
  const warnings: string[] = [];
  if (requestLevel !== 'ok') {
    warnings.push(`Office API usage today is at ${Math.round((usage.requests / Math.max(1, settings.dailyRequestBudget)) * 100)}% of the ${settings.dailyRequestBudget.toLocaleString()} request budget.`);
  }
  if (agentViews.some(agent => !agent.enabled)) warnings.push('Some AI staff are disabled and will not receive work.');
  if (approvals.length) warnings.push(`${approvals.length} task${approvals.length === 1 ? '' : 's'} waiting for approval.`);

  return {
    generatedAt: now,
    ownerName: options.ownerName ?? null,
    agents: agentViews,
    projects: projects.map(project => ({
      ...project,
      openTasks: project.taskRefs.length,
      memoryCount: project.memory.length,
      guidelineCount: project.guidelines.length,
    })),
    rooms: rooms.sort((a, b) => b.createdAt - a.createdAt),
    openTasks: openTaskRefs.sort((a, b) => a.updatedAt - b.updatedAt),
    approvals: approvals.sort((a, b) => a.updatedAt - b.updatedAt),
    qaQueue,
    failedTasks: failed,
    usage: {
      day,
      requests: usage.requests,
      writeRequests: usage.writes,
      requestBudget: settings.dailyRequestBudget,
      requestLevel,
      percent: Math.round((usage.requests / Math.max(1, settings.dailyRequestBudget)) * 100),
      agents: agentViews.map(agent => ({
        id: agent.id, name: agent.name, tasksToday: agent.tasksToday, limit: agent.dailyTaskLimit,
        level: usageLevel(agent.tasksToday, agent.dailyTaskLimit, settings.warnRatio),
      })),
      notes: [
        'Counts are this office API\'s own requests, not the Upstash plan dashboard — the free tier allows 10,000 commands/day and each dashboard refresh costs a handful.',
        `Agent task counters reset at midnight KST (${day}).`,
      ],
    },
    settings: settings ?? OFFICE_DEFAULT_SETTINGS,
    integrations: {
      redis: true,
      storage: storageConfigured(),
      mcpGrants: mcpGrantCount(),
      adminConfigured: Boolean(process.env.ADMIN_PASSWORD),
    },
    counts: {
      agents: agents.length,
      onlineAgents,
      projects: projects.filter(project => project.status === 'active').length,
      openTasks,
      pendingApproval: approvals.length,
      archivedMeetings: archives.length,
      templates: templates.length,
    },
    archives: archives.slice(0, 8).map(archive => ({
      id: archive.id, roomCode: archive.roomCode, topic: archive.topic,
      archivedAt: archive.archivedAt, summary: archive.summary,
    })),
    recentAudit: filterAudit(auditRows, { limit: 12 }),
    warnings,
  };
}

/**
 * Capture a room into the permanent archive. Called when a room ends and from
 * the dashboard's "archive now". Safe to call for a room that is still open —
 * the snapshot is a record of the moment, and re-capturing updates it.
 */
export async function captureRoomArchive(
  store: UpstashClient,
  code: string,
  actor: OfficeAuditEntry['actor'],
  now: number = Date.now(),
): Promise<{ id: string; roomCode: string; topic: string; messageCount: number }> {
  const room = await getRoom(store, code).catch(() => undefined);
  if (!room) throw new OfficeApiError(`No room ${code} to archive (rooms expire 30 days after creation).`, 404, 'room_not_found');
  const [messages, board] = await Promise.all([
    listMessages(store, code, 0).catch(() => []),
    getTaskBoard(store, code).catch(() => null),
  ]);
  const archive = await archiveRoom(store, { room, messages, board, now });
  await registerOfficeRoom(store, code, { projectId: archive.projectId, at: now });
  await audit(store, actor, 'meeting.archive', { target: archive.id, roomCode: code, detail: `${messages.length} messages`, at: now });
  return { id: archive.id, roomCode: code, topic: room.topic, messageCount: messages.length };
}

/**
 * Capacity gate used by the MCP task path.
 *
 * A registered agent over its daily limit (or paused/disabled) cannot be handed
 * new work. Unregistered names pass — the room layer still works without the
 * office, and turning every account into a quota would break existing rooms.
 */
export async function assertAgentCapacity(store: UpstashClient, name: string, now: number = Date.now()): Promise<void> {
  const trimmed = name?.trim();
  if (!trimmed) return;
  const agent = await findAgentByName(store, trimmed).catch(() => null);
  if (!agent) return;
  const capacity = await agentCapacity(store, kstDay(now), agent);
  if (!capacity.ok) throw new OfficeApiError(capacity.reason ?? `${agent.name} cannot take more work today.`, 429, 'agent_daily_limit');
}

/** Count a task against an agent's day. Best-effort: never fails the task write. */
export async function noteAgentTask(store: UpstashClient, name: string, now: number = Date.now()): Promise<void> {
  const trimmed = name?.trim();
  if (!trimmed) return;
  try {
    // Name index -> id, then one INCR: the write path must not walk the whole
    // roster every time a task is created.
    const agent = await findAgentByName(store, trimmed);
    if (!agent) return;
    await bumpAgentTask(store, kstDay(now), agent.id);
  } catch { /* counters are advisory */ }
}

/**
 * Seat agents in a room the office just opened.
 *
 * Task roles are validated against the roster ("the owner must be in this
 * room"), so a one-click template has to put its staff in the room before it
 * assigns them work. The seat keys issued here are not handed to anybody: the
 * agent rotates its own key when it joins for real, which is exactly what a
 * fresh seat should do.
 */
export async function seatAgents(
  store: UpstashClient,
  code: string,
  agents: Array<Pick<OfficeAgent, 'name' | 'role'>>,
  now: number = Date.now(),
): Promise<string[]> {
  const seated: string[] = [];
  const seen = new Set<string>();
  for (const agent of agents) {
    const name = agent.name?.trim();
    if (!name || seen.has(name.toLowerCase())) continue;
    seen.add(name.toLowerCase());
    const color = AVATAR_PALETTE[name.length % AVATAR_PALETTE.length] ?? '#5B6AFF';
    const initials = name.split(/\s+/).map(part => part[0] ?? '').join('').slice(0, 2).toUpperCase() || 'AI';
    const result = await joinRoom(store, code, {
      name, role: agent.role ?? '', color, initials, client: 'cc', joinedAt: now, lastSeenAt: now,
    }, {}).catch(() => null);
    if (result) seated.push(result.participant.name);
  }
  return seated;
}

/** Room list for the office, without walking every board. */
export async function roomSummaries(store: UpstashClient): Promise<OfficeRoomSummary[]> {
  const codes = await knownRoomCodes(store);
  const loaded = await loadRooms(store, codes);
  const out: OfficeRoomSummary[] = [];
  for (const { code, room, board } of loaded) {
    if (!room) continue;
    out.push({
      code,
      topic: room.topic,
      status: room.status,
      createdAt: room.createdAt,
      participants: room.participants.length,
      agents: room.participants.filter(p => p.client === 'cc').length,
      openTasks: (board?.tasks ?? []).filter(isOpenTask).length,
      doneTasks: (board?.tasks ?? []).filter(task => task.state === 'done').length,
      pendingApproval: (board?.tasks ?? []).filter(task => task.state === 'pending_approval').length,
    });
  }
  return out.sort((a, b) => b.createdAt - a.createdAt);
}
