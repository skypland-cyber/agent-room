// The AI office: a permanent management layer above ephemeral rooms.
//
// A room is one meeting (30 days, one topic, its own code). The office is the
// standing organisation around those meetings: who the AI staff are, what each
// one may be asked to do, which projects they serve, what the boss approved,
// and what was decided in meetings that no longer exist. Nothing here is tied
// to a room's lifetime, which is why it lives in its own Redis keys with no TTL
// (see @agent-room/upstash-client/office.ts).
//
// This module is deliberately pure — types, validation and derived views only —
// so the same rules run in the browser dashboard, in the serverless function and
// in tests without a Redis or a clock of their own.

import type { ClientKind, Message, MessageKind, Room, Task as RoomTask, TaskState } from './types.js';
import { linkStateFor, type OfficeLinkState } from './linkRecovery.js';

/**
 * Ids are generated without crypto so the same helper runs in the browser:
 * these are user-visible keys, not security tokens, and every write path that
 * accepts one is authenticated.
 */
export function newOfficeId(prefix: string): string {
  const rand = Math.random().toString(36).slice(2, 10);
  return `${prefix}_${Date.now().toString(36)}${rand}`;
}

/** A seat is only considered connected while it keeps polling. */
export const OFFICE_HEARTBEAT_STALE_MS = 10 * 60_000;
export const OFFICE_HEARTBEAT_FRESH_MS = 90_000;
export const OFFICE_DEFAULT_DAILY_TASK_LIMIT = 20;
export const OFFICE_AUDIT_RETENTION = 1000;
export const OFFICE_ARCHIVE_MAX = 200;
export const OFFICE_MAX_MEMORY_ENTRIES = 500;
export const OFFICE_MAX_GUIDELINES = 100;
export const OFFICE_NAME_MAX = 80;
export const OFFICE_ROLE_MAX = 120;
export const OFFICE_TEXT_MAX = 20_000;
export const OFFICE_TAG_MAX = 40;

export type OfficeActorKind = 'owner' | 'agent' | 'host' | 'system';

export interface OfficeActor {
  name: string;
  kind: OfficeActorKind;
}

// ─── AI staff ──────────────────────────────────────────────────────────────

/**
 * A standing AI employee. This is a roster entry, not a session: the agent
 * proves it is alive by calling `room_listen` (which stamps a heartbeat), and
 * the dashboard derives `online/working/paused/offline` from that stamp plus
 * whatever the boards say it is holding right now.
 */
export interface OfficeAgent {
  id: string;                       // ag_xxxxxxxx
  name: string;                     // display name the agent answers to in a room
  role: string;                     // speciality, e.g. "Korean copywriter"
  tags: string[];                   // work it may be assigned (lowercased, deduped)
  dailyTaskLimit: number;           // tasks/day this agent may take
  /** Work created for this agent waits for the boss before an agent may claim it. */
  requiresApproval: boolean;
  /** Explicit pause: the office stops assigning work even if the seat is polling. */
  paused: boolean;
  enabled: boolean;
  /** Optional standing brief handed to the agent with each assignment. */
  brief?: string;
  model?: string;
  createdAt: number;
  updatedAt: number;
  createdBy: string;
  lastHeartbeatAt?: number;
  lastHeartbeatRoom?: string;
}

// ─── Room names vs roster names ───────────────────────────────────────────
//
// The roster has one plain name per AI ("Gemini", "망고"). The room layer, by
// contrast, hands out decorated display names for two very ordinary reasons:
//
//   - a seat that rejoins without its seatKey gets the room's collision suffix
//     (joinRoom: "Gemini" is taken, so the newcomer becomes "Gemini (2)"), and
//   - an agent that introduces itself with its role in brackets joins as
//     "망고 (총괄 매니저)".
//
// Both are the same staff member. Matching them by exact string left the office
// reading a working agent as offline — no heartbeat, no owned task, an empty
// desk — so the roster lookup strips the decoration instead.
//
// Only a *trailing* decoration is stripped: a collision suffix of 1–3 digits in
// brackets ("Gemini (2)"), or one bracketed qualifier at the end of the name
// ("망고 (총괄 매니저)"). Something inside the name ("AI (beta) team") is left
// alone, and a roster entry that literally carries the brackets always wins,
// because callers look for the exact name first.
export function officeBaseName(name: string): string {
  let value = typeof name === 'string' ? name.replace(/\s+/g, ' ').trim() : '';
  // Two decorations can stack ("Gemini (2) (백업)"), so peel them off one at a
  // time until the name stops changing.
  for (let pass = 0; pass < 3; pass++) {
    const stripped = value.replace(/\s*\(\s*\d{1,3}\s*\)$/, '').trim();
    const qualified = /^(.*?)\s*\([^()]{1,60}\)$/.exec(stripped);
    const next = qualified && qualified[1]!.trim() ? qualified[1]!.trim() : stripped;
    if (next === value) break;
    value = next;
  }
  return value;
}

/** Do two room names name the same staff member once decorations are ignored? */
export function officeNamesMatch(a: string | undefined, b: string | undefined): boolean {
  const left = officeBaseName(a ?? '').toLowerCase();
  const right = officeBaseName(b ?? '').toLowerCase();
  return Boolean(left) && left === right;
}

export type OfficeAgentStatus = 'working' | 'reviewing' | 'idle' | 'paused' | 'offline';

