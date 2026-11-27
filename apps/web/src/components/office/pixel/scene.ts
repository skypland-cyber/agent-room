// What each character is doing, derived from the office payload.
//
// The rule the dashboard already follows applies to the picture too: a pose is
// only ever a restatement of a fact the server sent (presence + the board). An
// agent is drawn typing only while its heartbeat is fresh and it holds a task;
// one waiting on the boss stands in the CEO office with a "!" over its head.
// Nothing is guessed, so the floor never looks busier than the office is.
import type { OfficeAgentView, OfficeOverview, OfficeTaskRef } from '@agent-room/shared';
import { TASK_LEASE_SOON_MS, officeBaseName } from '@agent-room/shared';
import {
  CEO_WAIT_SPOTS,
  LOUNGE_SPOTS,
  OVERFLOW_SPOTS,
  deskSlots,
  meetingSeats,
  spotFor,
} from './officeMap.js';
import { PAIR_LINES, chatTurn, lineIndex, restSeed, restStayFor, restTogether, soloPoolFor, type RestArea } from './idleChat.js';
import { t } from '../../../i18n/index.js';
import { taskStateLabel } from '../../../i18n/labels.js';

/** How much of a card's title fits over a head before it stops being a title. */
export const BUBBLE_TITLE_MAX = 12;

export type SceneZone = 'desk' | 'meeting' | 'ceo' | 'lounge' | 'pantry' | 'overflow';
export type ScenePose = 'type' | 'stand' | 'sit' | 'coffee' | 'sleep';
export type BubbleTone = 'info' | 'warn' | 'good' | 'muted';

export interface AgentScene {
  agentId: string;
  zone: SceneZone;
  pose: ScenePose;
  /** Where it stands (tile coordinates). */
  tile: { x: number; y: number };
  /** Which way it faces: the pose, not a keyboard. */
  facing: 'up' | 'down' | 'left' | 'right';
  /** Short line over its head, or null for silence. `\n` starts a second line. */
  bubble: string | null;
  bubbleTone: BubbleTone;
  /** 0–100 shown as a thin gauge under a task bubble; absent for chatter. */
  progress?: number;
  /** The bouncing "!" — the boss owes this agent a decision. */
  needsBoss: boolean;
  /** Offline staff are drawn faded so an empty desk reads as empty. */
  alpha: number;
  /** Index of its dedicated desk, or -1 when it is short of one. */
  deskIndex: number;
  /**
   * Idle staff rest and chat. Paused staff sit in the lobby too, but they keep
   * their seat without saying anything — the shift is over, not on a break.
   */
  rest: boolean;
}

const norm = (value: string) => officeBaseName(value).toLowerCase();

/** A title short enough to sit in a 96 px bubble, cut on a word where it can. */
export function bubbleTitle(title: string | undefined, max = BUBBLE_TITLE_MAX): string {
  const clean = (title ?? '').replace(/\s+/g, ' ').trim();
  if (clean.length <= max) return clean;
  const cut = clean.slice(0, max);
  const space = cut.lastIndexOf(' ');
  return `${(space >= max - 4 ? cut.slice(0, space) : cut).trimEnd()}…`;
}

/**
 * The line over a working agent's head: which card, what state, how far.
 *
 * `presence` is the server's own account of the task the agent holds — the title,
 * the board state, the subtask tally, the lease — so this only chooses words for
 * facts that are already true. A card's state can be more specific than the
 * presence status (a claim already submitted still shows "Awaiting review"), and
 * that specific answer is the one worth reading.
 */
