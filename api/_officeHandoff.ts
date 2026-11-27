// Handing a room's open work to a successor before the room expires.
//
// Called from the office (`rooms.handoff`). The work is entirely server-side and
// deliberately small: open the successor, seat the same agents, recreate the
// same cards (same ids), write one system note that explains where they came
// from, link the two rooms in the office registry, and archive the source so
// its minutes and deliverables are indexed even if nobody ever opens it again.
//
// What it never does: copy the transcript (the archive holds it), mark anything
// done, touch the source room's board, or end the source room unless asked. A
// handoff is a continuation, not a migration — both rooms keep working, and the
// boss decides when the old one closes.
import type { UpstashClient } from '@agent-room/upstash-client';
import {
  appendSystemMessage,
  createRoom,
  createTask,
  getProject,
  getRoom,
  getTaskBoard,
  getOfficeRoomRecord,
  listMessages,
  listVaultFiles,
  recordRoomHandoff,
} from '@agent-room/upstash-client';
import type { ClientKind, Message, OfficeAuditEntry, OfficeProject, VaultFile } from '@agent-room/shared';
import {
  generateCode,
  handoffTopic,
  isValidCode,
  planRoomHandoff,
  type HandoffDeliverable,
} from '@agent-room/shared';
import { createRemoteRoomClient } from './_mcpRoomClient.js';
import { siteUrl } from './_siteUrl.js';
import { OfficeApiError, audit, captureRoomArchive, roomExpiry, seatAgents } from './_office.js';

export interface HandoffOptions {
  ownerName?: string;
  /** Close the source room after the handoff (its minutes are archived first). */
  endSource?: boolean;
  now?: number;
}

export interface HandoffResult {
  sourceCode: string;
  successorCode: string;
  joinUrl: string;
  roomUrl: string;
  topic: string;
  carried: Array<{ id: string; title: string; state: string; owner?: string }>;
  skipped: string[];
  deliverables: number;
  seated: string[];
  archiveId?: string;
  sourceEnded: boolean;
  daysLeft: number;
}

/**
 * Open a successor room for `code` and carry its open work into it.
 *
 * Idempotent in the way that matters: a room that already has a successor is
 * refused with that successor's code rather than silently given a second one,
 * because two continuations of the same work is how a board forks.
 */