/**
 * Who is actually driving a seat.
 *
 * The same staff member can be at its desk in two very different ways, and from
 * the floor they used to look identical:
 *
 *   - `external` — a client the person opened themselves (Codex, ChatGPT, an
 *     Antigravity CLI window) joined the room and is polling under its own name.
 *   - `delegated` — the person's own assistant is keeping the seat warm and
 *     doing the work on that staff member's behalf, with no client window open.
 *
 * A seat that says nothing is read as `external`: an MCP client has to know
 * about this field at all to send it, so silence means an ordinary outside
 * client rather than a delegated runner.
 */
export type OfficeConnectionMode = 'external' | 'delegated';

/** Read a stored or submitted value as a connection mode. Anything else is "not given". */
export function parseOfficeConnectionMode(value: unknown): OfficeConnectionMode | undefined {
  return value === 'external' || value === 'delegated' ? value : undefined;
}

export interface OfficeAgentPresence {
  status: OfficeAgentStatus;
  label: string;
  /** Minutes since the heartbeat, when there is one. */
  heartbeatAgeMs?: number;
  /** The task the agent is holding right now, if any. */
  taskId?: string;
  roomCode?: string;
  /** What that task is called. The floor shows it over the agent's head. */
  taskTitle?: string;
  /** Where that task stands on the board. */
  taskState?: TaskState;
  /**
   * When the execution lease on that task runs out.
   *
   * Only sent while the lease is live. A lease about to expire is the one piece
   * of presence that needs acting on — the work is about to be recoverable by
   * somebody else — so the floor gives it its own colour instead of waiting for
   * the card to fall back to `todo`.
   */
  leaseEndsAt?: number;
  /** 0–100: subtasks done when the card has any, otherwise the state's stage. */
  taskProgress?: number;
  /** The subtask tally `taskProgress` was read from, when the card has subtasks. */
  taskSubtasks?: { done: number; total: number };
  /**
   * How this seat is being driven, from its latest heartbeat.
   *
   * Sent only while the seat is online: an offline desk is offline whichever
   * way it was driven, and the last mode it used would be a claim about right
   * now that nobody can back. An older heartbeat that never carried the field
   * leaves it out too, so the floor can say "unknown" rather than guess.
   */
  connectionMode?: OfficeConnectionMode;
  /**
   * How the link is behaving, next to the coarser `status` above.
   *
   * `status` answers "what is this seat doing"; this answers "is it still
   * there, and since when". The dashboard shows the second as a line under the
   * name — a seat that went quiet four minutes ago is drawn as offline by
   * nothing at all, because presence only gives up at ten minutes.
   */
  link?: OfficeLinkState;
}

/**
 * How far along a card is, from its state alone.
 *
 * Claiming a task and working on it are the same step on this board (`claim`
 * moves it to `in_progress`), so both read 50. A rejected card keeps the work
 * it did but has to come back, hence 60 rather than 80.
 */
export const TASK_STATE_PROGRESS: Record<TaskState, number> = {
  todo: 0,
  pending_approval: 10,
  in_progress: 50,
  paused: 50,
  blocked: 50,
  awaiting_review: 80,
  rejected: 60,
  done: 100,
  cancelled: 100,
  aborted: 100,
};

/** A lease this close to its end is shown as "about to expire" on the floor. */
export const TASK_LEASE_SOON_MS = 3 * 60_000;

/** 0–100 progress for one card: its own subtasks when it has them, else its state. */
export function taskProgressPercent(task: { state?: TaskState; subtasks?: { done: number; total: number } }): number {
  const subtasks = task.subtasks;
  if (subtasks && subtasks.total > 0) {
    return Math.max(0, Math.min(100, Math.round((subtasks.done / subtasks.total) * 100)));
  }
  return task.state ? TASK_STATE_PROGRESS[task.state] : 0;
}

export const OFFICE_AGENT_STATUS_LABEL: Record<OfficeAgentStatus, string> = {
  working: 'Working',
  reviewing: 'Reviewing',
  idle: 'Available',
  paused: 'Paused',
  offline: 'Offline',
};

/** One card an agent is holding, as much as presence needs to describe it. */
export interface AgentTaskActivity {
  code: string;
  id: string;
  title?: string;
  state?: TaskState;
  /** When its execution lease runs out, if one is held. */
  leaseEndsAt?: number;
  /** Self-ticked breakdown, when the card has one. */
  subtasks?: { done: number; total: number };
}

export interface AgentActivity {
  heartbeatAt?: number;
  /** How the seat is being driven, carried by the heartbeat that keeps it alive. */
  connectionMode?: OfficeConnectionMode;
  /** Tasks this agent owns and is executing (in_progress / rejected). */
  active?: AgentTaskActivity[];
  /** Reviews waiting on this agent. */
  reviews?: AgentTaskActivity[];
  /** Reconnections recorded for this seat in the retention window. */
  reconnects?: number;
  /** When work was last resumed after a reconnection. */
  lastResumeAt?: number;
}

/** The presence fields that describe the card an agent is holding. */
function taskPresence(task: AgentTaskActivity, now: number): Pick<OfficeAgentPresence, 'taskTitle' | 'taskState' | 'leaseEndsAt' | 'taskProgress' | 'taskSubtasks'> {
  const subtasks = task.subtasks;
  return {
    ...(task.title ? { taskTitle: task.title } : {}),
    ...(task.state ? { taskState: task.state } : {}),
    // A lease that has already run out is history, not pressure: leave it off.
    ...(task.leaseEndsAt !== undefined && task.leaseEndsAt > now ? { leaseEndsAt: task.leaseEndsAt } : {}),
    taskProgress: taskProgressPercent(task),
    ...(subtasks && subtasks.total > 0 ? { taskSubtasks: { done: subtasks.done, total: subtasks.total } } : {}),
  };
}