export function taskBubble(
  presence: Pick<OfficeAgentView['presence'], 'taskId' | 'taskTitle' | 'taskState' | 'taskProgress' | 'taskSubtasks' | 'leaseEndsAt'>,
  status: 'working' | 'reviewing',
  now: number,
): string {
  const id = presence.taskId;
  if (!id) return t(status === 'reviewing' ? 'pixel.bubble.reviewing' : 'pixel.bubble.typing');
  const title = bubbleTitle(presence.taskTitle);
  const head = title ? t('pixel.bubble.taskLine', { id, title }) : id;
  const progress = presence.taskSubtasks && presence.taskSubtasks.total > 0
    ? t('pixel.bubble.subtasks', { done: presence.taskSubtasks.done, total: presence.taskSubtasks.total })
    : `${presence.taskProgress ?? 0}%`;
  const state = presence.taskState
    ? taskStateLabel(presence.taskState)
    : t(status === 'reviewing' ? 'pixel.bubble.stateReviewing' : 'pixel.bubble.stateWorking');
  const remaining = presence.leaseEndsAt !== undefined ? presence.leaseEndsAt - now : undefined;
  const lease = now > 0 && remaining !== undefined && remaining > 0 && remaining <= TASK_LEASE_SOON_MS
    ? t('pixel.bubble.leaseSoon', { minutes: Math.max(1, Math.ceil(remaining / 60_000)) })
    : '';
  // Two lines, always. When the lease is about to lapse the warning takes the
  // place of the percentage — the gauge under the bubble still shows the share,
  // and a third line would make the bubble taller than the head it hangs over.
  const detail = lease ? `${state} · ${lease}` : `${state} · ${progress}`;
  return [head, detail].join('\n');
}

/** The tone a task bubble is drawn in: a lease about to lapse outranks a calm status. */
export function taskBubbleTone(
  presence: Pick<OfficeAgentView['presence'], 'taskState' | 'leaseEndsAt'>,
  status: 'working' | 'reviewing',
  now: number,
): BubbleTone {
  const remaining = presence.leaseEndsAt !== undefined ? presence.leaseEndsAt - now : undefined;
  if (now > 0 && remaining !== undefined && remaining > 0 && remaining <= TASK_LEASE_SOON_MS) return 'warn';
  if (presence.taskState === 'blocked' || presence.taskState === 'rejected') return 'warn';
  return status === 'reviewing' ? 'warn' : 'info';
}

// `norm` folds a decorated room name onto the staff member it belongs to: the
// board records "Gemini (2)" after a rejoin and "망고 (총괄 매니저)" for the
// manager, while the roster only knows the plain names. A pose or a bubble must
// not disappear because the agent happened to be renamed in the room.

/**
 * Work this agent is holding that still asks the boss for a ruling.
 *
 * `blocked` belongs here: on this board it is the owner declaring it cannot go on
 * (see `Task.blocked`), which is exactly a decision the boss owes. A stuck agent
 * standing in the doorway with a "!" is the floor's way of saying so.
 */
