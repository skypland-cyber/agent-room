// Who stands where, and what is true about them.
//
// The same rule the pixel floor followed applies here: a pose is only ever a
// restatement of a fact the server sent. An agent is drawn typing only while it
// holds a card, sits in a meeting pod only while it is reviewing, and stands in
// the boss's office only while something of its own is waiting on a decision.
//
// Two halves:
//   - `planIso` lays the staff out over the six rooms plus the lounge, and adds
//     the small talk of whoever is on a break.
//   - `isoAlerts` / `isoZoneFacts` turn the same payload into the numbers the
//     HUD and the room badges show, so the picture and the panel cannot disagree.
import type { OfficeAgentView, OfficeOverview, OfficeRoomSummary } from '@agent-room/shared';
import { approvalTasksFor, taskBubble, taskBubbleTone } from '../pixel/scene.js';
import { PAIR_LINES, chatTurn, lineIndex, restSeed, restTogether, soloPoolFor } from '../pixel/idleChat.js';
import { t } from '../../../i18n/index.js';
import {
  ANALYSIS_DESKS,
  CEO_WAIT_SPOTS,
  CONTROL_DESK,
  DEV_DESKS,
  LOUNGE_SPOTS,
  MEETING_PODS,
  OVERFLOW_SPOTS,
  type IsoDesk,
  type IsoFacing,
  type IsoPod,
  type IsoZoneId,
} from './isoPlan.js';
import type { IsoPoint } from './iso.js';

export type IsoPose = 'stand' | 'sit' | 'type' | 'coffee' | 'sleep' | 'talk';
export type BubbleTone = 'info' | 'warn' | 'good' | 'muted';

export interface IsoAgentScene {
  agentId: string;
  zone: IsoZoneId;
  pose: IsoPose;
  /** Where it stands, in grid coordinates. */
  spot: IsoPoint;
  facing: IsoFacing;
  /** The line over its head, or null for silence. `\n` starts a second line. */
  bubble: string | null;
  bubbleTone: BubbleTone;
  /** 0–100 under a task bubble; absent for chatter. */
  progress?: number;
  /** The bouncing "!": the boss owes this agent a decision. */
  needsBoss: boolean;
  alpha: number;
  /** The desk it works at, when it has one. */
  deskId?: string;
  /** Which meeting pod it sits in, when it is reviewing. */
  podIndex?: number;
  /** On a break: idle chatter may be put over its head. */
  rest: boolean;
}

export interface PlanOptions {
  /**
   * The clock the break rotation and the chatter are read against. Left out, it
   * is a fixed instant so a plan made for a server render or a test is stable.
   */
  now?: number;
}

const norm = (value: string) => value.toLowerCase().replace(/\s+/g, '');

/** 망고 (or another orchestrator) sits at the console; everything else works a desk. */
export function isManager(agent: Pick<OfficeAgentView, 'name' | 'role'>): boolean {
  const text = `${norm(agent.name)} ${norm(agent.role)}`;
  return /망고|mango|피클|pickle|총괄|오케스트레이터|orchestrat|manager|chief/.test(text);
}

/** Build work goes to the dev room, so the room means something. */
export function isDevAgent(agent: Pick<OfficeAgentView, 'name' | 'role' | 'tags'>): boolean {
  const text = `${norm(agent.name)} ${norm(agent.role)} ${agent.tags.map(norm).join(' ')}`;
  return /codex|dev|develop|engineer|build|deploy|개발|코드|엔지니어|배포/.test(text);
}

interface Slot {
  spot: IsoPoint;
  desk?: IsoDesk;
  facing: IsoFacing;
}

/** Take the next free desk from a pool, so two agents never share one. */
function takeDesk(pool: IsoDesk[], used: Set<string>): Slot | null {
  for (const desk of pool) {
    if (used.has(desk.id)) continue;
    used.add(desk.id);
    return { spot: desk.stand, desk, facing: desk.facing };
  }
  return null;
}

function takeSpot(spots: IsoPoint[], used: Set<string>, facing: IsoFacing = 'down'): Slot | null {
  for (let index = 0; index < spots.length; index += 1) {
    const spot = spots[index]!;
    const key = `${spot.x},${spot.y}`;
    if (used.has(key)) continue;
    used.add(key);
    return { spot, facing };
  }
  return null;
}