/**
 * Derived presence. Order matters: an explicit pause outranks a fresh
 * heartbeat (a paused agent that keeps polling is still paused), and a stale
 * heartbeat outranks board work (a task left in_progress by a dead seat must
 * not paint the desk green).
 */
export function agentPresence(agent: OfficeAgent, activity: AgentActivity, now: number): OfficeAgentPresence {
  const heartbeatAt = activity.heartbeatAt ?? agent.lastHeartbeatAt;
  const heartbeatAgeMs = heartbeatAt ? Math.max(0, now - heartbeatAt) : undefined;
  // The link description travels with every presence, including the disabled
  // and paused ones: "last heard from" is a fact about the connection, not a
  // judgement about the seat's status.
  const link = linkStateFor({
    ...(heartbeatAt !== undefined ? { lastHealthyAt: heartbeatAt } : {}),
    now,
    ...(activity.reconnects !== undefined ? { reconnects: activity.reconnects } : {}),
    ...(activity.lastResumeAt !== undefined ? { lastResumeAt: activity.lastResumeAt } : {}),
  });
  // Presence only names the connection mode of a seat that is actually here: an
  // offline desk keeps the offline look, and a paused one is paused, not driven.
  const driven = activity.connectionMode ? { connectionMode: activity.connectionMode } : {};
  if (!agent.enabled) {
    return { status: 'offline', label: 'Disabled', ...(heartbeatAgeMs !== undefined ? { heartbeatAgeMs } : {}), link };
  }
  if (agent.paused) {
    return { status: 'paused', label: 'Paused', ...(heartbeatAgeMs !== undefined ? { heartbeatAgeMs } : {}), link };
  }
  const fresh = heartbeatAgeMs !== undefined && heartbeatAgeMs <= OFFICE_HEARTBEAT_STALE_MS;
  if (!fresh) {
    return { status: 'offline', label: 'Offline', ...(heartbeatAgeMs !== undefined ? { heartbeatAgeMs } : {}), link };
  }
  const review = activity.reviews?.[0];
  if (review) {
    return {
      status: 'reviewing', label: 'Reviewing', heartbeatAgeMs, link, ...driven,
      taskId: review.id, roomCode: review.code, ...taskPresence(review, now),
    };
  }
  const active = activity.active?.[0];
  if (active) {
    return {
      status: 'working', label: 'Working', heartbeatAgeMs, link, ...driven,
      taskId: active.id, roomCode: active.code, ...taskPresence(active, now),
    };
  }
  return { status: 'idle', label: 'Available', heartbeatAgeMs, link, ...driven };
}

export interface OfficeAgentView extends OfficeAgent {
  presence: OfficeAgentPresence;
  /** Tasks this agent created/owns today (from the usage counters). */
  tasksToday: number;
  remainingToday: number;
}

function clean(value: unknown, max: number): string {
  return typeof value === 'string' ? value.replace(/\s+/g, ' ').trim().slice(0, max) : '';
}

export function normalizeOfficeTags(input: unknown): string[] {
  const raw = Array.isArray(input) ? input : typeof input === 'string' ? input.split(',') : [];
  const seen = new Set<string>();
  const tags: string[] = [];
  for (const item of raw) {
    const tag = clean(item, OFFICE_TAG_MAX).toLowerCase();
    if (!tag || seen.has(tag)) continue;
    seen.add(tag);
    tags.push(tag);
    if (tags.length >= 12) break;
  }
  return tags;
}

export class OfficeInputError extends Error {
  constructor(message: string, readonly field?: string) {
    super(message);
    this.name = 'OfficeInputError';
  }
}

export interface AgentInput {
  id?: string;
  name?: unknown;
  role?: unknown;
  tags?: unknown;
  dailyTaskLimit?: unknown;
  requiresApproval?: unknown;
  paused?: unknown;
  enabled?: unknown;
  brief?: unknown;
  model?: unknown;
}

export interface NormalizedAgent {
  name: string;
  role: string;
  tags: string[];
  dailyTaskLimit: number;
  requiresApproval: boolean;
  paused: boolean;
  enabled: boolean;
  brief?: string;
  model?: string;
}

export function normalizeAgentInput(input: AgentInput): NormalizedAgent {
  const name = clean(input.name, OFFICE_NAME_MAX);
  if (!name) throw new OfficeInputError('An AI staff member needs a name.', 'name');
  if (name.length < 2) throw new OfficeInputError('Use at least two characters for a name.', 'name');
  const role = clean(input.role, OFFICE_ROLE_MAX);
  if (!role) throw new OfficeInputError('Describe the role or speciality (e.g. "Korean copywriter").', 'role');
  const limitRaw = input.dailyTaskLimit;
  const limit = limitRaw === undefined || limitRaw === null || limitRaw === ''
    ? OFFICE_DEFAULT_DAILY_TASK_LIMIT
    : Number(limitRaw);
  if (!Number.isInteger(limit) || limit < 0 || limit > 500) {
    throw new OfficeInputError('The daily task limit must be a whole number between 0 and 500.', 'dailyTaskLimit');
  }
  const brief = clean(input.brief, 4000);
  const model = clean(input.model, 80);
  return {
    name,
    role,
    tags: normalizeOfficeTags(input.tags),
    dailyTaskLimit: limit,
    requiresApproval: input.requiresApproval === true,
    paused: input.paused === true,
    enabled: input.enabled !== false,
    ...(brief ? { brief } : {}),
    ...(model ? { model } : {}),
  };
}