export function approvalTasksFor(agent: Pick<OfficeAgentView, 'name'>, overview: Pick<OfficeOverview, 'approvals' | 'openTasks'>): OfficeTaskRef[] {
  const name = norm(agent.name);
  const seen = new Set<string>();
  const out: OfficeTaskRef[] = [];
  for (const task of [...overview.approvals, ...overview.openTasks]) {
    if (!task.owner || norm(task.owner) !== name) continue;
    if (task.state !== 'pending_approval' && task.state !== 'awaiting_review' && task.state !== 'blocked') continue;
    const key = `${task.code}:${task.id}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(task);
  }
  return out;
}

/** Every open task the agent owns, newest change first. */
export function openTasksFor(agent: Pick<OfficeAgentView, 'name'>, overview: Pick<OfficeOverview, 'openTasks'>): OfficeTaskRef[] {
  const name = norm(agent.name);
  return overview.openTasks
    .filter(task => task.owner !== undefined && norm(task.owner) === name)
    .sort((a, b) => b.updatedAt - a.updatedAt);
}

export interface PlanOptions {
  /**
   * The clock the idle rest rotation and the chatter are read against. Left out,
   * it is a fixed instant, so a plan without a clock is still deterministic
   * (server render, a unit test) rather than depending on when it happened to run.
   */
  now?: number;
}

/**
 * Lay every agent out on the floor. Peers that land in the same zone are spread
 * over that zone's spots in roster order, so six agents never stack on one tile.
 */
export function planScenes(
  agents: OfficeAgentView[],
  overview: Pick<OfficeOverview, 'approvals' | 'openTasks'>,
  options: PlanOptions = {},
): AgentScene[] {
  const now = options.now ?? 0;
  const desks = deskSlots(agents.length);
  let waitingIndex = 0;
  let reviewingIndex = 0;
  let pausedIndex = 0;
  /** Tiles the idle staff have already claimed in this plan. */
  const resting = new Set<string>();

  const scenes = agents.map<AgentScene>((agent, index) => {
    const deskIndex = index < desks.length ? index : -1;
    const desk = deskIndex >= 0 ? desks[deskIndex]! : null;
    const approval = approvalTasksFor(agent, overview);
    const status = agent.presence.status;

    if (approval.length > 0) {
      const spot = spotFor(CEO_WAIT_SPOTS, waitingIndex);
      waitingIndex += 1;
      return {
        agentId: agent.id,
        zone: 'ceo',
        pose: 'stand',
        tile: spot,
        facing: 'up',
        bubble: approval.length > 1
          ? t('pixel.bubble.approvals', { count: approval.length })
          : t('pixel.bubble.yourCall'),
        bubbleTone: 'warn',
        needsBoss: true,
        alpha: 1,
        deskIndex,
        rest: false,
      };
    }

    if (status === 'working' || status === 'offline') {
      if (desk) {
        return {
          agentId: agent.id,
          zone: 'desk',
          pose: status === 'working' ? 'type' : 'sleep',
          tile: { x: desk.standX, y: desk.standY },
          facing: 'down',
          bubble: status === 'working' ? taskBubble(agent.presence, 'working', now) : t('pixel.bubble.sleep'),
          bubbleTone: status === 'working' ? taskBubbleTone(agent.presence, 'working', now) : 'muted',
          ...(status === 'working' && agent.presence.taskProgress !== undefined ? { progress: agent.presence.taskProgress } : {}),
          needsBoss: false,
          alpha: status === 'offline' ? 0.45 : 1,
          deskIndex,
          rest: false,
        };
      }
      // No desk left: working staff pace by the overflow board, others sit out.
      const spot = spotFor(status === 'working' ? OVERFLOW_SPOTS : LOUNGE_SPOTS, status === 'working' ? index : pausedIndex++);
      return {
        agentId: agent.id,
        zone: status === 'working' ? 'overflow' : 'lounge',
        pose: status === 'working' ? 'stand' : 'sit',
        tile: spot,
        facing: 'down',
        bubble: status === 'working' ? t('pixel.bubble.typing') : t('pixel.bubble.sleep'),
        bubbleTone: 'muted',
        needsBoss: false,
        alpha: status === 'offline' ? 0.45 : 1,
        deskIndex,
        rest: false,
      };
    }

    // paused — the seat is kept, but the shift is over: rest in the lobby.
    if (status === 'paused') {
      const spot = spotFor(LOUNGE_SPOTS, pausedIndex);
      pausedIndex += 1;
      return {
        agentId: agent.id,
        zone: 'lounge',
        pose: 'sit',
        tile: spot,
        facing: 'down',
        bubble: t('pixel.bubble.paused'),
        bubbleTone: 'muted',
        needsBoss: false,
        alpha: 1,
        deskIndex,
        rest: false,
      };
    }

    if (status === 'reviewing') {
      const seat = meetingSeats(Math.max(agents.filter(row => row.presence.status === 'reviewing' || approvalTasksFor(row, overview).length > 0).length, 1));
      const tile = seat[reviewingIndex] ?? seat[0] ?? { x: 50, y: 5 };
      reviewingIndex += 1;
      return {
        agentId: agent.id,
        zone: 'meeting',
        pose: 'stand',
        tile,
        facing: 'down',
        bubble: taskBubble(agent.presence, 'reviewing', now),
        bubbleTone: taskBubbleTone(agent.presence, 'reviewing', now),
        ...(agent.presence.taskProgress !== undefined ? { progress: agent.presence.taskProgress } : {}),
        needsBoss: false,
        alpha: 1,
        deskIndex,
        rest: false,
      };
    }

    // idle — available, so it is not at the desk pretending to work. It walks a
    // ring of rest spots instead of holding one tile: the pantry counter, the
    // pantry table, the lobby sofas, the coffee table. `restStayFor` skips the
    // spots an agent planned earlier in this same list already claimed.
    const stay = restStayFor(restSeed(agent.id), now, resting);
    resting.add(`${stay.spot.x},${stay.spot.y}`);
    return {
      agentId: agent.id,
      zone: stay.spot.area,
      pose: stay.spot.pose,
      tile: { x: stay.spot.x, y: stay.spot.y },
      facing: stay.spot.facing,
      bubble: null,
      bubbleTone: 'good',
      needsBoss: false,
      alpha: 1,
      deskIndex,
      rest: true,
    };
  });

  return attachIdleChat(scenes, now);
}

/**
 * Put the small talk over the resting staff. Two agents within `CHAT_RANGE` tiles
 * become a pair and take turns — one asks, the other answers a beat later — so a
 * full pantry reads as a conversation rather than five people talking to
 * themselves. Everyone else says a short line now and then and is quiet between
 * lines. Only `rest` scenes are touched: work, review, approval and paused
 * bubbles are facts and are never overwritten.
 *
 * The scenes are the ones `planScenes` just built, so they are safe to fill in.
 */
export function attachIdleChat(scenes: AgentScene[], nowMs: number): AgentScene[] {
  const resters = scenes.filter(scene => scene.rest);
  if (resters.length === 0) return scenes;

  const partners = new Map<string, AgentScene>();
  for (const scene of resters) {
    if (partners.has(scene.agentId)) continue;
    const partner = resters.find(other =>
      other.agentId !== scene.agentId
      && !partners.has(other.agentId)
      && restTogether(scene.tile, other.tile));
    if (!partner) continue;
    partners.set(scene.agentId, partner);
    partners.set(partner.agentId, scene);

    // One rhythm for the pair, seeded by both names so it is stable and does not
    // depend on which of them happened to be planned first.
    const first = restSeed(scene.agentId) <= restSeed(partner.agentId) ? scene : partner;
    const second = first === scene ? partner : scene;
    const pairSeed = restSeed([first.agentId, second.agentId].sort().join('|'));
    const turn = chatTurn(pairSeed, nowMs);
    if (!turn.speaking) continue;
    const speaker = turn.cycle % 2 === 0 ? first : second;
    const line = PAIR_LINES[lineIndex(pairSeed, Math.floor(turn.cycle / 2), PAIR_LINES.length)]!;
    speaker.bubble = turn.cycle % 2 === 0 ? t(line.ask) : t(line.answer);
    speaker.bubbleTone = turn.cycle % 2 === 0 ? 'info' : 'good';
  }

  for (const scene of resters) {
    if (partners.has(scene.agentId)) continue;
    const seed = restSeed(scene.agentId);
    const turn = chatTurn(seed, nowMs);
    if (!turn.speaking) continue;
    // The pantry counter and the lobby sofa have their own things to talk about.
    const area: RestArea = scene.zone === 'pantry' ? 'pantry' : 'lounge';
    const pool = soloPoolFor(area);
    scene.bubble = t(pool[lineIndex(seed, turn.cycle, pool.length)]!);
    scene.bubbleTone = 'good';
  }

  return scenes;
}

/** A stable colour family for one agent: two staff never look the same. */
export const AGENT_COLOR_HINTS: Record<string, string> = {
  '망고': '#F59E0B',
  '피클': '#22C55E',
  'mango': '#F59E0B',
  'pickle': '#22C55E',
  'codex': '#14B8A6',
  'chatgpt': '#10A37F',
  'claude': '#D97757',
  'aside': '#8B5CF6',
  'gemini': '#4285F4',
  'qwen': '#7C3AED',
  'gpt': '#0EA5E9',
  'pixel': '#EC4899',
};