/**
 * Lay every agent out: where it stands, what it is doing, and what it says.
 * Peers are spread over the seats of a room in roster order, so a full dev room
 * reads as four people at four desks rather than one pile.
 */
export function planIso(
  agents: OfficeAgentView[],
  overview: Pick<OfficeOverview, 'approvals' | 'openTasks'>,
  options: PlanOptions = {},
): IsoAgentScene[] {
  const now = options.now ?? 0;
  const usedDesks = new Set<string>([CONTROL_DESK.id, 'owner-desk']);
  const usedSpots = new Set<string>();
  let waiting = 0;
  let reviewing = 0;
  let paused = 0;
  let overflow = 0;
  let restIndex = 0;
  let controlTaken = false;

  const scenes = agents.map<IsoAgentScene>((agent, index) => {
    const approvals = approvalTasksFor(agent, overview);
    const status = agent.presence.status;

    // 1. Something of this agent's is waiting on the boss: it walks to the CEO office.
    if (approvals.length > 0) {
      const slot = takeSpot(CEO_WAIT_SPOTS, usedSpots, 'up') ?? { spot: CEO_WAIT_SPOTS[waiting % CEO_WAIT_SPOTS.length]!, facing: 'up' as IsoFacing };
      waiting += 1;
      return {
        agentId: agent.id,
        zone: 'ceo',
        pose: 'stand',
        spot: slot.spot,
        facing: 'up',
        bubble: approvals.length > 1
          ? t('pixel.bubble.approvals', { count: approvals.length })
          : t('pixel.bubble.yourCall'),
        bubbleTone: 'warn',
        needsBoss: true,
        alpha: 1,
        rest: false,
      };
    }

    // 2. Reviewing something: sit in a meeting pod, one pod after another.
    if (status === 'reviewing') {
      const seatIndex = reviewing;
      reviewing += 1;
      const pod = MEETING_PODS[Math.floor(seatIndex / 4) % MEETING_PODS.length]!;
      const seat = pod.seats[seatIndex % pod.seats.length] ?? pod.seats[0]!;
      return {
        agentId: agent.id,
        zone: 'meeting',
        pose: 'sit',
        spot: seat,
        facing: 'down',
        bubble: taskBubble(agent.presence, 'reviewing', now),
        bubbleTone: taskBubbleTone(agent.presence, 'reviewing', now),
        ...(agent.presence.taskProgress !== undefined ? { progress: agent.presence.taskProgress } : {}),
        needsBoss: false,
        alpha: 1,
        podIndex: pod.index,
        rest: false,
      };
    }

    // 3. At work: the console for the orchestrator, the dev room for build work,
    //    the analysis room for everything else. A full room spills to the plaza.
    if (status === 'working') {
      if (isManager(agent) && !controlTaken) {
        controlTaken = true;
        return {
          agentId: agent.id,
          zone: 'control',
          pose: 'type',
          spot: CONTROL_DESK.stand,
          facing: 'down',
          bubble: taskBubble(agent.presence, 'working', now),
          bubbleTone: taskBubbleTone(agent.presence, 'working', now),
          ...(agent.presence.taskProgress !== undefined ? { progress: agent.presence.taskProgress } : {}),
          needsBoss: false,
          alpha: 1,
          deskId: CONTROL_DESK.id,
          rest: false,
        };
      }
      const deskSlot = takeDesk(isDevAgent(agent) ? DEV_DESKS : ANALYSIS_DESKS, usedDesks)
        ?? takeDesk(ANALYSIS_DESKS, usedDesks);
      if (deskSlot?.desk) {
        return {
          agentId: agent.id,
          zone: deskSlot.desk.zone,
          pose: 'type',
          spot: deskSlot.spot,
          facing: deskSlot.facing,
          bubble: taskBubble(agent.presence, 'working', now),
          bubbleTone: taskBubbleTone(agent.presence, 'working', now),
          ...(agent.presence.taskProgress !== undefined ? { progress: agent.presence.taskProgress } : {}),
          needsBoss: false,
          alpha: 1,
          deskId: deskSlot.desk.id,
          rest: false,
        };
      }
      const spill = takeSpot(OVERFLOW_SPOTS, usedSpots) ?? { spot: OVERFLOW_SPOTS[overflow % OVERFLOW_SPOTS.length]!, facing: 'down' as IsoFacing };
      overflow += 1;
      return {
        agentId: agent.id,
        zone: isDevAgent(agent) ? 'dev' : 'analysis',
        pose: 'stand',
        spot: spill.spot,
        facing: 'down',
        bubble: taskBubble(agent.presence, 'working', now),
        bubbleTone: 'muted',
        ...(agent.presence.taskProgress !== undefined ? { progress: agent.presence.taskProgress } : {}),
        needsBoss: false,
        alpha: 1,
        rest: false,
      };
    }

    // 4. Paused: the seat is kept, the shift is over. It sits in the lounge, quiet.
    if (status === 'paused') {
      const spot = LOUNGE_SPOTS[(LOUNGE_SPOTS.length - 1 - paused) % LOUNGE_SPOTS.length]!;
      paused += 1;
      return {
        agentId: agent.id,
        zone: 'lounge',
        pose: 'sit',
        spot,
        facing: 'down',
        bubble: t('pixel.bubble.paused'),
        bubbleTone: 'muted',
        needsBoss: false,
        alpha: 1,
        rest: false,
      };
    }

    // 5. Offline: still at its desk, asleep — an empty chair would read as "no such agent".
    if (status === 'offline') {
      const seat = takeDesk(isDevAgent(agent) ? DEV_DESKS : ANALYSIS_DESKS, usedDesks)
        ?? takeDesk(DEV_DESKS, usedDesks)
        ?? takeDesk(ANALYSIS_DESKS, usedDesks);
      return {
        agentId: agent.id,
        zone: seat?.desk?.zone ?? 'lounge',
        pose: 'sleep',
        spot: seat?.spot ?? { x: 12.4, y: 3.6 },
        facing: seat?.facing ?? 'down',
        bubble: t('pixel.bubble.sleep'),
        bubbleTone: 'muted',
        needsBoss: false,
        alpha: 0.42,
        ...(seat?.desk ? { deskId: seat.desk.id } : {}),
        rest: false,
      };
    }

    // 6. Idle: on a break. It drifts one stop along the sofas and the counter every
    //    ~18 seconds, so the room is alive without anyone pretending to work.
    const rotation = restIndex;
    restIndex += 1;
    const phase = Math.floor(now / 18_000) + restSeed(agent.id) + rotation;
    const spot = LOUNGE_SPOTS[Math.abs(phase) % LOUNGE_SPOTS.length]!;
    return {
      agentId: agent.id,
      zone: 'lounge',
      pose: spot.pose,
      spot: { x: spot.x, y: spot.y },
      facing: spot.facing,
      bubble: null,
      bubbleTone: 'good',
      needsBoss: false,
      alpha: 1,
      rest: true,
    };
  });

  return attachIsoChat(scenes, now);
}