// ─── Projects: a workspace with memory and standing instructions ───────────

export interface OfficeMemoryEntry {
  id: string;
  title: string;
  body: string;
  tags: string[];
  pinned: boolean;
  createdAt: number;
  updatedAt: number;
  by: string;
}

export interface OfficeGuideline {
  id: string;
  title: string;
  body: string;
  updatedAt: number;
  by: string;
}

export interface OfficeProject {
  id: string;                        // prj_xxxxxxxx
  name: string;
  description: string;
  status: 'active' | 'archived';
  /** Rooms opened for this project. */
  roomCodes: string[];
  /** Agent ids assigned to the project. */
  agentIds: string[];
  /** Vault file ids attached to the project (materials or deliverables). */
  fileIds: string[];
  /** Task ids that belong to this project, with the room they live in. */
  taskRefs: Array<{ code: string; id: string }>;
  memory: OfficeMemoryEntry[];
  guidelines: OfficeGuideline[];
  createdAt: number;
  updatedAt: number;
  createdBy: string;
}

export interface OfficeProjectSummary extends OfficeProject {
  openTasks: number;
  memoryCount: number;
  guidelineCount: number;
}

export function normalizeProjectInput(input: { name?: unknown; description?: unknown; status?: unknown }): {
  name: string; description: string; status: 'active' | 'archived';
} {
  const name = clean(input.name, OFFICE_NAME_MAX);
  if (!name) throw new OfficeInputError('A project needs a name.', 'name');
  const description = clean(input.description, 1000);
  const status = input.status === 'archived' ? 'archived' as const : 'active' as const;
  return { name, description, status };
}

function requireText(value: unknown, field: string, message: string, max = OFFICE_TEXT_MAX): string {
  if (typeof value !== 'string' || !value.trim()) throw new OfficeInputError(message, field);
  if (value.length > max) throw new OfficeInputError(`Keep this under ${max.toLocaleString()} characters.`, field);
  return value.trim();
}

export function normalizeMemoryInput(input: { title?: unknown; body?: unknown; tags?: unknown; pinned?: unknown }): {
  title: string; body: string; tags: string[]; pinned: boolean;
} {
  return {
    title: clean(input.title, 120) || 'Note',
    body: requireText(input.body, 'body', 'Write what should be remembered.'),
    tags: normalizeOfficeTags(input.tags),
    pinned: input.pinned === true,
  };
}

export function normalizeGuidelineInput(input: { title?: unknown; body?: unknown }): { title: string; body: string } {
  return {
    title: clean(input.title, 160) || 'Instruction',
    body: requireText(input.body, 'body', 'Write the instruction the agents must follow.'),
  };
}

// ─── Recurring work templates ──────────────────────────────────────────────

export interface OfficeTemplateTask {
  title: string;
  dod?: string;
  /** Assignment by staff tag; resolved to a free agent when the template runs. */
  tag?: string;
  owner?: string;
  verifier?: string;
  requiresApproval?: boolean;
  estimateMinutes?: number;
}

export interface OfficeTemplate {
  id: string;                        // tpl_xxxxxxxx
  name: string;
  description: string;
  /** Room topic used when the template opens a room. */
  topic: string;
  projectId?: string;
  tasks: OfficeTemplateTask[];
  /** Standing instructions copied into the new room's first system message. */
  guidelines?: string;
  createdAt: number;
  updatedAt: number;
  createdBy: string;
}

export function normalizeTemplateInput(input: {
  name?: unknown; description?: unknown; topic?: unknown; projectId?: unknown; tasks?: unknown; guidelines?: unknown;
}): { name: string; description: string; topic: string; projectId?: string; tasks: OfficeTemplateTask[]; guidelines?: string } {
  const name = clean(input.name, OFFICE_NAME_MAX);
  if (!name) throw new OfficeInputError('A template needs a name.', 'name');
  const topic = clean(input.topic, 300) || name;
  const tasksRaw = Array.isArray(input.tasks) ? input.tasks : [];
  if (tasksRaw.length === 0) throw new OfficeInputError('A template needs at least one task.', 'tasks');
  if (tasksRaw.length > 30) throw new OfficeInputError('A template may hold at most 30 tasks.', 'tasks');
  const tasks: OfficeTemplateTask[] = tasksRaw.map((item, index) => {
    const task = (item ?? {}) as Record<string, unknown>;
    const title = clean(task.title, 200);
    if (!title) throw new OfficeInputError(`Task ${index + 1} needs a title.`, 'tasks');
    const owner = clean(task.owner, OFFICE_NAME_MAX);
    const verifier = clean(task.verifier, OFFICE_NAME_MAX);
    if (owner && verifier && owner.toLowerCase() === verifier.toLowerCase()) {
      throw new OfficeInputError(`Task ${index + 1}: the verifier must differ from the owner.`, 'tasks');
    }
    const estimate = Number(task.estimateMinutes);
    return {
      title,
      ...(clean(task.dod, 2000) ? { dod: clean(task.dod, 2000) } : {}),
      ...(normalizeOfficeTags([task.tag])[0] ? { tag: normalizeOfficeTags([task.tag])[0]! } : {}),
      ...(owner ? { owner } : {}),
      ...(verifier ? { verifier } : {}),
      ...(task.requiresApproval === true ? { requiresApproval: true } : {}),
      ...(Number.isFinite(estimate) && estimate > 0 ? { estimateMinutes: Math.min(estimate, 10_000) } : {}),
    };
  });
  return {
    name,
    description: clean(input.description, 1000),
    topic,
    ...(clean(input.projectId, 40) ? { projectId: clean(input.projectId, 40) } : {}),
    tasks,
    ...(clean(input.guidelines, 6000) ? { guidelines: clean(input.guidelines, 6000) } : {}),
  };
}

