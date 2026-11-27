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
  getOfficeRoomRecord,
  listOfficeRoomRecords,
  listBoardRooms,
  listMessages,
  listVaultFiles,
  archiveRoom,
  bumpAgentTask,
  findAgentForRoomName,
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
  ROOM_TTL_SECONDS,
  agentPresence,
  filterAudit,
  handoffUrgency,
  kstDay,
  officeBaseName,
  redactSecretText,
  usageLevel,
} from '@agent-room/shared';
import type {
  AgentTaskActivity,
  OfficeAgent,
  OfficeAgentView,
  OfficeArchive,
  OfficeArchiveFile,
  OfficeAuditEntry,
  OfficeOverview,
  OfficeRoomSummary,
  OfficeTaskRef,
} from '@agent-room/shared';

/** How many rooms one dashboard request will walk. Bounded for cost, not vanity. */
export const OFFICE_OVERVIEW_ROOM_LIMIT = 24;

/** A room is "expiring" at this many days or fewer left. */
export const ROOM_EXPIRING_DAYS = 3;

const DAY_MS = 86_400_000;
const KST_OFFSET_MS = 9 * 3_600_000;

/** When a room disappears, and how many whole days are left (0 = last day). */
export function roomExpiry(createdAt: number, now: number): { expiresAt: number; daysLeft: number } {
  const expiresAt = createdAt + ROOM_TTL_SECONDS * 1000;
  return { expiresAt, daysLeft: Math.max(0, Math.ceil((expiresAt - now) / DAY_MS)) };
}

/**
 * How long one dashboard payload may be reused, in seconds.
 *
 * The number is a staleness budget, not a performance knob: 110 seconds is
 * shorter than the fastest tab (the work tab polls every two minutes), so no
 * tab ever shows a payload older than the one before it, and short enough that
 * an agent's heartbeat, a board change or a finished task shows up on the next
 * poll or two. A write through this API drops the cache outright, so the only
 * staleness left is work done by agents in a room.
 */
export const OFFICE_OVERVIEW_CACHE_TTL_SECONDS = 110;

/** Seconds remaining until the next midnight in KST, never zero. */
export function secondsToKstMidnight(now: number): number {
  const sinceMidnight = (((now + KST_OFFSET_MS) % DAY_MS) + DAY_MS) % DAY_MS;
  return Math.max(1, Math.ceil((DAY_MS - sinceMidnight) / 1000));
}

/** The cache TTL: 110 seconds, cut short at midnight (the key already changes then). */
export function overviewCacheTtl(now: number): number {
  return Math.max(1, Math.min(OFFICE_OVERVIEW_CACHE_TTL_SECONDS, secondsToKstMidnight(now)));
}

/**
 * One key per KST day and per shape of payload. The day is in the key so the
 * "today" numbers can never be served after the day they were counted for, and
 * the shape is in the key because a `withoutRooms` reply legitimately has no
 * room walk and no summary in it.
 */
export function overviewCacheKey(day: string, variant: 'full' | 'without-rooms'): string {
  return `office:overview:v1:${day}:${variant}`;
}

/** Both keys a single write has to drop. Sent as one DEL: one command, not two. */
export function overviewCacheKeys(now: number): [string, string] {
  const day = kstDay(now);
  return [overviewCacheKey(day, 'full'), overviewCacheKey(day, 'without-rooms')];
}

/** A cached payload that is not shaped like an overview is a miss, not a crash. */
function parseCachedOverview(raw: unknown): OfficeOverview | null {
  if (typeof raw !== 'string' || !raw) return null;
  try {
    const parsed = JSON.parse(raw) as OfficeOverview | null;
    if (!parsed || typeof parsed !== 'object') return null;
    if (!Array.isArray(parsed.agents) || !Array.isArray(parsed.rooms) || !Array.isArray(parsed.openTasks)) return null;
    if (typeof parsed.generatedAt !== 'number') return null;
    return parsed;
  } catch {
    return null;
  }
}

export type OverviewCacheState = 'hit' | 'miss' | 'fresh';

export interface CachedOverview {
  overview: OfficeOverview;
  /** `hit`: served from Redis. `miss`: built and stored. `fresh`: built on request, cache ignored. */
  cache: OverviewCacheState;
}