/**
 * Put the small talk over the people on a break. Two of them resting within a few
 * tiles become a pair and take turns; everyone else says a line now and then.
 * Only `rest` scenes are touched — a task bubble is a fact and is never replaced.
 */
export function attachIsoChat(scenes: IsoAgentScene[], nowMs: number): IsoAgentScene[] {
  const resters = scenes.filter(scene => scene.rest);
  if (resters.length === 0) return scenes;

  const partners = new Map<string, IsoAgentScene>();
  for (const scene of resters) {
    if (partners.has(scene.agentId)) continue;
    const partner = resters.find(other =>
      other.agentId !== scene.agentId
      && !partners.has(other.agentId)
      && restTogether(scene.spot, other.spot));
    if (!partner) continue;
    partners.set(scene.agentId, partner);
    partners.set(partner.agentId, scene);

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
    const area = scene.zone === 'lounge' && scene.pose === 'coffee' ? 'pantry' : 'lounge';
    const pool = soloPoolFor(area);
    scene.bubble = t(pool[lineIndex(seed, turn.cycle, pool.length)]!);
    scene.bubbleTone = 'good';
  }

  return scenes;
}

// ─── HUD facts ────────────────────────────────────────────────────────────

export type AlertKind = 'error' | 'approval' | 'review' | 'done' | 'warning';