/**
 * Resolve a template into concrete task drafts before anything is written.
 * Assignment is by tag, choosing the least loaded enabled agent that carries
 * the tag; a template whose agent is paused or out of quota still produces its
 * tasks, but they are left unassigned so the boss sees the gap instead of a
 * task pointing at someone who will never pick it up.
 */
export interface TemplateAssignment {
  index: number;
  agentId?: string;
  agentName?: string;
  requiresApproval: boolean;
}

export function planTemplateRun(
  template: Pick<OfficeTemplate, 'tasks'>,
  agents: Array<Pick<OfficeAgent, 'id' | 'name' | 'tags' | 'enabled' | 'paused' | 'requiresApproval' | 'dailyTaskLimit'>>,
  load: Record<string, number> = {},
): TemplateAssignment[] {
  const busy = new Map(agents.map(agent => [agent.id, load[agent.id] ?? 0]));
  return template.tasks.map((task, index) => {
    const candidates = agents
      .filter(agent => agent.enabled && !agent.paused)
      .filter(agent => !task.tag || agent.tags.includes(task.tag))
      .filter(agent => !task.owner || agent.name.trim().toLowerCase() === task.owner.trim().toLowerCase())
      .filter(agent => (busy.get(agent.id) ?? 0) < agent.dailyTaskLimit)
      .sort((a, b) => (busy.get(a.id) ?? 0) - (busy.get(b.id) ?? 0) || a.name.localeCompare(b.name));
    const chosen = candidates[0];
    if (chosen) busy.set(chosen.id, (busy.get(chosen.id) ?? 0) + 1);
    return {
      index,
      ...(chosen ? { agentId: chosen.id, agentName: chosen.name } : {}),
      requiresApproval: task.requiresApproval === true || chosen?.requiresApproval === true,
    };
  });
}

// ─── Permanent meeting archive ─────────────────────────────────────────────

export interface OfficeArchiveMessage {
  name: string;
  role?: string;
  text: string;
  at: number;
}

/**
 * One deliverable as the archive remembers it.
 *
 * The bytes live in private object storage under a prefix that room cleanup
 * never touches, and their metadata record carries no TTL — so a deliverable
 * outlives the room that produced it. This snapshot is what makes the *index*
 * outlive the room too: after 30 days the room's own vault keys are gone, and
 * the office still knows every file by id, size and producer.
 */
export interface OfficeArchiveFile {
  id: string;
  name: string;
  mime: string;
  size: number;
  version: number;
  producer?: string;
  taskId?: string;
  createdAt: number;
  /** Storage key, so a later download does not depend on the room's vault keys. */
  storageKey: string;
}

export interface OfficeArchive {
  id: string;                        // arc_xxxxxxxx
  roomCode: string;
  topic: string;
  createdBy: string;
  roomCreatedAt: number;
  archivedAt: number;
  participants: string[];
  messageCount: number;
  summary: string;
  minutes: string;
  messages: OfficeArchiveMessage[];
  tasks: Array<{ id: string; title: string; state: string; owner?: string; verifier?: string }>;
  projectId?: string;
  tags: string[];
  /** Deliverables produced in the room — kept after the room itself expires. */
  deliverables?: OfficeArchiveFile[];
  /** Materials were room-scoped working files; only their count is kept. */
  materialCount?: number;
  /** The room this one was handed over to, when it was. */
  successorRoomCode?: string;
}

/** Compact, greppable minutes built from the transcript — no model call. */
export function buildMinutes(input: {
  room: Pick<Room, 'code' | 'topic' | 'createdBy' | 'createdAt'>;
  messages: Message[];
  tasks?: RoomTask[];
  archivedAt: number;
}): { summary: string; minutes: string; messages: OfficeArchiveMessage[] } {
  const { room, messages, tasks = [], archivedAt } = input;
  const people = [...new Set(messages.map(m => m.name))];
  const decisions = messages.filter(m => /\[DECISION\]/i.test(m.text));
  const todos = messages.filter(m => /\[TODO\]/i.test(m.text));
  const results = messages.filter(m => /\[RESULT\]/i.test(m.text));
  const first = (m: Message) => m.text.replace(/\s+/g, ' ').slice(0, 180);
  const summaryParts = [
    `${messages.length} messages, ${people.length} participants`,
    decisions.length ? `${decisions.length} decisions` : '',
    results.length ? `${results.length} results` : '',
    tasks.length ? `${tasks.filter(t => t.state === 'done').length}/${tasks.length} tasks done` : '',
  ].filter(Boolean);
  const lines = [
    `# ${room.topic}`,
    '',
    `- Room: ${room.code}`,
    `- Host: ${room.createdBy}`,
    `- Started: ${new Date(room.createdAt).toISOString()}`,
    `- Archived: ${new Date(archivedAt).toISOString()}`,
    `- Participants: ${people.join(', ') || '(none)'}`,
    '',
    '## Summary',
    summaryParts.join(' · '),
    '',
  ];
  if (decisions.length) {
    lines.push('## Decisions', ...decisions.slice(-12).map(m => `- ${first(m)} *(${m.name})*`), '');
  }
  if (results.length) {
    lines.push('## Results', ...results.slice(-12).map(m => `- ${first(m)} *(${m.name})*`), '');
  }
  if (todos.length) {
    lines.push('## Open items', ...todos.slice(-12).map(m => `- ${first(m)} *(${m.name})*`), '');
  }
  if (tasks.length) {
    lines.push('## Task board', ...tasks.map(t =>
      `- ${t.id} ${t.title} — ${t.state}${t.owner ? ` (owner ${t.owner})` : ''}${t.verifier ? `, verifier ${t.verifier}` : ''}`), '');
  }
  lines.push('## Transcript');
  for (const m of messages) {
    lines.push(`- **${m.name}** ${new Date(m.time).toISOString().slice(11, 16)} — ${m.text.replace(/\s+/g, ' ').slice(0, 400)}`);
  }
  return {
    summary: summaryParts.join(' · '),
    minutes: lines.join('\n'),
    messages: messages.map(m => ({
      name: m.name,
      ...(m.role ? { role: m.role } : {}),
      text: m.text.slice(0, 4000),
      at: m.time,
    })),
  };
}

