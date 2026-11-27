// Handing a meeting over before it expires.
//
// A room lives 30 days (`ROOM_TTL_SECONDS`) and then every room-scoped key goes
// with it: messages, board, turn state. The office archives minutes, and the
// deliverables vault is built to outlive the meeting — but until now nothing
// moved *open work* to a room that would still exist next week. A room one day
// from expiry with four unfinished tasks was a deadline nobody could act on
// from inside the product.
//
// A handoff is deliberately narrow. It carries what a successor needs to
// continue: the unfinished cards (same ids, so "T-03" still means T-03), the
// project's standing context, and a pointer to the deliverables that already
// exist. It does not copy the transcript (that is what the archive is for) and
// it does not touch the source room (the boss decides whether to end it).
import type { Task, TaskState } from './types.js';

/** From this many days left, the office offers to hand the room over. */
export const HANDOFF_SOON_DAYS = 3;

/** States that still ask something of somebody: they travel with the handoff. */
const CARRY_STATES = new Set<TaskState>(['todo', 'in_progress', 'blocked', 'pending_approval', 'awaiting_review', 'rejected']);

export interface HandoffTask {
  id: string;
  title: string;
  dod?: string;
  state: TaskState;
  owner?: string;
  verifier?: string;
  requiresApproval?: boolean;
  projectId?: string;
  /** Open subtasks, so the successor knows how far the work got. */
  subtasks?: Array<{ title: string; done: boolean }>;
}

export interface HandoffDeliverable {
  id: string;
  name: string;
  version?: number;
  size?: number;
  mime?: string;
  producer?: string;
  taskId?: string;
}

export interface HandoffProjectContext {
  id: string;
  name: string;
  memories?: Array<{ title: string }>;
  guidelines?: Array<{ title: string }>;
}

export interface RoomHandoffPlan {
  /** Cards that travel, in board order. */
  carry: HandoffTask[];
  /** Finished/cancelled cards that stay with the archive only. */
  kept: Array<{ id: string; title: string; state: TaskState }>;
  deliverables: HandoffDeliverable[];
  /** Counts for a one-line report. */
  summary: string;
  /** The system message the successor room receives. */
  note: string;
}

export type HandoffUrgency = 'due' | 'soon' | 'none';

/**
 * How urgent a handoff is for one room.
 *
 * `due` is the window the dashboard should push (three days or less), `soon`
 * marks the second warning day (one day or less is still `due`), and `none` is
 * everything else. An ended room is never due — there is nothing to continue.
 */
export function handoffUrgency(room: { status?: string; daysLeft: number }): HandoffUrgency {
  if (room.status && room.status !== 'active') return 'none';
  if (!Number.isFinite(room.daysLeft)) return 'none';
  return room.daysLeft <= HANDOFF_SOON_DAYS ? 'due' : 'none';
}

/** The cards a handoff would carry. Exported so the dashboard can preview it. */
export function handoffTasks(tasks: ReadonlyArray<Task>): HandoffTask[] {
  const out: HandoffTask[] = [];
  for (const task of tasks) {
    if (!CARRY_STATES.has(task.state)) continue;
    out.push({
      id: task.id,
      title: task.title,
      state: task.state,
      ...(task.dod ? { dod: task.dod } : {}),
      ...(task.owner ? { owner: task.owner } : {}),
      ...(task.verifier ? { verifier: task.verifier } : {}),
      ...(task.approval?.required ? { requiresApproval: true } : {}),
      ...(task.subtasks && task.subtasks.length > 0
        ? { subtasks: task.subtasks.map(subtask => ({ title: subtask.title, done: subtask.done })) }
        : {}),
    });
  }
  return out;
}

export interface PlanHandoffInput {
  topic: string;
  code: string;
  tasks: ReadonlyArray<Task>;
  project?: HandoffProjectContext;
  deliverables?: HandoffDeliverable[];
  /** KST day or any readable stamp for the note. */
  now: number;
  /** Archive id captured for the source room, when one exists. */
  archiveId?: string;
  /** Days left on the source room, so the note says why this happened. */
  daysLeft?: number;
  /** Decisions/results worth carrying, newest last (already trimmed by the caller). */
  decisions?: string[];
}

/**
 * What a successor room gets.
 *
 * The note is written for an agent, not a person: it names the source room, the
 * cards with their ids and owners, the project context worth re-reading, and
 * the deliverables that already exist. It never claims work is done — carried
 * cards keep their real state, so a task that was `in_progress` is still
 * `in_progress` in the new room until somebody submits evidence.
 */
