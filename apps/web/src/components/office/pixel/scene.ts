// What each character is doing, derived from the office payload.
//
// The rule the dashboard already follows applies to the picture too: a pose is
// only ever a restatement of a fact the server sent (presence + the board). An
// agent is drawn typing only while its heartbeat is fresh and it holds a task;
// one waiting on the boss stands in the CEO office with a "!" over its head.
// Nothing is guessed, so the floor never looks busier than the office is.
import type { OfficeAgentView, OfficeOverview, OfficeTaskRef } from '@agent-room/shared';
import {
  CEO_WAIT_SPOTS,
  LOUNGE_SPOTS,
  OVERFLOW_SPOTS,
  PANTRY_SPOTS,
  deskSlots,
  meetingSeats,
  spotFor,
} from './officeMap.js';

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
  /** Short line over its head, or null for silence. */
  bubble: string | null;
  bubbleTone: BubbleTone;
  /** The bouncing "!" — the boss owes this agent a decision. */
  needsBoss: boolean;
  /** Offline staff are drawn faded so an empty desk reads as empty. */
  alpha: number;
  /** Index of its dedicated desk, or -1 when it is short of one. */
  deskIndex: number;
}

const norm = (value: string) => value.trim().toLowerCase();

/** Work this agent is holding that still asks the boss for a ruling. */
export function approvalTasksFor(agent: Pick<OfficeAgentView, 'name'>, overview: Pick<OfficeOverview, 'approvals' | 'openTasks'>): OfficeTaskRef[] {
  const name = norm(agent.name);
  const seen = new Set<string>();
  const out: OfficeTaskRef[] = [];
  for (const task of [...overview.approvals, ...overview.openTasks]) {
    if (!task.owner || norm(task.owner) !== name) continue;
    if (task.state !== 'pending_approval' && task.state !== 'awaiting_review') continue;
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

/**
 * Lay every agent out on the floor. Peers that land in the same zone are spread
 * over that zone's spots in roster order, so six agents never stack on one tile.
 */
export function planScenes(
  agents: OfficeAgentView[],
  overview: Pick<OfficeOverview, 'approvals' | 'openTasks'>,
): AgentScene[] {
  const desks = deskSlots(agents.length);
  let waitingIndex = 0;
  let reviewingIndex = 0;
  let idleIndex = 0;
  let pausedIndex = 0;

  return agents.map((agent, index) => {
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
        bubble: approval.length > 1 ? `! ${approval.length} approvals` : '! your call',
        bubbleTone: 'warn',
        needsBoss: true,
        alpha: 1,
        deskIndex,
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
          bubble: status === 'working'
            ? (agent.presence.taskId ? `${agent.presence.taskId} typing…` : 'typing…')
            : 'Zzz',
          bubbleTone: status === 'working' ? 'info' : 'muted',
          needsBoss: false,
          alpha: status === 'offline' ? 0.45 : 1,
          deskIndex,
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
        bubble: status === 'working' ? 'typing…' : 'Zzz',
        bubbleTone: 'muted',
        needsBoss: false,
        alpha: status === 'offline' ? 0.45 : 1,
        deskIndex,
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
        bubble: 'paused',
        bubbleTone: 'muted',
        needsBoss: false,
        alpha: 1,
        deskIndex,
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
        bubble: testBubble(agent.presence.taskId, 'reviewing'),
        bubbleTone: 'warn',
        needsBoss: false,
        alpha: 1,
        deskIndex,
      };
    }

    // idle — available, so it is not at the desk pretending to work.
    const spot = spotFor(PANTRY_SPOTS, idleIndex);
    idleIndex += 1;
    return {
      agentId: agent.id,
      zone: 'pantry',
      pose: 'coffee',
      tile: spot,
      facing: 'up',
      bubble: 'free',
      bubbleTone: 'good',
      needsBoss: false,
      alpha: 1,
      deskIndex,
    };
  });
}

function testBubble(taskId: string | undefined, fallback: string): string {
  return taskId ? `${taskId} review` : fallback;
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