/**
 * One line of the live minutes: who said it, what was tagged, when.
 *
 * `text` has the bracket tag peeled off and its whitespace folded, because the
 * panel that shows this already prints the tag as the section heading.
 */
export interface OfficeRoomDigestItem {
  name: string;
  text: string;
  at: number;
}

/**
 * The 회의록 tab of the office's team chat: the same reading of a transcript the
 * archive makes, but for a room that is still running and without the markdown.
 *
 * It is built from the messages the caller already had to read for the chat, so
 * opening the minutes costs no extra Redis command and can never disagree with
 * the conversation beside it. Text is trimmed rather than rewritten: the boss
 * reads the decisions [DECISION] lines carry, not a model's summary of them.
 */
export interface OfficeRoomDigest {
  messageCount: number;
  /** Distinct speakers, in the order they first spoke. */
  participants: string[];
  decisions: OfficeRoomDigestItem[];
  results: OfficeRoomDigestItem[];
  openItems: OfficeRoomDigestItem[];
  board: { total: number; done: number; open: number; pendingApproval: number };
  tasks: Array<{ id: string; title: string; state: string; owner?: string }>;
}

/** How many items each tagged section of the digest keeps: the newest ones. */
export const ROOM_DIGEST_ITEM_LIMIT = 8;

function digestLine(text: string, tag: RegExp): string {
  return text.replace(tag, '').replace(/\s+/g, ' ').trim().slice(0, 240);
}

/**
 * Build the live minutes of a room from its transcript and its board.
 *
 * Sections are only present when they have something in them, and a tagged
 * line that is nothing but its tag is dropped: an empty heading is worse than
 * no heading.
 */
export function buildRoomDigest(input: {
  messages: readonly Message[];
  tasks?: readonly Pick<RoomTask, 'id' | 'title' | 'state' | 'owner'>[];
}): OfficeRoomDigest {
  const { messages, tasks = [] } = input;
  const participants: string[] = [];
  const seen = new Set<string>();
  for (const message of messages) {
    const key = message.name.trim().toLowerCase();
    if (!key || seen.has(key)) continue;
    seen.add(key);
    participants.push(message.name.trim());
  }

  const collect = (pattern: RegExp): OfficeRoomDigestItem[] => {
    const out: OfficeRoomDigestItem[] = [];
    for (const message of messages) {
      if (!pattern.test(message.text)) continue;
      const text = digestLine(message.text, pattern);
      if (!text) continue;
      out.push({ name: message.name, text, at: message.time });
    }
    return out.slice(-ROOM_DIGEST_ITEM_LIMIT);
  };

  const done = tasks.filter(task => task.state === 'done').length;
  return {
    messageCount: messages.length,
    participants,
    decisions: collect(/\[DECISION\]/gi),
    results: collect(/\[RESULT\]/gi),
    openItems: collect(/\[TODO\]/gi),
    board: {
      total: tasks.length,
      done,
      open: tasks.length - done,
      pendingApproval: tasks.filter(task => task.state === 'pending_approval').length,
    },
    tasks: tasks.slice(0, 40).map(task => ({
      id: task.id,
      title: task.title,
      state: task.state,
      ...(task.owner ? { owner: task.owner } : {}),
    })),
  };
}

/**
 * One line of a room as the office's team chat receives it.
 *
 * Same shape as the room's own `Message` minus the parts the office cannot use:
 * attachment URLs are signed per request, so only the label travels (the panel
 * shows that a file came with the line, and the room screen stays the place to
 * open it). `event` keeps the system-event type so the panel can tell a handoff
 * note from an agent talking.
 */
export interface OfficeChatMessage {
  id: number;
  type: MessageKind;
  name: string;
  role: string;
  color: string;
  initials: string;
  client: ClientKind;
  text: string;
  time: number;
  attachments?: Array<{ id: string; name: string; type: string; mime: string; size: number }>;
  event?: string;
}

/** The room as the chat panel addresses it: the roster, without any key hashes. */
export interface OfficeChatRoom {
  code: string;
  topic: string;
  status: string;
  createdBy: string;
  createdAt: number;
  endedAt?: number;
  replyMode: string;
  participants: Array<{ name: string; role: string; client: ClientKind; isHost: boolean; muted: boolean }>;
}

/**
 * One answer of `rooms.chat`.
 *
 * `messages` is a window, not the room: a first read takes the tail, a poll sends
 * `since` and gets only what arrived, and `total` is the cursor the next poll
 * sends. `reset` says the window had to jump (a poll that fell more than a
 * screenful behind), so the panel replaces the transcript instead of appending.
 */
