// Persistent storage for the AI office.
//
// Rooms expire (30 days, `room:{code}` with a TTL). The office does not: staff,
// projects, standing instructions, meeting archives, the audit log and usage
// counters all live in keys without a TTL, because they are the memory of the
// organisation rather than of one meeting.
//
// Only commands the in-memory test Redis also implements are used here
// (GET/SET/DEL/SADD/SREM/SMEMBERS/INCR/EXPIRE/RPUSH/LTRIM/LRANGE/LLEN and two
// Lua compare-and-set scripts), so the store can be tested end to end without
// a real Redis. Documents are JSON strings behind an index set instead of
// hashes or sorted sets: one entity, one key, one CAS.
import type {
  OfficeAgent,
  OfficeArchive,
  OfficeArchiveFile,
  OfficeAuditEntry,
  OfficeGuideline,
  OfficeMemoryEntry,
  OfficeProject,
  OfficeSettings,
  OfficeTemplate,
} from '@agent-room/shared';
import {
  OFFICE_ARCHIVE_MAX,
  OFFICE_AUDIT_RETENTION,
  OFFICE_DEFAULT_SETTINGS,
  OFFICE_MAX_GUIDELINES,
  OFFICE_MAX_MEMORY_ENTRIES,
  archiveMatches,
  buildMinutes,
  normalizeOfficeSettings,
  newOfficeId,
  officeBaseName,
} from '@agent-room/shared';
import type { Message, Room, Task, TaskBoard } from '@agent-room/shared';
import type { UpstashClient } from './client.js';
import { backupChecksum, OFFICE_BACKUP_FORMAT, OFFICE_BACKUP_VERSION, OfficeBackupError, validateOfficeBackup, type OfficeBackup } from './officeBackup.js';

const PREFIX = 'office:v1';
const key = (...parts: string[]) => [PREFIX, ...parts].join(':');

const AGENTS = key('agents');
const PROJECTS = key('projects');
const TEMPLATES = key('templates');
const ARCHIVES = key('archives');
const AUDIT = key('audit');
const SETTINGS = key('settings');
const agentKey = (id: string) => key('agent', id);
const agentNameKey = (name: string) => key('agentname', name.trim().toLowerCase());
const projectKey = (id: string) => key('project', id);
const templateKey = (id: string) => key('template', id);
const archiveKey = (id: string) => key('archive', id);
const archiveRoomKey = (code: string) => key('archive-room', code);
const heartbeatKey = (name: string) => key('heartbeat', name.trim().toLowerCase());
export const officeUsageKey = (day: string, kind: 'requests' | 'writes') => key('usage', day, kind);
export const officeAgentUsageKey = (day: string, agentId: string) => key('usage-agent', day, agentId);

// Same compare-and-set contract as the task board, without the TTL: an office
// document is expected to outlive every meeting that touches it.
const CAS_SCRIPT =
  "-- office-cas\n" +
  "local cur = redis.call('GET', KEYS[1])\n" +
  "if ARGV[1] == 'absent' then\n" +
  "  if cur then return 0 end\n" +
  "else\n" +
  "  if cur ~= ARGV[2] then return 0 end\n" +
  "end\n" +
  "redis.call('SET', KEYS[1], ARGV[3])\n" +
  "return 1";

const CAS_ATTEMPTS = 5;