export function planRoomHandoff(input: PlanHandoffInput): RoomHandoffPlan {
  const carry = handoffTasks(input.tasks);
  const kept = input.tasks
    .filter(task => !CARRY_STATES.has(task.state))
    .map(task => ({ id: task.id, title: task.title, state: task.state }));
  const deliverables = (input.deliverables ?? []).map(file => ({ ...file }));
  const summaryParts = [
    `${carry.length} open task${carry.length === 1 ? '' : 's'}`,
    `${kept.length} finished`,
    `${deliverables.length} deliverable${deliverables.length === 1 ? '' : 's'}`,
    input.project ? `project ${input.project.name}` : '',
  ].filter(Boolean);
  return {
    carry,
    kept,
    deliverables,
    summary: summaryParts.join(' · '),
    note: handoffNote(input, carry, deliverables),
  };
}

function handoffNote(input: PlanHandoffInput, carry: HandoffTask[], deliverables: HandoffDeliverable[]): string {
  const lines: string[] = [];
  const why = typeof input.daysLeft === 'number' && input.daysLeft <= HANDOFF_SOON_DAYS
    ? ` (source room had ${input.daysLeft} day${input.daysLeft === 1 ? '' : 's'} left)`
    : '';
  lines.push(`[HANDOFF] Continued from room ${input.code} "${truncate(input.topic, 120)}"${why}.`);
  lines.push('This room is the successor: the open cards below are the same cards, with the same ids and owners, and they are still open. Nothing was marked done by the move.');
  if (carry.length) {
    lines.push('', 'Open work carried over:');
    for (const task of carry) {
      const who = [task.owner ? `owner ${task.owner}` : 'unclaimed', task.verifier ? `verifier ${task.verifier}` : '']
        .filter(Boolean).join(' · ');
      lines.push(`- ${task.id} [${task.state}] ${truncate(task.title, 160)} — ${who}`);
      if (task.dod) lines.push(`  done when: ${truncate(task.dod, 240)}`);
      const subtasks = task.subtasks ?? [];
      if (subtasks.length) {
        lines.push(`  progress: ${subtasks.filter(subtask => subtask.done).length}/${subtasks.length} subtasks`);
      }
    }
  } else {
    lines.push('', 'No open cards were carried — this room continues the topic, not a backlog.');
  }
  const decisions = (input.decisions ?? []).filter(line => line.trim()).slice(-6);
  if (decisions.length) {
    lines.push('', 'Decisions and results from the source room (the full minutes are in the office archive):');
    for (const decision of decisions) lines.push(`- ${truncate(decision, 200)}`);
  }
  const project = input.project;
  if (project) {
    lines.push('', `Project context: ${project.name}`);
    for (const memory of (project.memories ?? []).slice(0, 5)) lines.push(`- memory: ${truncate(memory.title, 120)}`);
    for (const guideline of (project.guidelines ?? []).slice(0, 5)) lines.push(`- guideline: ${truncate(guideline.title, 120)}`);
  }
  if (deliverables.length) {
    lines.push('', 'Deliverables that already exist (kept in the office record, not re-uploaded here):');
    for (const file of deliverables.slice(0, 10)) {
      const parts = [
        `"${truncate(file.name, 120)}"`,
        file.version ? `v${file.version}` : '',
        file.size ? `${Math.max(1, Math.round(file.size / 1024))} KB` : '',
        file.producer ? `by ${file.producer}` : '',
        `id ${file.id}`,
      ].filter(Boolean);
      lines.push(`- ${parts.join(' · ')}`);
    }
    if (input.archiveId) lines.push(`Download them from the office record (archive ${input.archiveId}), which outlives both rooms.`);
  }
  lines.push('', 'Continue with room_task list, then claim/resume the card you own. Do not open duplicates of the carried ids.');
  return lines.join('\n');
}

/** Topic for the successor room: recognisable next to its predecessor. */
export function handoffTopic(topic: string, sourceCode: string): string {
  const base = topic.trim() || 'Meeting';
  const suffix = ` (continued from ${sourceCode})`;
  // Room topics are capped at 200 characters on the server; keep room for the suffix.
  return `${truncate(base, 200 - suffix.length)}${suffix}`;
}

function truncate(value: string, max: number): string {
  const text = String(value ?? '').replace(/\s+/g, ' ').trim();
  return text.length > max ? `${text.slice(0, Math.max(0, max - 1))}…` : text;
}