export interface OfficeRoomChat {
  room: OfficeChatRoom;
  messages: OfficeChatMessage[];
  total: number;
  reset?: boolean;
  /** Only on the 회의록 read: the live minutes of the same transcript. */
  digest?: OfficeRoomDigest;
}

/** Case-insensitive keyword match over the title, minutes, summary and messages. */
export function archiveMatches(archive: OfficeArchive, query: string): boolean {
  const q = query.trim().toLowerCase();
  if (!q) return true;
  const haystack = [
    archive.topic, archive.summary, archive.minutes, archive.roomCode,
    ...archive.tags, ...archive.participants,
    ...archive.messages.map(m => m.text),
    ...archive.tasks.map(t => `${t.id} ${t.title} ${t.state}`),
  ].join('\n').toLowerCase();
  if (haystack.includes(q)) return true;
  // Every word must appear somewhere, so "상패 견적" narrows rather than widens.
  const words = q.split(/\s+/).filter(Boolean);
  return words.length > 1 && words.every(word => haystack.includes(word));
}

/** The snippet a search result shows: the first line that carries the query. */
export function archiveSnippet(archive: OfficeArchive, query: string, width = 220): string {
  const q = query.trim().toLowerCase();
  if (!q) return archive.summary;
  for (const line of archive.minutes.split('\n')) {
    if (line.toLowerCase().includes(q)) return line.slice(0, width);
  }
  const message = archive.messages.find(m => m.text.toLowerCase().includes(q));
  return (message?.text ?? archive.summary).slice(0, width);
}

// ─── Audit log ────────────────────────────────────────────────────────────

export interface OfficeAuditEntry {
  id: string;
  at: number;
  actor: OfficeActor;
  action: string;                    // 'login' | 'agent.create' | 'task.approve' | 'file.upload' …
  target?: string;
  roomCode?: string;
  detail?: string;
  meta?: Record<string, string | number | boolean>;
}

export interface AuditQuery {
  actor?: string;
  action?: string;
  target?: string;
  roomCode?: string;
  from?: number;
  to?: number;
  limit?: number;
}

export function matchAuditEntry(entry: OfficeAuditEntry, query: AuditQuery): boolean {
  if (query.actor && !entry.actor.name.toLowerCase().includes(query.actor.toLowerCase())) return false;
  if (query.action && !entry.action.toLowerCase().startsWith(query.action.toLowerCase())) return false;
  if (query.target && !(entry.target ?? '').toLowerCase().includes(query.target.toLowerCase())) return false;
  if (query.roomCode && entry.roomCode !== query.roomCode) return false;
  if (query.from !== undefined && entry.at < query.from) return false;
  if (query.to !== undefined && entry.at > query.to) return false;
  return true;
}

/** Newest first, capped. The store keeps at most OFFICE_AUDIT_RETENTION rows. */
export function filterAudit(entries: OfficeAuditEntry[], query: AuditQuery = {}): OfficeAuditEntry[] {
  const limit = Math.min(Math.max(1, query.limit ?? 100), 500);
  return entries.filter(entry => matchAuditEntry(entry, query))
    .sort((a, b) => b.at - a.at)
    .slice(0, limit);
}

// ─── Usage and limits ─────────────────────────────────────────────────────

export interface OfficeSettings {
  /** Office API requests per day before the dashboard warns. Free-tier oriented. */
  dailyRequestBudget: number;
  /** Fraction of the budget at which the dashboard turns amber. */
  warnRatio: number;
  defaultAgentDailyLimit: number;
  offlineAfterMs: number;
  /** Automatic retries before an owner is asked to take over. */
  autoRetryLimit: number;
  /** Hand a failed task to a peer agent once retries are exhausted. */
  autoHandoff: boolean;
  /** Require a peer QA pass before a completed task is marked done. */
  requireQa: boolean;
  /**
   * Grace period, in minutes, before a room whose board is fully done is
   * archived and closed automatically. 0 disables the rule. A room with no
   * cards is never a candidate, and any new card / card leaving `done` / new
   * message inside the window cancels or postpones the close.
   * `AUTO_CLOSE_EMPTY_ROOM_MINUTES` in the deployment overrides this.
   */
  autoCloseEmptyRoomMinutes: number;
}

export const OFFICE_DEFAULT_SETTINGS: OfficeSettings = {
  dailyRequestBudget: 10_000,
  warnRatio: 0.8,
  defaultAgentDailyLimit: OFFICE_DEFAULT_DAILY_TASK_LIMIT,
  offlineAfterMs: OFFICE_HEARTBEAT_STALE_MS,
  autoRetryLimit: 2,
  autoHandoff: true,
  requireQa: false,
  autoCloseEmptyRoomMinutes: 10,
};