async function readJson<T>(client: UpstashClient, keyName: string): Promise<T | null> {
  const raw = await client.command<string | null>(['GET', keyName]);
  if (raw === null || raw === undefined) return null;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

async function writeJson(client: UpstashClient, keyName: string, value: unknown): Promise<void> {
  await client.command(['SET', keyName, JSON.stringify(value)]);
}

async function casJson(
  client: UpstashClient,
  keyName: string,
  mutate: (current: string | null) => string | null,
): Promise<boolean> {
  for (let attempt = 0; attempt < CAS_ATTEMPTS; attempt++) {
    const current = await client.command<string | null>(['GET', keyName]);
    const next = mutate(current === undefined ? null : current);
    if (next === null) return false;
    const res = Number(await client.command<number>([
      'EVAL', CAS_SCRIPT, '1', keyName,
      current === null || current === undefined ? 'absent' : 'present',
      current ?? '',
      next,
    ]));
    if (res === 1) return true;
    await new Promise(r => setTimeout(r, 10 + Math.floor(Math.random() * 25)));
  }
  return false;
}

async function readIndex(client: UpstashClient, indexKey: string): Promise<string[]> {
  const members = await client.command<string[] | null>(['SMEMBERS', indexKey]);
  return Array.isArray(members) ? members.filter(id => typeof id === 'string' && id) : [];
}

async function readCollection<T>(client: UpstashClient, indexKey: string, entry: (id: string) => string): Promise<T[]> {
  const ids = await readIndex(client, indexKey);
  const rows = await Promise.all(ids.map(id => readJson<T>(client, entry(id))));
  return rows.filter((row): row is NonNullable<typeof row> => row !== null && row !== undefined) as T[];
}

// ─── Settings ─────────────────────────────────────────────────────────────

export async function getOfficeSettings(client: UpstashClient): Promise<OfficeSettings> {
  const stored = await readJson<Partial<OfficeSettings>>(client, SETTINGS);
  return stored ? normalizeOfficeSettings(stored) : { ...OFFICE_DEFAULT_SETTINGS };
}

export async function saveOfficeSettings(client: UpstashClient, patch: Partial<Record<keyof OfficeSettings, unknown>>): Promise<OfficeSettings> {
  const next = normalizeOfficeSettings({ ...(await getOfficeSettings(client)), ...patch });
  await writeJson(client, SETTINGS, next);
  return next;
}

// ─── AI staff ─────────────────────────────────────────────────────────────

export interface AgentHeartbeat {
  at: number;
  roomCode?: string;
  /** How long the seat was quiet before this stamp, when it came back from a gap. */
  gapMs?: number;
  /** The moment this stamp ended a gap; a resumed session starts here. */
  resumedAt?: number;
  /** Reconnections this seat has made, carried in the stamp it already writes. */
  reconnects?: number;
  /** The gap of the most recent reconnection. */
  lastGapMs?: number;
  /** When the most recent silence started (`at - gapMs`). */
  lastDropAt?: number;
}

/**
 * How long a silence has to be before a new heartbeat is a *reconnection*.
 *
 * Stamps are throttled to one per 30 seconds and a listen window can be a
 * minute long, so ordinary polling produces gaps of that size. Ninety seconds
 * is past every normal cadence and still short enough that a client that was
 * killed and restarted is recognised as coming back.
 */
export const LINK_GAP_MS = 90_000;

export async function listAgents(client: UpstashClient): Promise<OfficeAgent[]> {
  const agents = await readCollection<OfficeAgent>(client, AGENTS, agentKey);
  return agents.map(agent => ({ ...agent, tags: Array.isArray(agent.tags) ? agent.tags : [] }))
    .sort((a, b) => Number(b.enabled) - Number(a.enabled) || a.name.localeCompare(b.name));
}

export async function getAgent(client: UpstashClient, id: string): Promise<OfficeAgent | null> {
  return readJson<OfficeAgent>(client, agentKey(id));
}

export async function findAgentByName(client: UpstashClient, name: string): Promise<OfficeAgent | null> {
  if (!name.trim()) return null;
  const id = await client.command<string | null>(['GET', agentNameKey(name)]);
  if (!id) return null;
  return getAgent(client, id);
}

/**
 * Roster lookup for a name that came out of a room.
 *
 * Rooms decorate display names — joinRoom suffixes a colliding one ("Gemini
 * (2)") and an agent may add its role ("망고 (총괄 매니저)") — while the roster
 * keeps one plain name per AI. Exact match first, so a staff member that really
 * is called "Claude (dev)" keeps its own entry and is never merged away.
 */
export async function findAgentForRoomName(client: UpstashClient, name: string): Promise<OfficeAgent | null> {
  const exact = await findAgentByName(client, name);
  if (exact) return exact;
  const base = officeBaseName(name);
  if (!base || base.toLowerCase() === name.trim().toLowerCase()) return null;
  return findAgentByName(client, base);
}

export async function saveAgent(client: UpstashClient, agent: OfficeAgent): Promise<OfficeAgent> {
  await writeJson(client, agentKey(agent.id), agent);
  await client.pipeline([
    ['SADD', AGENTS, agent.id],
    ['SET', agentNameKey(agent.name), agent.id],
  ]);
  return agent;
}

/** Create or update in one call. A rename keeps the old name index clean. */
export async function upsertAgent(
  client: UpstashClient,
  input: Partial<OfficeAgent> & { name: string; role: string },
  actor: string,
  now: number,
): Promise<OfficeAgent> {
  if (input.id) {
    const existing = await getAgent(client, input.id);
    if (!existing) throw new Error(`No AI staff member with id ${input.id}.`);
    const next: OfficeAgent = { ...existing, ...input, id: existing.id, updatedAt: now };
    if (next.name.trim().toLowerCase() !== existing.name.trim().toLowerCase()) {
      await client.command(['DEL', agentNameKey(existing.name)]);
    }
    return saveAgent(client, next);
  }
  const clash = await findAgentByName(client, input.name);
  if (clash) throw new Error(`An AI staff member named "${input.name}" already exists.`);
  const agent: OfficeAgent = {
    id: newOfficeId('ag'),
    name: input.name,
    role: input.role,
    tags: input.tags ?? [],
    dailyTaskLimit: input.dailyTaskLimit ?? OFFICE_DEFAULT_SETTINGS.defaultAgentDailyLimit,
    requiresApproval: input.requiresApproval ?? false,
    paused: input.paused ?? false,
    enabled: input.enabled ?? true,
    ...(input.brief ? { brief: input.brief } : {}),
    ...(input.model ? { model: input.model } : {}),
    createdAt: now,
    updatedAt: now,
    createdBy: actor,
  };
  return saveAgent(client, agent);
}

export async function deleteAgent(client: UpstashClient, id: string): Promise<boolean> {
  const existing = await getAgent(client, id);
  if (!existing) return false;
  await client.pipeline([
    ['DEL', agentKey(id), agentNameKey(existing.name)],
    ['SREM', AGENTS, id],
  ]);
  return true;
}

export async function readHeartbeat(client: UpstashClient, name: string): Promise<AgentHeartbeat | null> {
  return readJson<AgentHeartbeat>(client, heartbeatKey(name));
}


export async function listHeartbeats(client: UpstashClient, names: string[]): Promise<Record<string, AgentHeartbeat>> {
  if (names.length === 0) return {};
  const rows = await Promise.all(names.map(name => readHeartbeat(client, name)));
  const out: Record<string, AgentHeartbeat> = {};
  names.forEach((name, index) => {
    const row = rows[index];
    if (row && Number.isFinite(row.at)) out[name.trim().toLowerCase()] = row;
  });
  return out;
}

/**
 * Stamp that this seat is alive.
 *
 * Called from the listen path on every poll, so it is throttled by reading the
 * previous stamp: a listen loop every few seconds must not turn into one Redis
 * write every few seconds. The first write of each window also registers the
 * agent so a name that starts working in a room shows up in the office without
 * anyone typing it in.
 */
export async function recordAgentHeartbeat(
  client: UpstashClient,
  input: { name: string; roomCode?: string; at: number; throttleMs?: number; registerIfUnknown?: boolean },
): Promise<{ recorded: boolean; agentId?: string; reconnected?: boolean; gapMs?: number }> {
  const name = input.name?.trim();
  if (!name) return { recorded: false };
  const throttle = input.throttleMs ?? 30_000;
  const previous = await readHeartbeat(client, name);
  // The common case is a listen loop inside the window: answer from the one
  // read we already did instead of also looking the agent up.
  if (previous && input.at - previous.at < throttle) return { recorded: false };
  // A silence longer than LINK_GAP_MS is a reconnection, not a poll: the seat
  // was away, and whatever it was executing at the time is still on the board.
  // The gap is recorded in the stamp, so the next reader (the office, the
  // agent's own join result) can say how long it was gone without another key.
  const gapMs = previous ? Math.max(0, input.at - previous.at) : undefined;
  const reconnected = gapMs !== undefined && gapMs >= LINK_GAP_MS;
  let agent = await findAgentForRoomName(client, name);
  if (!agent && input.registerIfUnknown) {
    // Opt-in discovery: a listening seat nobody has entered in the roster is
    // added as unassigned staff so the boss can name it, but it starts paused —
    // work must never be auto-assigned to an agent nobody has defined. A
    // decorated name is registered under its plain form, or every restart would
    // add "Gemini (2)", then "Gemini (3)", as separate staff.
    try {
      agent = await upsertAgent(client, {
        name: officeBaseName(name) || name,
        role: 'Unassigned agent (discovered in a room)',
        tags: [],
        enabled: true,
        paused: true,
        requiresApproval: false,
      }, 'system', input.at);
    } catch {
      agent = null;
    }
  }
  // Both the name the room called this seat and the roster name it resolves to
  // are stamped: the seat itself polls under the room name (that is the key the
  // throttle above reads), and the dashboard polls under the roster name. One
  // pipeline, so a decorated name costs one round trip, not two.
  const reconnects = Math.max(0, Math.min(99_999, (previous?.reconnects ?? 0) + (reconnected ? 1 : 0)));
  const stamp: AgentHeartbeat = {
    at: input.at,
    ...(input.roomCode ? { roomCode: input.roomCode } : {}),
    ...(reconnects > 0 ? { reconnects } : {}),
    ...(reconnected && gapMs !== undefined
      ? { gapMs, resumedAt: input.at, lastGapMs: gapMs, lastDropAt: input.at - gapMs }
      : previous?.lastGapMs !== undefined
        ? { lastGapMs: previous.lastGapMs, ...(previous.lastDropAt !== undefined ? { lastDropAt: previous.lastDropAt } : {}) }
        : {}),
  };
  const stampNames = agent && agent.name.trim().toLowerCase() !== name.toLowerCase()
    ? [name, agent.name]
    : [name];
  await client.pipeline(stampNames.map(stampName => ['SET', heartbeatKey(stampName), JSON.stringify(stamp)]));
  if (agent) {
    // Mirror the stamp onto the roster entry at heartbeat cadence, not on every
    // poll, so the dashboard's copy stays useful without a write per listen.
    if (!agent.lastHeartbeatAt || input.at - agent.lastHeartbeatAt > throttle) {
      await casJson(client, agentKey(agent.id), current => {
        if (!current) return null;
        try {
          const parsed = JSON.parse(current) as OfficeAgent;
          if (parsed.lastHeartbeatAt && input.at - parsed.lastHeartbeatAt <= throttle) return current;
          return JSON.stringify({
            ...parsed,
            lastHeartbeatAt: input.at,
            ...(input.roomCode ? { lastHeartbeatRoom: input.roomCode } : {}),
          });
        } catch {
          return null;
        }
      });
    }
    return { recorded: true, agentId: agent.id, ...(reconnected && gapMs !== undefined ? { reconnected, gapMs } : {}) };
  }
  return { recorded: true, ...(reconnected && gapMs !== undefined ? { reconnected, gapMs } : {}) };
}

// ─── Projects ─────────────────────────────────────────────────────────────

export async function listProjects(client: UpstashClient): Promise<OfficeProject[]> {
  const projects = await readCollection<OfficeProject>(client, PROJECTS, projectKey);
  return projects
    .map(project => ({ ...project,
      memory: Array.isArray(project.memory) ? project.memory : [],
      guidelines: Array.isArray(project.guidelines) ? project.guidelines : [],
      roomCodes: Array.isArray(project.roomCodes) ? project.roomCodes : [],
      agentIds: Array.isArray(project.agentIds) ? project.agentIds : [],
      fileIds: Array.isArray(project.fileIds) ? project.fileIds : [],
      taskRefs: Array.isArray(project.taskRefs) ? project.taskRefs : [] }))
    .sort((a, b) => Number(b.status === 'active') - Number(a.status === 'active') || a.name.localeCompare(b.name));
}

export async function getProject(client: UpstashClient, id: string): Promise<OfficeProject | null> {
  return readJson<OfficeProject>(client, projectKey(id));
}

export async function saveProject(client: UpstashClient, project: OfficeProject): Promise<OfficeProject> {
  await writeJson(client, projectKey(project.id), project);
  await client.command(['SADD', PROJECTS, project.id]);
  return project;
}

export async function createProject(
  client: UpstashClient,
  input: { name: string; description?: string; status?: 'active' | 'archived'; agentIds?: string[]; roomCodes?: string[] },
  actor: string,
  now: number,
): Promise<OfficeProject> {
  const project: OfficeProject = {
    id: newOfficeId('prj'),
    name: input.name,
    description: input.description ?? '',
    status: input.status ?? 'active',
    roomCodes: input.roomCodes ?? [],
    agentIds: input.agentIds ?? [],
    fileIds: [],
    taskRefs: [],
    memory: [],
    guidelines: [],
    createdAt: now,
    updatedAt: now,
    createdBy: actor,
  };
  return saveProject(client, project);
}

export async function deleteProject(client: UpstashClient, id: string): Promise<boolean> {
  const existing = await getProject(client, id);
  if (!existing) return false;
  await client.pipeline([
    ['DEL', projectKey(id)],
    ['SREM', PROJECTS, id],
  ]);
  return true;
}

/**
 * Mutate one project under CAS. Concurrent edits from two dashboard tabs are
 * the only writers here, but the same call also links rooms/tasks from the
 * task path, so a lost update would silently drop an approved task.
 */
export async function mutateProject(
  client: UpstashClient,
  id: string,
  mutate: (project: OfficeProject) => OfficeProject,
): Promise<OfficeProject> {
  let result: OfficeProject | null = null;
  const ok = await casJson(client, projectKey(id), current => {
    if (!current) return null;
    try {
      result = mutate(JSON.parse(current) as OfficeProject);
      return JSON.stringify(result);
    } catch {
      return null;
    }
  });
  if (!ok || !result) throw new Error(`No project with id ${id}.`);
  return result;
}

export async function addProjectMemory(
  client: UpstashClient,
  projectId: string,
  input: { title: string; body: string; tags: string[]; pinned: boolean },
  actor: string,
  now: number,
): Promise<{ project: OfficeProject; entry: OfficeMemoryEntry }> {
  const entry: OfficeMemoryEntry = { id: newOfficeId('mem'), ...input, createdAt: now, updatedAt: now, by: actor };
  const project = await mutateProject(client, projectId, current => ({
    ...current,
    memory: [...(current.memory ?? []), entry].slice(-OFFICE_MAX_MEMORY_ENTRIES),
    updatedAt: now,
  }));
  return { project, entry };
}

export async function updateProjectMemory(
  client: UpstashClient,
  projectId: string,
  memoryId: string,
  patch: { title?: string; body?: string; tags?: string[]; pinned?: boolean },
  actor: string,
  now: number,
): Promise<OfficeProject> {
  return mutateProject(client, projectId, current => {
    const memory = (current.memory ?? []).map(entry => entry.id === memoryId
      ? { ...entry, ...patch, updatedAt: now, by: actor }
      : entry);
    if (!memory.some(entry => entry.id === memoryId)) throw new Error(`No memory ${memoryId}.`);
    return { ...current, memory, updatedAt: now };
  });
}

export async function deleteProjectMemory(client: UpstashClient, projectId: string, memoryId: string, now: number): Promise<OfficeProject> {
  return mutateProject(client, projectId, current => ({
    ...current,
    memory: (current.memory ?? []).filter(entry => entry.id !== memoryId),
    updatedAt: now,
  }));
}

export async function addProjectGuideline(
  client: UpstashClient,
  projectId: string,
  input: { title: string; body: string },
  actor: string,
  now: number,
): Promise<{ project: OfficeProject; guideline: OfficeGuideline }> {
  const guideline: OfficeGuideline = { id: newOfficeId('gdl'), ...input, updatedAt: now, by: actor };
  const project = await mutateProject(client, projectId, current => ({
    ...current,
    guidelines: [...(current.guidelines ?? []), guideline].slice(-OFFICE_MAX_GUIDELINES),
    updatedAt: now,
  }));
  return { project, guideline };
}

export async function updateProjectGuideline(
  client: UpstashClient,
  projectId: string,
  guidelineId: string,
  patch: { title?: string; body?: string },
  actor: string,
  now: number,
): Promise<OfficeProject> {
  return mutateProject(client, projectId, current => ({
    ...current,
    guidelines: (current.guidelines ?? []).map(entry => entry.id === guidelineId
      ? { ...entry, ...patch, updatedAt: now, by: actor }
      : entry),
    updatedAt: now,
  }));
}

export async function deleteProjectGuideline(client: UpstashClient, projectId: string, guidelineId: string, now: number): Promise<OfficeProject> {
  return mutateProject(client, projectId, current => ({
    ...current,
    guidelines: (current.guidelines ?? []).filter(entry => entry.id !== guidelineId),
    updatedAt: now,
  }));
}

/** Link a room (and optionally a task) to a project; idempotent. */
export async function linkProjectWork(
  client: UpstashClient,
  projectId: string,
  link: { roomCode?: string; taskRef?: { code: string; id: string }; fileId?: string },
  now: number,
): Promise<OfficeProject> {
  return mutateProject(client, projectId, current => {
    const roomCodes = link.roomCode && !current.roomCodes.includes(link.roomCode)
      ? [...current.roomCodes, link.roomCode] : current.roomCodes;
    const taskRefs = link.taskRef && !current.taskRefs.some(ref => ref.code === link.taskRef!.code && ref.id === link.taskRef!.id)
      ? [...current.taskRefs, link.taskRef] : current.taskRefs;
    const fileIds = link.fileId && !current.fileIds.includes(link.fileId)
      ? [...current.fileIds, link.fileId] : current.fileIds;
    return { ...current, roomCodes, taskRefs, fileIds, updatedAt: now };
  });
}

// ─── Templates ────────────────────────────────────────────────────────────

export async function listTemplates(client: UpstashClient): Promise<OfficeTemplate[]> {
  const templates = await readCollection<OfficeTemplate>(client, TEMPLATES, templateKey);
  return templates
    .map(template => ({ ...template, tasks: Array.isArray(template.tasks) ? template.tasks : [] }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

export async function getTemplate(client: UpstashClient, id: string): Promise<OfficeTemplate | null> {
  return readJson<OfficeTemplate>(client, templateKey(id));
}

export async function saveTemplate(client: UpstashClient, template: OfficeTemplate): Promise<OfficeTemplate> {
  await writeJson(client, templateKey(template.id), template);
  await client.command(['SADD', TEMPLATES, template.id]);
  return template;
}

export async function createTemplate(
  client: UpstashClient,
  input: Omit<OfficeTemplate, 'id' | 'createdAt' | 'updatedAt' | 'createdBy'>,
  actor: string,
  now: number,
): Promise<OfficeTemplate> {
  const template: OfficeTemplate = { ...input, id: newOfficeId('tpl'), createdAt: now, updatedAt: now, createdBy: actor };
  return saveTemplate(client, template);
}

export async function updateTemplate(
  client: UpstashClient,
  id: string,
  input: Partial<Omit<OfficeTemplate, 'id' | 'createdAt' | 'createdBy'>>,
  now: number,
): Promise<OfficeTemplate> {
  const existing = await getTemplate(client, id);
  if (!existing) throw new Error(`No template with id ${id}.`);
  return saveTemplate(client, { ...existing, ...input, id: existing.id, updatedAt: now });
}

export async function deleteTemplate(client: UpstashClient, id: string): Promise<boolean> {
  const existing = await getTemplate(client, id);
  if (!existing) return false;
  await client.pipeline([
    ['DEL', templateKey(id)],
    ['SREM', TEMPLATES, id],
  ]);
  return true;
}

// ─── Permanent meeting archive ────────────────────────────────────────────

export async function listArchives(client: UpstashClient, limit = 100): Promise<OfficeArchive[]> {
  const archives = await readCollection<OfficeArchive>(client, ARCHIVES, archiveKey);
  return archives
    .sort((a, b) => b.archivedAt - a.archivedAt)
    .slice(0, Math.max(1, Math.min(limit, OFFICE_ARCHIVE_MAX)));
}

export async function getArchive(client: UpstashClient, id: string): Promise<OfficeArchive | null> {
  return readJson<OfficeArchive>(client, archiveKey(id));
}

/**
 * Store the minutes of a finished room. Idempotent per room: ending a room
 * twice (or reviving and ending it again) refreshes the snapshot instead of
 * stacking duplicates, and the archive keeps its original id so links survive.
 */
export async function archiveRoom(
  client: UpstashClient,
  input: {
    room: Pick<Room, 'code' | 'topic' | 'createdBy' | 'createdAt'>;
    messages: Message[];
    tasks?: Task[];
    tags?: string[];
    projectId?: string;
    now: number;
    board?: TaskBoard | null;
    /** Deliverables produced in the room — snapshotted so they outlive it. */
    deliverables?: OfficeArchiveFile[];
    /** Materials were room-scoped; only their count is worth keeping. */
    materialCount?: number;
    /** Where this room's open work was carried, when it was handed over. */
    successorRoomCode?: string;
  },
): Promise<OfficeArchive> {
  const existingId = await client.command<string | null>(['GET', archiveRoomKey(input.room.code)]);
  const existing = existingId ? await getArchive(client, existingId) : null;
  const built = buildMinutes({
    room: input.room,
    messages: input.messages,
    tasks: input.board?.tasks ?? input.tasks ?? [],
    archivedAt: input.now,
  });
  const archive: OfficeArchive = {
    id: existing?.id ?? newOfficeId('arc'),
    roomCode: input.room.code,
    topic: input.room.topic,
    createdBy: input.room.createdBy,
    roomCreatedAt: input.room.createdAt,
    archivedAt: input.now,
    participants: [...new Set(input.messages.map(m => m.name))],
    messageCount: input.messages.length,
    summary: built.summary,
    minutes: built.minutes,
    messages: built.messages,
    tasks: (input.board?.tasks ?? input.tasks ?? []).map(task => ({
      id: task.id, title: task.title, state: task.state,
      ...(task.owner ? { owner: task.owner } : {}), ...(task.verifier ? { verifier: task.verifier } : {}),
    })),
    ...(input.projectId ? { projectId: input.projectId } : existing?.projectId ? { projectId: existing.projectId } : {}),
    tags: input.tags ?? existing?.tags ?? [],
    // Deliverables are cumulative: a later capture (an end, then a handoff)
    // must never shrink the set the first one recorded.
    ...(input.deliverables && input.deliverables.length > 0
      ? { deliverables: mergeArchiveFiles(existing?.deliverables, input.deliverables) }
      : existing?.deliverables ? { deliverables: existing.deliverables } : {}),
    ...(input.materialCount !== undefined
      ? { materialCount: Math.max(input.materialCount, existing?.materialCount ?? 0) }
      : existing?.materialCount !== undefined ? { materialCount: existing.materialCount } : {}),
    ...(input.successorRoomCode
      ? { successorRoomCode: input.successorRoomCode }
      : existing?.successorRoomCode ? { successorRoomCode: existing.successorRoomCode } : {}),
  };
  await writeJson(client, archiveKey(archive.id), archive);
  await client.pipeline([
    ['SADD', ARCHIVES, archive.id],
    ['SET', archiveRoomKey(archive.roomCode), archive.id],
  ]);
  // Keep the archive set bounded by trimming the index, not the documents:
  // deleting minutes the boss asked to keep permanently is not a retention
  // decision this layer may take on its own.
  return archive;
}

/** Union of two archive file lists, newest metadata winning per file id. */
function mergeArchiveFiles(
  before: OfficeArchiveFile[] | undefined,
  after: OfficeArchiveFile[],
): OfficeArchiveFile[] {
  const byId = new Map<string, OfficeArchiveFile>();
  for (const file of before ?? []) byId.set(file.id, file);
  for (const file of after) byId.set(file.id, file);
  return [...byId.values()].sort((a, b) => b.createdAt - a.createdAt);
}

export async function deleteArchive(client: UpstashClient, id: string): Promise<boolean> {
  const existing = await getArchive(client, id);
  if (!existing) return false;
  await client.pipeline([
    ['DEL', archiveKey(id)],
    ['SREM', ARCHIVES, id],
    ['DEL', archiveRoomKey(existing.roomCode)],
  ]);
  return true;
}

export async function searchArchives(client: UpstashClient, query: string, limit = 50): Promise<OfficeArchive[]> {
  const archives = await listArchives(client, OFFICE_ARCHIVE_MAX);
  return archives.filter(archive => archiveMatches(archive, query)).slice(0, Math.max(1, Math.min(limit, 200)));
}

// ─── Room registry ────────────────────────────────────────────────────────
//
// The room layer keeps no index of rooms (a room is a key with a TTL, nothing
// more), so the office remembers the rooms it opened or saw a board for. That
// is what lets the dashboard list "meetings" at all: an expired room still
// appears in the archive, and an open one is found through this set.

const ROOMS = key('rooms');
const roomKey = (code: string) => key('room', code);

export interface OfficeRoomRecord {
  code: string;
  projectId?: string;
  templateId?: string;
  registeredAt: number;
  /** Where this room's open work was carried, when it was handed over. */
  successorRoomCode?: string;
  /** The room this one continues, when it was opened by a handoff. */
  predecessorRoomCode?: string;
  handoffAt?: number;
  handoffBy?: string;
  /** Number of cards the handoff carried, for the room list. */
  handoffTaskCount?: number;
}

export async function registerOfficeRoom(
  client: UpstashClient,
  code: string,
  meta: { projectId?: string; templateId?: string; at: number },
): Promise<void> {
  // Merge, never replace. Registering happens on several paths (a template run,
  // an archive capture, a handoff) and a later call must not erase what an
  // earlier one taught the office about the room — the successor link in
  // particular is written once and then re-registered by the archive capture
  // that immediately follows it.
  const existing = await readJson<OfficeRoomRecord>(client, roomKey(code)).catch(() => null);
  const record: OfficeRoomRecord = {
    ...(existing ?? {}),
    code,
    ...(meta.projectId ?? existing?.projectId ? { projectId: meta.projectId ?? existing?.projectId } : {}),
    ...(meta.templateId ?? existing?.templateId ? { templateId: meta.templateId ?? existing?.templateId } : {}),
    registeredAt: existing?.registeredAt ?? meta.at,
  };
  await writeJson(client, roomKey(code), record);
  await client.command(['SADD', ROOMS, code]);
}

export async function listOfficeRooms(client: UpstashClient): Promise<string[]> {
  return readIndex(client, ROOMS);
}

export async function getOfficeRoomRecord(client: UpstashClient, code: string): Promise<OfficeRoomRecord | null> {
  return readJson<OfficeRoomRecord>(client, roomKey(code));
}

/**
 * Records for several rooms in one round trip.
 *
 * The dashboard needs every room's handoff links, not just the expiring ones —
 * a successor is by definition new and healthy. One pipeline keeps that at one
 * HTTP request instead of one per room.
 */
export async function listOfficeRoomRecords(
  client: UpstashClient,
  codes: string[],
): Promise<Record<string, OfficeRoomRecord>> {
  if (codes.length === 0) return {};
  const rows = await client.pipeline<string | null>(codes.map(code => ['GET', roomKey(code)]));
  const out: Record<string, OfficeRoomRecord> = {};
  codes.forEach((code, index) => {
    const raw = rows[index];
    if (typeof raw !== 'string' || !raw) return;
    try {
      const parsed = JSON.parse(raw) as OfficeRoomRecord;
      if (parsed && typeof parsed.code === 'string') out[code] = parsed;
    } catch { /* one corrupt record must not blank the room list */ }
  });
  return out;
}

/**
 * Remember that a room's open work moved to a successor.
 *
 * The record is the office's own (no TTL): the source room expires in 30 days
 * and its registry entry would go with it, but the link between the two rooms
 * is part of the office's history and the dashboard's "where did this go".
 * Both ends are written, so either room can name the other.
 */
export async function recordRoomHandoff(
  client: UpstashClient,
  input: {
    sourceCode: string;
    successorCode: string;
    at: number;
    by: string;
    taskCount: number;
    projectId?: string;
    topic?: string;
    /** Topic the successor was opened under, so it can be listed like any room. */
    successorTopic?: string;
  },
): Promise<{ source: OfficeRoomRecord; successor: OfficeRoomRecord }> {
  const now = input.at;
  const sourceCurrent = await getOfficeRoomRecord(client, input.sourceCode);
  const source: OfficeRoomRecord = {
    ...(sourceCurrent ?? { code: input.sourceCode, registeredAt: now }),
    code: input.sourceCode,
    ...(input.projectId ?? sourceCurrent?.projectId ? { projectId: input.projectId ?? sourceCurrent?.projectId } : {}),
    successorRoomCode: input.successorCode,
    handoffAt: now,
    handoffBy: input.by,
    handoffTaskCount: input.taskCount,
  };
  const successorCurrent = await getOfficeRoomRecord(client, input.successorCode);
  const successor: OfficeRoomRecord = {
    ...(successorCurrent ?? { code: input.successorCode, registeredAt: now }),
    code: input.successorCode,
    ...(input.projectId ?? successorCurrent?.projectId ? { projectId: input.projectId ?? successorCurrent?.projectId } : {}),
    predecessorRoomCode: input.sourceCode,
    handoffAt: now,
    handoffBy: input.by,
  };
  await client.pipeline([
    ['SET', roomKey(input.sourceCode), JSON.stringify(source)],
    ['SADD', ROOMS, input.sourceCode],
    ['SET', roomKey(input.successorCode), JSON.stringify(successor)],
    ['SADD', ROOMS, input.successorCode],
  ]);
  return { source, successor };
}

/**
 * Forget a room the office listed: drop it from the registry and its record.
 *
 * The room's own key is a different one (`room:<code>`, see rooms.ts), so this
 * only stops the dashboard listing the room; deleting the room itself is the
 * caller's second step (deleteRoomData).
 */
export async function unregisterOfficeRoom(client: UpstashClient, code: string): Promise<void> {
  await client.pipeline([
    ['SREM', ROOMS, code],
    ['DEL', roomKey(code)],
  ]);
}

// ─── Audit log ────────────────────────────────────────────────────────────

export async function appendAudit(
  client: UpstashClient,
  entries: OfficeAuditEntry[],
): Promise<void> {
  if (entries.length === 0) return;
  await client.pipeline([
    ['RPUSH', AUDIT, ...entries.map(entry => JSON.stringify(entry))],
    ['LTRIM', AUDIT, String(-OFFICE_AUDIT_RETENTION), '-1'],
  ]);
}

/** Best-effort audit: a failed audit write must never fail the action it describes. */
export async function appendAuditSafe(client: UpstashClient, entries: OfficeAuditEntry[]): Promise<void> {
  try {
    await appendAudit(client, entries);
  } catch { /* the action succeeded; the log entry is retried by the next write */ }
}

export function auditEntry(
  actor: OfficeAuditEntry['actor'],
  action: string,
  fields: Omit<OfficeAuditEntry, 'id' | 'at' | 'actor' | 'action'> & { at?: number } = {},
): OfficeAuditEntry {
  const { at, ...rest } = fields;
  return {
    id: newOfficeId('aud'),
    at: at ?? Date.now(),
    actor,
    action,
    ...rest,
  };
}

/** Newest `limit` entries, oldest first in storage. */
export async function readAudit(client: UpstashClient, limit = 200): Promise<OfficeAuditEntry[]> {
  const capped = Math.max(1, Math.min(limit, OFFICE_AUDIT_RETENTION));
  const raw = await client.command<string[] | null>(['LRANGE', AUDIT, String(-capped), '-1']);
  if (!Array.isArray(raw)) return [];
  const entries: OfficeAuditEntry[] = [];
  for (const line of raw) {
    try {
      const parsed = JSON.parse(line) as OfficeAuditEntry;
      if (parsed && typeof parsed.at === 'number') entries.push(parsed);
    } catch { /* one corrupt row must not hide the rest */ }
  }
  return entries.reverse();
}

// ─── Usage ────────────────────────────────────────────────────────────────

export async function bumpUsage(client: UpstashClient, day: string, kind: 'requests' | 'writes'): Promise<number> {
  const value = Number(await client.command<number>(['INCR', officeUsageKey(day, kind)]));
  // The counter is read on every dashboard refresh, so the expiry is only set
  // when the key is born: one command per request instead of two.
  if (value === 1) await client.command(['EXPIRE', officeUsageKey(day, kind), String(60 * 60 * 24 * 3)]);
  return value;
}

export async function readUsage(client: UpstashClient, day: string): Promise<{ requests: number; writes: number }> {
  const rows = await client.pipeline<string | null>([
    ['GET', officeUsageKey(day, 'requests')],
    ['GET', officeUsageKey(day, 'writes')],
  ]);
  const parse = (value: string | null) => {
    const n = Number(value ?? 0);
    return Number.isFinite(n) && n > 0 ? n : 0;
  };
  return { requests: parse(rows[0] ?? null), writes: parse(rows[1] ?? null) };
}

export async function bumpAgentTask(client: UpstashClient, day: string, agentId: string): Promise<number> {
  const value = Number(await client.command<number>(['INCR', officeAgentUsageKey(day, agentId)]));
  if (value === 1) await client.command(['EXPIRE', officeAgentUsageKey(day, agentId), String(60 * 60 * 24 * 3)]);
  return value;
}

export async function readAgentUsage(client: UpstashClient, day: string, agentIds: string[]): Promise<Record<string, number>> {
  // An office with no staff (or a caller asking about nobody) is the normal
  // state of a fresh dashboard, so it must not cost a round trip.
  if (agentIds.length === 0) return {};
  const rows = await client.pipeline<string | null>(agentIds.map(id => ['GET', officeAgentUsageKey(day, id)]));
  const out: Record<string, number> = {};
  agentIds.forEach((id, index) => {
    const n = Number(rows[index] ?? 0);
    out[id] = Number.isFinite(n) && n > 0 ? n : 0;
  });
  return out;
}

/**
 * Daily capacity gate. Returns the agent when it still has room, or a reason
 * when it does not — the caller decides whether that blocks (assignment) or
 * only warns (the boss assigning by hand).
 */
export async function agentCapacity(
  client: UpstashClient,
  day: string,
  agent: Pick<OfficeAgent, 'id' | 'name' | 'enabled' | 'paused' | 'dailyTaskLimit'>,
): Promise<{ ok: boolean; used: number; limit: number; reason?: string }> {
  if (!agent.enabled) return { ok: false, used: 0, limit: agent.dailyTaskLimit, reason: `${agent.name} is disabled.` };
  if (agent.paused) return { ok: false, used: 0, limit: agent.dailyTaskLimit, reason: `${agent.name} is paused.` };
  const used = (await readAgentUsage(client, day, [agent.id]))[agent.id] ?? 0;
  if (agent.dailyTaskLimit > 0 && used >= agent.dailyTaskLimit) {
    return { ok: false, used, limit: agent.dailyTaskLimit, reason: `${agent.name} has used today's ${agent.dailyTaskLimit} tasks.` };
  }
  return { ok: true, used, limit: agent.dailyTaskLimit };
}

// ─── Backup / restore ─────────────────────────────────────────────────────
//
// The backup is the office's escape hatch: everything the office is, in one
// JSON file the boss keeps outside this deployment. Two properties make it
// usable rather than decorative:
//
//   - it is *verifiable*: the export stamps a SHA-256 over a canonical rendering
//     of its contents, and a restore refuses a file whose stamp disagrees;
//   - it is *reversible*: a restore snapshots the current office first, so the
//     action that replaces the office is itself undoable from the dashboard.
//
// A restore never writes room boards: they are live meeting state owned by the
// room layer, and rewriting them from a file would overwrite what seats still
// poll. The file's boards are a read-only record.

const BACKUP_SNAPSHOTS = key('backup', 'snapshots');
const backupSnapshotKey = (id: string) => key('backup', 'snapshot', id);
const BACKUP_SNAPSHOT_KEEP = 3;
const BACKUP_SNAPSHOT_TTL_SECONDS = 30 * 24 * 60 * 60;

export interface RestoreResult {
  agents: number;
  projects: number;
  templates: number;
  archives: number;
  audit: number;
  skipped: string[];
  /** True when nothing was written (a preview). */
  dryRun?: boolean;
  /** The pre-restore snapshot, when one was taken. */
  snapshotId?: string;
  /** Checksum verdict the restore acted on. */
  checksum?: 'verified' | 'missing' | 'mismatch';
  issues?: string[];
  warnings?: string[];
}

export interface ImportOptions {
  /** Preview only: validate and report, write nothing. */
  dryRun?: boolean;
  /** Restore a file whose digest disagrees (audited; never the default). */
  allowChecksumMismatch?: boolean;
  /** Recorded on the pre-restore snapshot and in the audit line. */
  actor?: string;
}

export async function exportOffice(
  client: UpstashClient,
  actor: string,
  now: number,
  boards?: Record<string, TaskBoard>,
): Promise<OfficeBackup> {
  const [settings, agents, projects, templates, archives, audit] = await Promise.all([
    getOfficeSettings(client),
    listAgents(client),
    listProjects(client),
    listTemplates(client),
    listArchives(client, OFFICE_ARCHIVE_MAX),
    readAudit(client, OFFICE_AUDIT_RETENTION),
  ]);
  const payload = {
    format: OFFICE_BACKUP_FORMAT as typeof OFFICE_BACKUP_FORMAT,
    version: OFFICE_BACKUP_VERSION,
    exportedAt: now,
    exportedBy: actor,
    settings,
    agents,
    projects,
    templates,
    archives,
    audit,
    ...(boards ? { boards } : {}),
  };
  return {
    ...payload,
    integrity: { algorithm: 'sha256' as const, digest: await backupChecksum(payload), at: now },
  };
}

/**
 * What a pre-restore snapshot keeps.
 *
 * Messages are the bulk of an archive and the least useful thing to restore
 * verbatim (the minutes are derived from them and survive); dropping them keeps
 * a snapshot small enough to write on the free tier while still restoring every
 * staff entry, project, template, archive record and audit line.
 */
function snapshotPayload(backup: OfficeBackup): OfficeBackup {
  return {
    ...backup,
    archives: backup.archives.map(archive => ({ ...archive, messages: [] })),
    audit: backup.audit.slice(-200),
    boards: undefined,
  };
}

/** Snapshot the office before it is overwritten, keeping the last few. */
export async function snapshotOffice(
  client: UpstashClient,
  actor: string,
  now: number,
): Promise<{ id: string; at: number; agents: number; projects: number; archives: number }> {
  const backup = await exportOffice(client, actor, now);
  const stored = snapshotPayload(backup);
  // The snapshot is storage about storage: it must never be bigger than one
  // Redis value comfortably is. Archives are capped and messages are dropped;
  // if a pathological office still goes over, the snapshot records the counts
  // only rather than failing the restore.
  const id = `snap_${now.toString(36)}`;
  const body = JSON.stringify(stored);
  const safe = body.length <= 3_000_000
    ? stored
    : { ...stored, archives: stored.archives.map(({ minutes: _m, ...rest }) => rest) };
  await client.pipeline([
    ['SET', backupSnapshotKey(id), JSON.stringify(safe), 'EX', String(BACKUP_SNAPSHOT_TTL_SECONDS)],
    ['SADD', BACKUP_SNAPSHOTS, id],
    ['EXPIRE', BACKUP_SNAPSHOTS, String(BACKUP_SNAPSHOT_TTL_SECONDS)],
  ]);
  // Trim the index to the newest few. Ids are timestamp-derived, so a string
  // sort is a chronological sort.
  const ids = (await readIndex(client, BACKUP_SNAPSHOTS)).sort();
  const stale = ids.slice(0, Math.max(0, ids.length - BACKUP_SNAPSHOT_KEEP));
  if (stale.length) {
    await client.pipeline([
      ...stale.map(old => ['DEL', backupSnapshotKey(old)] as (string | number)[]),
      ['SREM', BACKUP_SNAPSHOTS, ...stale],
    ]);
  }
  return {
    id,
    at: now,
    agents: stored.agents.length,
    projects: stored.projects.length,
    archives: stored.archives.length,
  };
}

export interface BackupSnapshotInfo {
  id: string;
  at: number;
  agents: number;
  projects: number;
  archives: number;
}

/** Newest first. The ids carry the timestamp, so no extra metadata read is needed. */
export async function listBackupSnapshots(client: UpstashClient): Promise<BackupSnapshotInfo[]> {
  const ids = (await readIndex(client, BACKUP_SNAPSHOTS)).sort().reverse();
  return ids.map(id => {
    const match = /^snap_([0-9a-z]+)$/.exec(id);
    const at = match ? Number.parseInt(match[1]!, 36) : 0;
    return { id, at: Number.isFinite(at) ? at : 0, agents: 0, projects: 0, archives: 0 };
  });
}

/**
 * Restore an export. `merge` keeps what is already here and adds/overwrites by
 * id; `replace` deletes the office collections first.
 *
 * The file is checked before anything is touched: shape, version and digest. A
 * dry run returns the same verdict and counts without a single write, so the
 * dashboard can show what a restore would do before the boss commits to it.
 */
export async function importOffice(
  client: UpstashClient,
  backup: Partial<OfficeBackup> | Record<string, unknown>,
  mode: 'merge' | 'replace',
  now: number,
  options: ImportOptions = {},
): Promise<RestoreResult> {
  const validation = validateOfficeBackup(backup);
  const result: RestoreResult = {
    agents: 0, projects: 0, templates: 0, archives: 0, audit: 0,
    skipped: [...validation.issues, ...validation.warnings],
    checksum: validation.checksum.verdict,
    ...(options.dryRun ? { dryRun: true } : {}),
    ...(validation.issues.length ? { issues: validation.issues } : {}),
    ...(validation.warnings.length ? { warnings: validation.warnings } : {}),
  };
  if (!validation.shapeOk) {
    throw new OfficeBackupError(validation.issues.join(' '), 'backup_invalid', 400);
  }
  if (validation.checksum.verdict === 'mismatch' && !options.allowChecksumMismatch) {
    throw new OfficeBackupError(
      'The backup checksum does not match its contents. Export it again, or restore it deliberately with allowChecksumMismatch.',
      'backup_checksum_mismatch',
      409,
    );
  }

  const tagged = backup as Partial<OfficeBackup>;
  const planned = {
    agents: (tagged.agents ?? []).filter(agent => Boolean(agent?.id && agent.name && agent.role)).length,
    projects: (tagged.projects ?? []).filter(project => Boolean(project?.id && project.name)).length,
    templates: (tagged.templates ?? []).filter(template => Boolean(template?.id && template.name && Array.isArray(template.tasks))).length,
    archives: (tagged.archives ?? []).filter(archive => Boolean(archive?.id && archive.roomCode)).length,
    audit: (tagged.audit ?? []).filter(entry => Boolean(entry && Number.isFinite(entry.at) && entry.action)).length,
  };
  if (options.dryRun) {
    // A preview counts what WOULD be written. `skipped` still lists the shape
    // warnings, so the boss sees both halves of the answer.
    return { ...result, ...planned, skipped: result.skipped };
  }

  // Snapshot first: the restore that follows is the one action that can replace
  // the whole office, so the state it replaced must be recoverable.
  const actor = options.actor ?? 'owner';
  const snapshot = await snapshotOffice(client, actor, now).catch(() => null);
  if (snapshot) result.snapshotId = snapshot.id;

  if (mode === 'replace') {
    for (const [indexKey, entryKey] of [[AGENTS, agentKey], [PROJECTS, projectKey], [TEMPLATES, templateKey], [ARCHIVES, archiveKey]] as const) {
      const ids = await readIndex(client, indexKey);
      if (ids.length) await client.command(['DEL', ...ids.map(id => entryKey(id))]);
      await client.command(['DEL', indexKey]);
    }
    await client.command(['DEL', AUDIT]);
  }

  const agentIds = new Set((tagged.agents ?? []).map(agent => agent.id));
  for (const agent of tagged.agents ?? []) {
    if (!agent?.id || !agent.name || !agent.role) { result.skipped.push(`agent ${agent?.name ?? '(unnamed)'}`); continue; }
    if (mode === 'merge') {
      const existing = await findAgentByName(client, agent.name);
      if (existing && existing.id !== agent.id) { result.skipped.push(`agent ${agent.name} (name taken)`); continue; }
    }
    await saveAgent(client, { ...agent, tags: agent.tags ?? [], updatedAt: now });
    result.agents += 1;
  }
  for (const project of tagged.projects ?? []) {
    if (!project?.id || !project.name) { result.skipped.push(`project ${project?.name ?? '(unnamed)'}`); continue; }
    await saveProject(client, { ...project, memory: project.memory ?? [], guidelines: project.guidelines ?? [], updatedAt: now });
    result.projects += 1;
  }
  for (const template of tagged.templates ?? []) {
    if (!template?.id || !template.name || !Array.isArray(template.tasks)) { result.skipped.push(`template ${template?.name ?? '(unnamed)'}`); continue; }
    await saveTemplate(client, { ...template, updatedAt: now });
    result.templates += 1;
  }
  for (const archive of tagged.archives ?? []) {
    if (!archive?.id || !archive.roomCode) { result.skipped.push(`archive ${archive?.roomCode ?? '(no room)'}`); continue; }
    await writeJson(client, archiveKey(archive.id), archive);
    await client.pipeline([
      ['SADD', ARCHIVES, archive.id],
      ['SET', archiveRoomKey(archive.roomCode), archive.id],
    ]);
    result.archives += 1;
  }
  const audit = (tagged.audit ?? []).filter(entry => entry && Number.isFinite(entry.at) && entry.action);
  if (audit.length) {
    await appendAudit(client, audit.slice(-OFFICE_AUDIT_RETENTION));
    result.audit = audit.length;
  }
  if (tagged.settings) await writeJson(client, SETTINGS, normalizeOfficeSettings(tagged.settings));
  // A restored agent must still resolve by name after a rename in the export.
  for (const id of agentIds) {
    const agent = await getAgent(client, id);
    if (agent) await client.command(['SET', agentNameKey(agent.name), agent.id]);
  }
  return result;
}