export interface IsoAlert {
  id: string;
  kind: AlertKind;
  count: number;
  /** Only set for `warning`, where the server already wrote the sentence key. */
  text?: string;
}

/**
 * What the HUD says needs the boss. Ordered by how much it costs to ignore:
 * an error or a refusal first, then approvals, then reviews, then good news.
 */
export function isoAlerts(overview: OfficeOverview): IsoAlert[] {
  const alerts: IsoAlert[] = [];
  if (overview.failedTasks.length > 0) {
    alerts.push({ id: 'error', kind: 'error', count: overview.failedTasks.length });
  }
  if (overview.counts.pendingApproval > 0) {
    alerts.push({ id: 'approval', kind: 'approval', count: overview.counts.pendingApproval });
  }
  if (overview.qaQueue.length > 0) {
    alerts.push({ id: 'review', kind: 'review', count: overview.qaQueue.length });
  }
  if ((overview.todaySummary?.doneToday ?? 0) > 0) {
    alerts.push({ id: 'done', kind: 'done', count: overview.todaySummary!.doneToday });
  }
  overview.warnings.forEach((warning, index) => {
    alerts.push({ id: `warning-${index}`, kind: 'warning', count: 1, text: warning });
  });
  return alerts;
}

export interface ZoneFact {
  /** The number the room's badge shows: what is waiting, or how many are inside. */
  value: number;
  tone: BubbleTone;
}

const EMPTY_FACTS: Record<IsoZoneId | 'plaza', ZoneFact> = {
  ceo: { value: 0, tone: 'muted' },
  control: { value: 0, tone: 'muted' },
  dev: { value: 0, tone: 'muted' },
  analysis: { value: 0, tone: 'muted' },
  meeting: { value: 0, tone: 'muted' },
  archive: { value: 0, tone: 'muted' },
  lounge: { value: 0, tone: 'muted' },
  plaza: { value: 0, tone: 'muted' },
};

/**
 * The one number each room shows on its sign.
 * The CEO office shows what is waiting on a decision, the working rooms show how
 * many are at work, the meeting zone shows how many rooms are live, and the
 * archive shows how much is filed.
 */
export function isoZoneFacts(overview: OfficeOverview, scenes: IsoAgentScene[]): Record<IsoZoneId | 'plaza', ZoneFact> {
  const inside: Record<string, number> = {};
  for (const scene of scenes) inside[scene.zone] = (inside[scene.zone] ?? 0) + 1;
  const count = (zone: IsoZoneId) => inside[zone] ?? 0;
  return {
    ...EMPTY_FACTS,
    ceo: { value: overview.counts.pendingApproval, tone: overview.counts.pendingApproval > 0 ? 'warn' : 'muted' },
    control: { value: count('control'), tone: count('control') > 0 ? 'info' : 'muted' },
    dev: { value: count('dev'), tone: count('dev') > 0 ? 'info' : 'muted' },
    analysis: { value: count('analysis'), tone: count('analysis') > 0 ? 'info' : 'muted' },
    meeting: {
      value: overview.rooms.length + (overview.qaQueue.length > 0 ? 1 : 0),
      tone: overview.qaQueue.length > 0 ? 'warn' : 'info',
    },
    archive: { value: overview.counts.archivedMeetings, tone: 'muted' },
    lounge: { value: count('lounge'), tone: 'good' },
    plaza: { value: 0, tone: 'muted' },
  };
}

/** A meeting pod and the live room bound to its door, if there is one. */
export interface PodBinding {
  pod: IsoPod;
  room: OfficeRoomSummary | null;
}

/**
 * Bind the live rooms to the pods in the overview's own order, so a pod's door
 * opens the room whose numbers are written on it. Rooms beyond the pod count are
 * not shown on the floor — the 4th door opens the projects tab instead.
 */
export function podBindings(overview: OfficeOverview): PodBinding[] {
  return MEETING_PODS.map(pod => ({ pod, room: overview.rooms[pod.index] ?? null }));
}