export function normalizeOfficeSettings(input: Partial<Record<keyof OfficeSettings, unknown>>): OfficeSettings {
  const num = (value: unknown, fallback: number, min: number, max: number) => {
    const n = Number(value);
    return Number.isFinite(n) && n >= min && n <= max ? Math.floor(n) : fallback;
  };
  const bool = (value: unknown, fallback: boolean) => (value === true ? true : value === false ? false : fallback);
  const ratio = Number(input.warnRatio);
  return {
    dailyRequestBudget: num(input.dailyRequestBudget, OFFICE_DEFAULT_SETTINGS.dailyRequestBudget, 100, 10_000_000),
    warnRatio: Number.isFinite(ratio) && ratio > 0.1 && ratio <= 1 ? ratio : OFFICE_DEFAULT_SETTINGS.warnRatio,
    defaultAgentDailyLimit: num(input.defaultAgentDailyLimit, OFFICE_DEFAULT_SETTINGS.defaultAgentDailyLimit, 0, 500),
    offlineAfterMs: num(input.offlineAfterMs, OFFICE_DEFAULT_SETTINGS.offlineAfterMs, 60_000, 24 * 3_600_000),
    autoRetryLimit: num(input.autoRetryLimit, OFFICE_DEFAULT_SETTINGS.autoRetryLimit, 0, 10),
    autoHandoff: bool(input.autoHandoff, OFFICE_DEFAULT_SETTINGS.autoHandoff),
    requireQa: bool(input.requireQa, OFFICE_DEFAULT_SETTINGS.requireQa),
    // 0 is a real choice (off); a missing or unusable value keeps the default.
    autoCloseEmptyRoomMinutes: input.autoCloseEmptyRoomMinutes === 0 || input.autoCloseEmptyRoomMinutes === '0'
      ? 0
      : num(input.autoCloseEmptyRoomMinutes, OFFICE_DEFAULT_SETTINGS.autoCloseEmptyRoomMinutes, 1, 24 * 60),
  };
}

export type OfficeUsageLevel = 'ok' | 'warn' | 'critical';

export interface OfficeUsageSnapshot {
  day: string;                       // YYYY-MM-DD (Asia/Seoul)
  requests: number;
  writeRequests: number;
  requestBudget: number;
  requestLevel: OfficeUsageLevel;
  percent: number;                   // 0..100+, of the request budget
  agents: Array<{ id: string; name: string; tasksToday: number; limit: number; level: OfficeUsageLevel }>;
  notes: string[];
}

export function kstDay(now: number): string {
  return new Date(now + 9 * 3_600_000).toISOString().slice(0, 10);
}

export function usageLevel(used: number, budget: number, warnRatio = 0.8): OfficeUsageLevel {
  if (budget <= 0) return 'ok';
  const ratio = used / budget;
  if (ratio >= 1) return 'critical';
  if (ratio >= warnRatio) return 'warn';
  return 'ok';
}

// ─── Dashboard payload ────────────────────────────────────────────────────

export interface OfficeTaskRef {
  code: string;
  roomTopic: string;
  id: string;
  title: string;
  state: string;
  owner?: string;
  verifier?: string;
  updatedAt: number;
  requiresApproval?: boolean;
  retryCount?: number;
  qaStatus?: string;
  approvalNote?: string;
}

export interface OfficeRoomSummary {
  code: string;
  topic: string;
  status: string;
  createdAt: number;
  /** createdAt + the 30-day room lifetime. Rooms really do disappear. */
  expiresAt: number;
  /** Whole days left before the room expires; 0 means the last day. */
  daysLeft: number;
  participants: number;
  agents: number;
  openTasks: number;
  doneTasks: number;
  pendingApproval: number;
  /** Three days or less left (and still open): the dashboard offers a handoff. */
  handoffDue?: boolean;
  /** Where this room's open work was carried, once it has been handed over. */
  successorRoomCode?: string;
  /** The room this one continues, if it was opened by a handoff. */
  predecessorRoomCode?: string;
  /**
   * Epoch ms when this room will close by itself because every card on its
   * board is done (null of absent = no close scheduled). The dashboard shows
   * the remaining time, and the same deadline is what the server acts on.
   */
  autoCloseAt?: number;
  /** Epoch ms when the room was actually closed by that rule. */
  autoClosedAt?: number;
}

export interface OfficeIntegrations {
  redis: boolean;
  storage: boolean;
  mcpGrants: number;
  adminConfigured: boolean;
}

/**
 * What happened in the office today, counted from the boards the overview already
 * walks. It exists so the dashboard opens with an answer ("three things finished
 * today") instead of only a state, and it costs no extra read.
 */
export interface OfficeTodaySummary {
  /** KST day the counts belong to, `YYYY-MM-DD`. */
  day: string;
  /** Tasks whose verifier ruled `done` today. Legacy cards without a verdict time are not counted. */
  doneToday: number;
  inProgress: number;
  /** blocked + rejected + pending_approval: anything waiting on a person. */
  needsAttention: number;
  /** Live rooms with three days or less left. */
  expiringRooms: number;
  /** How many rooms this number was read from (the overview's own cap). */
  roomsScanned: number;
}

export interface OfficeOverview {
  generatedAt: number;
  ownerName: string | null;
  agents: OfficeAgentView[];
  projects: OfficeProjectSummary[];
  rooms: OfficeRoomSummary[];
  /** Every task that still asks something of somebody, newest change first. */
  openTasks: OfficeTaskRef[];
  approvals: OfficeTaskRef[];
  qaQueue: OfficeTaskRef[];
  failedTasks: OfficeTaskRef[];
  usage: OfficeUsageSnapshot;
  settings: OfficeSettings;
  integrations: OfficeIntegrations;
  counts: {
    agents: number;
    onlineAgents: number;
    projects: number;
    openTasks: number;
    pendingApproval: number;
    archivedMeetings: number;
    templates: number;
  };
  archives: Array<Pick<OfficeArchive, 'id' | 'roomCode' | 'topic' | 'archivedAt' | 'summary'>>;
  recentAudit: OfficeAuditEntry[];
  warnings: string[];
  /**
   * Omitted on a `withoutRooms` response: with no board walk there is nothing to
   * count. Optional also so a newer client can read an older server's payload.
   */
  todaySummary?: OfficeTodaySummary;
}