/**
 * Read the dashboard through the cache.
 *
 * The cache exists because the dashboard's own polling is what the free tier's
 * command budget pays for: a refresh walks every collection and up to 24 rooms,
 * so a handful of open tabs would spend the day's 10,000 commands in hours. A
 * hit costs one GET and answers in milliseconds.
 *
 * Anything that is not a clean hit falls back to `buildOverview`, so a broken
 * value, an unreadable Redis or a deploy that changed the payload shape costs
 * one rebuild rather than an error page. `fresh` is what the boss's own refresh
 * button and every write use: skip the read and leave the new answer behind for
 * the polls that follow.
 */
export async function getCachedOverview(
  store: UpstashClient,
  options: OverviewOptions & { fresh?: boolean; now?: number } = {},
): Promise<CachedOverview> {
  const now = options.now ?? Date.now();
  const key = overviewCacheKey(kstDay(now), options.withoutRooms ? 'without-rooms' : 'full');
  if (!options.fresh) {
    const raw = await store.command<string | null>(['GET', key]).catch(() => null);
    const cached = parseCachedOverview(raw);
    if (cached) return { overview: cached, cache: 'hit' };
  }
  const overview = await buildOverview(store, options);
  // Storing the answer is best effort: a cache that cannot be written must not
  // stop the dashboard from opening.
  await store.command(['SET', key, JSON.stringify(overview), 'EX', overviewCacheTtl(now)]).catch(() => null);
  return { overview, cache: options.fresh ? 'fresh' : 'miss' };
}

/**
 * Drop every cached overview for today. Called after a write, so the next poll —
 * not the poll after the TTL — sees the change.
 *
 * Only today's keys are dropped: a key from an earlier day cannot exist, because
 * `overviewCacheTtl` never lets one outlive its midnight.
 */
export async function invalidateOfficeOverview(store: UpstashClient, now: number = Date.now()): Promise<void> {
  await store.command(['DEL', ...overviewCacheKeys(now)]).catch(() => 0);
}

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
  // Audit lines are written verbatim by callers that often quote an error or a
  // user-supplied reason. A token pasted into a reason field, or a URL with
  // credentials embedded in a provider's error, must not become permanent
  // office history — so every detail crosses the same redaction the agent paths
  // already use.
  const detail = fields.detail === undefined ? undefined : redactSecretText(fields.detail);
  await appendAuditSafe(store, [auditEntry(actor, action, { ...fields, ...(detail !== undefined ? { detail } : {}) })]);
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
  successorRoomCode?: string;
  predecessorRoomCode?: string;
}

/**
 * Handoff links for the rooms that need one.
 *
 * Reading every room's office record would double the dashboard's read cost for
 * information only two kinds of room show: an expiring one (where the handoff
 * button lives) and one that already has a successor. So the record is read
 * only for those, and the common room costs nothing.
 */