export async function handoffRoom(
  store: UpstashClient,
  code: string,
  actor: OfficeAuditEntry['actor'],
  options: HandoffOptions = {},
): Promise<HandoffResult> {
  const now = options.now ?? Date.now();
  const room = await getRoom(store, code).catch(() => undefined);
  if (!room) throw new OfficeApiError(`No room ${code} (rooms expire 30 days after creation).`, 404, 'room_not_found');
  if (room.status !== 'active') {
    throw new OfficeApiError('Only an open room can be handed over.', 409, 'room_not_active');
  }
  const record = await getOfficeRoomRecord(store, code).catch(() => null);
  if (record?.successorRoomCode) {
    throw new OfficeApiError(
      `Room ${code} already continues in ${record.successorRoomCode}.`,
      409,
      'handoff_exists',
    );
  }

  const [board, project, deliverables, messages] = await Promise.all([
    getTaskBoard(store, code).catch(() => null),
    (room.projectId ?? record?.projectId)
      ? getProject(store, room.projectId ?? record!.projectId!).catch(() => null)
      : Promise.resolve(null as OfficeProject | null),
    listVaultFiles(store, 'deliverable', code).catch(() => [] as VaultFile[]),
    listMessages(store, code, 0).catch(() => []),
  ]);
  // The successor does not get the transcript — the archive holds that — but a
  // successor that repeats a decision already made has wasted the move. The
  // marked lines are the ones the room itself said to keep.
  const decisions = messages
    .filter(message => /\[(DECISION|RESULT)\]/i.test(message.text) && message.type !== 'sys')
    .map(message => `[${message.name}] ${message.text.replace(/\s+/g, ' ').trim()}`);


  const deliverableRefs: HandoffDeliverable[] = deliverables.map(file => ({
    id: file.id,
    name: file.name,
    version: file.version,
    size: file.size,
    mime: file.mime,
    ...(file.producer ? { producer: file.producer } : {}),
    ...(file.taskId ? { taskId: file.taskId } : {}),
  }));
  const { daysLeft } = roomExpiry(room.createdAt, now);
  const plan = planRoomHandoff({
    topic: room.topic,
    code,
    tasks: board?.tasks ?? [],
    ...(project ? {
      project: {
        id: project.id,
        name: project.name,
        memories: (project.memory ?? []).map(entry => ({ title: entry.title })),
        guidelines: (project.guidelines ?? []).map(entry => ({ title: entry.title })),
      },
    } : {}),
    deliverables: deliverableRefs,
    now,
    daysLeft,
    ...(decisions.length ? { decisions } : {}),
  });

  const client = createRemoteRoomClient(undefined);
  const owner = options.ownerName?.trim() || room.createdBy || 'Owner';
  const successorTopic = handoffTopic(room.topic, code);
  let successorCode = '';
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const candidate = generateCode();
    if (!isValidCode(candidate)) continue;
    try {
      await createRoom(client.store, { code: candidate, createdBy: owner, topic: successorTopic, requireUnusedCode: true });
      successorCode = candidate;
      break;
    } catch (error) {
      if ((error as { name?: string }).name === 'RoomCodeTakenError') continue;
      throw error;
    }
  }
  if (!successorCode) throw new OfficeApiError('Could not allocate a room code. Try again.', 503, 'room_code_unavailable');

  // A task's owner must be in the room before the task exists (roles are read
  // from the roster), so the agents are seated first — exactly as a template run
  // does it.
  const agents = room.participants
    .filter(participant => participant.client === 'cc')
    .map(participant => ({ name: participant.name, role: participant.role }));
  const seated = await seatAgents(client.store, successorCode, agents, now).catch(() => [] as string[]);

  const carried: HandoffResult['carried'] = [];
  const skipped: string[] = [];
  for (const task of plan.carry) {
    try {
      const result = await createTask(client.store, successorCode, {
        id: task.id,
        title: task.title,
        ...(task.dod ? { dod: task.dod } : {}),
        ...(task.owner ? { owner: task.owner, ownerClient: 'cc' as ClientKind } : {}),
        ...(task.verifier ? { verifier: task.verifier, verifierClient: 'cc' as ClientKind } : {}),
        ...(task.requiresApproval ? { requiresApproval: true } : {}),
        createdBy: owner,
        ...(project ? { projectId: project.id } : {}),
      }, now);
      carried.push({
        id: result.task.id,
        title: result.task.title,
        state: result.task.state,
        ...(result.task.owner ? { owner: result.task.owner } : {}),
      });
    } catch (error) {
      skipped.push(`${task.id} ${task.title} (${(error as Error).message})`);
    }
  }

  const note: Message = {
    id: Date.now(),
    type: 'sys',
    name: 'Office',
    client: 'web',
    initials: 'OF',
    color: '#5B6AFF',
    role: 'system',
    time: now,
    text: plan.note,
    metadata: { eventType: 'handoff' },
  };
  await appendSystemMessage(client.store, successorCode, note).catch(() => undefined);

  await recordRoomHandoff(store, {
    sourceCode: code,
    successorCode,
    at: now,
    by: actor.name,
    taskCount: carried.length,
    ...(project ? { projectId: project.id } : {}),
    topic: room.topic,
    successorTopic,
  });
  await audit(store, actor, 'room.handoff', {
    roomCode: code,
    target: successorCode,
    detail: `${carried.length} tasks, ${plan.deliverables.length} deliverables${skipped.length ? `, ${skipped.length} skipped` : ''}${project ? ` · ${project.name}` : ''}`,
  });

  // Archive the source so its minutes and deliverable index exist no matter what
  // happens to it later. Best effort, exactly like ending a room.
  const archive = await captureRoomArchive(store, code, actor, now).catch(() => null);

  let sourceEnded = false;
  if (options.endSource) {
    const { endRoom } = await import('@agent-room/upstash-client');
    await endRoom(store, code).catch(() => undefined);
    sourceEnded = true;
    await audit(store, actor, 'room.end', { roomCode: code, detail: `handed over to ${successorCode}` });
  }

  return {
    sourceCode: code,
    successorCode,
    joinUrl: `${siteUrl()}/j/${successorCode}`,
    roomUrl: `${siteUrl()}/r/${successorCode}`,
    topic: successorTopic,
    carried,
    skipped,
    deliverables: plan.deliverables.length,
    seated,
    ...(archive ? { archiveId: archive.id } : {}),
    sourceEnded,
    daysLeft,
  };
}