async function handoffLinks(
  store: UpstashClient,
  codes: string[],
): Promise<Record<string, { successorRoomCode?: string; predecessorRoomCode?: string }>> {
  const records = await listOfficeRoomRecords(store, codes).catch(() => ({} as Record<string, never>));
  const out: Record<string, { successorRoomCode?: string; predecessorRoomCode?: string }> = {};
  for (const [code, record] of Object.entries(records)) {
    const link = {
      ...(record.successorRoomCode ? { successorRoomCode: record.successorRoomCode } : {}),
      ...(record.predecessorRoomCode ? { predecessorRoomCode: record.predecessorRoomCode } : {}),
    };
    if (Object.keys(link).length > 0) out[code] = link;
  }
  return out;
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

/**
 * The card an agent is holding, in the shape presence needs.
 *
 * Presence is what the pixel floor draws over a head, so it carries the card's
 * name, its state and where its progress stands — but nothing the board does not
 * already say. The lease is attached only while it is live: an expired lease is
 * history, and painting "about to expire" over a lease that already ran out
 * would send the boss looking for a problem that has already resolved itself.
 */
function activityRef(code: string, task: Task, now: number): AgentTaskActivity {
  const subtasks = task.subtasks ?? [];
  const lease = task.lease;
  return {
    code,
    id: task.id,
    title: task.title,
    state: task.state,
    ...(lease && lease.status === 'active' && lease.expiresAt > now ? { leaseEndsAt: lease.expiresAt } : {}),
    ...(subtasks.length > 0
      ? { subtasks: { done: subtasks.filter(subtask => subtask.done).length, total: subtasks.length } }
      : {}),
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
  const links = options.withoutRooms ? {} : await handoffLinks(store, loaded.map(({ code }) => code));

  const rooms: OfficeRoomSummary[] = [];
  const openTaskRefs: OfficeTaskRef[] = [];
  const approvals: OfficeTaskRef[] = [];
  const qaQueue: OfficeTaskRef[] = [];
  const failed: OfficeTaskRef[] = [];
  const ownedByAgent = new Map<string, AgentTaskActivity[]>();
  const reviewsByAgent = new Map<string, AgentTaskActivity[]>();
  // Board work is recorded under the room name the agent was using, and rooms
  // decorate names: a rejoin gets "Gemini (2)", an agent adds its role
  // ("망고 (총괄 매니저)"). Presence is read from the roster name, so fold a
  // decorated owner/verifier onto the staff member it belongs to. A name that
  // is literally on the roster always wins, so "Claude (dev)" stays its own
  // entry when the office has both.
  const rosterKeys = new Set(agents.map(agent => agent.name.trim().toLowerCase()));
  const staffKey = (who: string): string => {
    const lower = who.trim().toLowerCase();
    if (rosterKeys.has(lower)) return lower;
    const base = officeBaseName(who).toLowerCase();
    return base && rosterKeys.has(base) ? base : lower;
  };
  let openTasks = 0;
  let doneTasks = 0;
  let doneToday = 0;
  let inProgress = 0;
  let needsAttention = 0;
  let expiringRooms = 0;

  for (const { code, room, board } of loaded) {
    if (!room) continue;
    if (room.status === 'ended' && !board) continue;
    const topic = room.topic || code;
    // The room's own lifetime, read from the record we already have.
    const { expiresAt, daysLeft } = roomExpiry(room.createdAt, now);
    if (room.status === 'active' && daysLeft <= ROOM_EXPIRING_DAYS) expiringRooms += 1;
    let roomOpen = 0;
    let roomDone = 0;
    let roomApprovals = 0;
    for (const task of board?.tasks ?? []) {
      const ref = taskRef(code, topic, task);
      if (task.state === 'pending_approval') { approvals.push(ref); roomApprovals += 1; openTasks += 1; needsAttention += 1; continue; }
      if (task.state === 'done') {
        roomDone += 1; doneTasks += 1;
        // Only a ruling made today counts; a legacy card with no verdict time
        // must not inflate "today" with work finished weeks ago.
        if (task.verdict?.verdict === 'done' && kstDay(task.verdict.at) === day) doneToday += 1;
        continue;
      }
      if (task.state === 'in_progress') inProgress += 1;
      if (task.state === 'blocked' || task.state === 'rejected') needsAttention += 1;
      if (isOpenTask(task)) {
        roomOpen += 1;
        openTasks += 1;
        openTaskRefs.push(ref);
      }
      if (task.state === 'awaiting_review' && task.verifier) {
        if (task.qa && task.qa.status === 'pending') qaQueue.push(ref);
        const verifier = staffKey(task.verifier);
        const list = reviewsByAgent.get(verifier) ?? [];
        list.push(activityRef(code, task, now));
        reviewsByAgent.set(verifier, list);
      }
      if (task.state === 'rejected') failed.push(ref);
      if (task.owner && (task.state === 'in_progress' || task.state === 'rejected')) {
        const owner = staffKey(task.owner);
        const list = ownedByAgent.get(owner) ?? [];
        list.push(activityRef(code, task, now));
        ownedByAgent.set(owner, list);
      }
    }
    rooms.push({
      code,
      topic,
      status: room.status,
      createdAt: room.createdAt,
      expiresAt,
      daysLeft,
      participants: room.participants.length,
      agents: room.participants.filter(p => p.client === 'cc').length,
      openTasks: roomOpen,
      doneTasks: roomDone,
      pendingApproval: roomApprovals,
      ...(handoffUrgency({ status: room.status, daysLeft }) === 'due' ? { handoffDue: true } : {}),
      ...(links[code]?.successorRoomCode ? { successorRoomCode: links[code]!.successorRoomCode } : {}),
      ...(links[code]?.predecessorRoomCode ? { predecessorRoomCode: links[code]!.predecessorRoomCode } : {}),
    });
  }

  const agentViews: OfficeAgentView[] = agents.map(agent => {
    const key = agent.name.trim().toLowerCase();
    const heartbeat = heartbeats[key];
    const presence = agentPresence(agent, {
      ...(heartbeat ? { heartbeatAt: heartbeat.at } : {}),
      active: ownedByAgent.get(key) ?? [],
      reviews: reviewsByAgent.get(key) ?? [],
      ...(heartbeat?.reconnects !== undefined ? { reconnects: heartbeat.reconnects } : {}),
      ...(heartbeat?.resumedAt !== undefined ? { lastResumeAt: heartbeat.resumedAt } : {}),
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
  for (const agent of agentViews) {
    // A seat that has gone quiet mid-task is the one case where 'offline' is
    // not yet true but the work is already stuck. Say it while somebody can act.
    if (agent.presence.link?.state !== 'recovering') continue;
    if (!agent.presence.taskId) continue;
    const minutes = Math.max(1, Math.round((agent.presence.link.downForMs ?? 0) / 60_000));
    warnings.push(`${agent.name} has not been heard from for ${minutes} minute${minutes === 1 ? '' : 's'}; ${agent.presence.taskId} is held until it reconnects.`);
  }
  for (const room of rooms) {
    if (room.status !== 'active' || room.daysLeft > ROOM_EXPIRING_DAYS) continue;
    warnings.push(room.daysLeft > 0
      ? `Room ${room.code} expires in ${room.daysLeft} day${room.daysLeft === 1 ? '' : 's'}.`
      : `Room ${room.code} has expired.`);
    if (room.handoffDue && room.openTasks > 0 && !room.successorRoomCode) {
      warnings.push(`Room ${room.code} expires in ${room.daysLeft} day${room.daysLeft === 1 ? '' : 's'} with ${room.openTasks} open task${room.openTasks === 1 ? '' : 's'} — hand the room over to keep them.`);
    }
  }

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
    // A `withoutRooms` payload never walked a board, so it has nothing to summarise.
    ...(options.withoutRooms ? {} : {
      todaySummary: {
        day,
        doneToday,
        inProgress,
        needsAttention,
        expiringRooms,
        roomsScanned: rooms.length,
      },
    }),
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
): Promise<{ id: string; roomCode: string; topic: string; messageCount: number; deliverables: number }> {
  const room = await getRoom(store, code).catch(() => undefined);
  if (!room) throw new OfficeApiError(`No room ${code} to archive (rooms expire 30 days after creation).`, 404, 'room_not_found');
  const [messages, board] = await Promise.all([
    listMessages(store, code, 0).catch(() => []),
    getTaskBoard(store, code).catch(() => null),
  ]);
  // The archive is the thing that survives the room, so it is where the room's
  // deliverables are indexed. Their bytes already live under a prefix room
  // cleanup never touches and their records carry no TTL — but those records
  // are room-scoped keys that disappear with the room. Snapshotting the
  // metadata here is what keeps the files findable after day 30.
  const [deliverables, materials, record] = await Promise.all([
    listVaultFiles(store, 'deliverable', code).catch(() => []),
    listVaultFiles(store, 'material', code).catch(() => []),
    getOfficeRoomRecord(store, code).catch(() => null),
  ]);
  const files: OfficeArchiveFile[] = deliverables.map(file => ({
    id: file.id,
    name: file.name,
    mime: file.mime,
    size: file.size,
    version: file.version,
    createdAt: file.createdAt,
    storageKey: file.storageKey,
    ...(file.producer ? { producer: file.producer } : {}),
    ...(file.taskId ? { taskId: file.taskId } : {}),
  }));
  const archive = await archiveRoom(store, {
    room, messages, board, now,
    ...(files.length ? { deliverables: files } : {}),
    // Materials are room-scoped and expire with it; the count still belongs to
    // the record of the meeting ("three inputs, two outputs").
    ...(materials.length ? { materialCount: materials.length } : {}),
    ...(record?.successorRoomCode ? { successorRoomCode: record.successorRoomCode } : {}),
  });
  await registerOfficeRoom(store, code, { projectId: archive.projectId, at: now });
  await audit(store, actor, 'meeting.archive', {
    target: archive.id, roomCode: code,
    detail: `${messages.length} messages${files.length ? `, ${files.length} deliverables` : ''}`,
    at: now,
  });
  // The four call sites that archive a room (MCP `room_end`, HTTP room end, the
  // dashboard's `rooms.end` and `archives.capture`) all pass through here, so
  // this is the one place a meeting row has to be announced. It returns at once;
  // the write happens in the background and a failure is kept in the outbox.
  announceMeetingArchived(store, archive, now);
  return { id: archive.id, roomCode: code, topic: room.topic, messageCount: messages.length, deliverables: files.length };
}

/**
 * Announce a finished meeting to the Notion sync.
 *
 * Imported lazily on purpose: `api/room.ts` and `api/mcp.ts` load this module,
 * and neither should carry the Notion SDK on a cold start just because a room
 * might end. The import happens when a room actually does, and its failure is
 * swallowed — an archive that succeeded must not be reported as failed because
 * a background copy could not be scheduled.
 */
function announceMeetingArchived(store: UpstashClient, archive: OfficeArchive, now: number): void {
  void import('./_notion/sync.js')
    .then(module => {
      module.syncEvent(store, { kind: 'meeting.archived', archive }, { now });
    })
    .catch(() => undefined);
}

/**
 * The name the office seats a staff member under.
 *
 * Rooms take whatever name an agent introduces itself with, and agents decorate
 * it ("망고 (총괄 매니저)"). The roster keeps one plain name, and the tasks the
 * boss assigns carry that name — so a decorated seat has to be brought back to
 * the roster name, or the assignments and the heartbeat never find it. A name
 * the roster does not know is left exactly as it came in.
 */
export async function officeSeatName(store: UpstashClient, name: string): Promise<string> {
  const trimmed = typeof name === 'string' ? name.trim() : '';
  if (!trimmed) return trimmed;
  const agent = await findAgentForRoomName(store, trimmed).catch(() => null);
  return agent?.name?.trim() || trimmed;
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
  const agent = await findAgentForRoomName(store, trimmed).catch(() => null);
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
    // roster every time a task is created. The owner name comes from the room,
    // so it may carry a suffix or a role label (see findAgentForRoomName).
    const agent = await findAgentForRoomName(store, trimmed);
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
export async function roomSummaries(store: UpstashClient, now: number = Date.now()): Promise<OfficeRoomSummary[]> {
  const codes = await knownRoomCodes(store);
  const loaded = await loadRooms(store, codes);
  const links = await handoffLinks(store, loaded.map(({ code }) => code));
  const out: OfficeRoomSummary[] = [];
  for (const { code, room, board } of loaded) {
    if (!room) continue;
    const { expiresAt, daysLeft } = roomExpiry(room.createdAt, now);
    out.push({
      code,
      topic: room.topic,
      status: room.status,
      createdAt: room.createdAt,
      expiresAt,
      daysLeft,
      participants: room.participants.length,
      agents: room.participants.filter(p => p.client === 'cc').length,
      openTasks: (board?.tasks ?? []).filter(isOpenTask).length,
      doneTasks: (board?.tasks ?? []).filter(task => task.state === 'done').length,
      pendingApproval: (board?.tasks ?? []).filter(task => task.state === 'pending_approval').length,
      ...(handoffUrgency({ status: room.status, daysLeft }) === 'due' ? { handoffDue: true } : {}),
      ...(links[code]?.successorRoomCode ? { successorRoomCode: links[code]!.successorRoomCode } : {}),
      ...(links[code]?.predecessorRoomCode ? { predecessorRoomCode: links[code]!.predecessorRoomCode } : {}),
    });
  }
  return out.sort((a, b) => b.createdAt - a.createdAt);
}
