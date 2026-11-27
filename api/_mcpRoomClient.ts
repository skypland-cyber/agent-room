import { invalidateOfficeOverview } from './_office.js';
import { findSeat } from './_roomAccess.js';
import { generateCode } from '@agent-room/shared';
import type { Message, Participant, Room, RoomReport } from '@agent-room/shared';
import {
  createClient,
  createRoom as storeCreateRoom,
  RoomCodeTakenError,
  isConfiguredModerator,
  createRoomReport as storeCreateRoomReport,
  endRoom as storeEndRoom,
  getRoom as storeGetRoom,
  joinRoom as storeJoinRoom,
  listMessages as storeListMessages,
  appendMessage as storeAppendMessage,
  reactivateRoom as storeReactivateRoom,
  removeParticipant as storeRemoveParticipant,
  setListenUntil as storeSetListenUntil,
  updatePresence,
  verifyHostKey,
  HostNameTakenError,
  MutedError,
  NotHostError,
  NotYourTurnError,
  RoomNotFoundError,
  getTaskBoard,
  createTask,
  claimTask,
  submitTask,
  verifyTask,
  reassignTaskRoles,
  cancelTask,
  updateTask,
  waitTask,
  resumeTask,
  pauseTask,
  unpauseTask,
  abortTask,
  decideTaskApproval,
  recordTaskQa,
  retryTask,
  requireTaskApproval,
  acknowledgeTaskReview,
  operateTaskExecution,
  reconcileTaskReviews,
  publishTaskNotifications,
  reportAgentCapabilities,
  sanitizeCapabilityReport,
  TaskExecutionError,
  SeatProofError,
  sha256Hex,
  registerRoomWebhook,
  listRoomWebhooks,
  unregisterRoomWebhook,
  WebhookLimitError,
  NotParticipantError,
  setReplyMode,
  getTurnState,
  setTurnState,
  addHostDirected,
  skipQueueHead,
  canAgentSpeakNow,
  myRoleInTurn,
  sweepTimeouts,
} from '@agent-room/upstash-client';
import type { UpstashClient } from '@agent-room/upstash-client';
import { dispatchRoomWebhooks, validateWebhookUrl } from './_webhookDispatch.js';

/** Same shape the hosted deployment's client throws, so the tool layer's
 *  error handling is identical on both. */
export class RemoteRoomApiError extends Error {
  constructor(message: string, readonly status: number, readonly code: string) {
    super(message);
    this.name = 'RemoteRoomApiError';
  }
}

export interface RemoteRoomClient {
  readonly store: UpstashClient;
  /**
   * The rest of the room API, as an action envelope.
   *
   * The eleven named functions below cover the room lifecycle, but the task
   * board, webhook and moderator-admin tools in `_mcpTools.ts` reach past them
   * and post an `{ action }` payload directly. That is the hosted deployment's
   * HTTP body; here it is dispatched onto upstash-client instead. Every action
   * the tool layer sends must be handled — an unknown one throws rather than
   * returning a plausible empty result, because a task board that silently
   * does nothing is worse than one that fails loudly.
   */
  post<T>(payload: Record<string, unknown>): Promise<T>;
}

export function createRemoteRoomClient(_requestHost: string | undefined): RemoteRoomClient {
  const url = process.env.UPSTASH_REDIS_REST_URL ?? process.env.KV_REST_API_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN ?? process.env.KV_REST_API_TOKEN;
  if (!url || !token) {
    throw new RemoteRoomApiError(
      'Room storage is not configured. Set UPSTASH_REDIS_REST_URL and UPSTASH_REDIS_REST_TOKEN on the deployment.',
      500,
      'not_configured',
    );
  }
  const store = createClient({ url, token });
  return { store, post: (payload) => dispatchAction(store, payload) as never };
}

const str = (v: unknown): string => (typeof v === 'string' ? v : '');
const agent = (name: unknown) => ({ name: str(name), client: 'cc' as const });

/** Seat proof and fencing token an MCP task call carries. */
function executionProof(p: Record<string, unknown>) {
  return {
    ...(typeof p.seatKey === 'string' && p.seatKey ? { seatKey: p.seatKey } : {}),
    ...(typeof p.attemptId === 'string' && p.attemptId ? { attemptId: p.attemptId } : {}),
    ...(typeof p.ttlMs === 'number' ? { ttlMs: p.ttlMs } : {}),
  };
}

/** True only when the presented hostKey matches the room's stored hash. */
async function isProvenHost(store: UpstashClient, code: string, hostKey: unknown): Promise<boolean> {
  if (typeof hostKey !== 'string' || !hostKey) return false;
  try {
    const room = await storeGetRoom(store, code);
    return !!room.hostKeyHash && room.hostKeyHash === await sha256Hex(hostKey);
  } catch {
    return false;
  }
}

/**
 * Publish any pending task responsibility notifications as targeted system
 * messages, then fan each one out to the target's webhooks.
 * Never fatal: an unpublished intent stays on the board and is retried.
 */
export async function publishBoardNotifications(store: UpstashClient, code: string): Promise<void> {
  try {
    await publishTaskNotifications(store, code, async (message, room) => {
      const cursor = await storeListMessages(store, code, 0).then(m => m.length).catch(() => null);
      await dispatchRoomWebhooks(store, room, message, cursor);
    });
  } catch { /* the board keeps the intent */ }
}

/** Board read that also repairs review assignment and publishes due notices. */
async function readBoard(store: UpstashClient, code: string) {
  try { await reconcileTaskReviews(store, code); } catch { /* read-only fallback below */ }
  await publishBoardNotifications(store, code);
  return getTaskBoard(store, code);
}

/**
 * Every task write is followed by notification publication and a dropped
 * dashboard cache.
 *
 * The office dashboard caches its payload for under two minutes, and an agent
 * claiming, submitting or verifying a card is what the floor is supposed to show
 * happening. Dropping the cache here — the one place every MCP task write goes
 * through — means the next dashboard poll sees the change instead of waiting out
 * the TTL. One DEL, after the write has landed; a failure to drop it only costs
 * that wait.
 */
async function afterTaskWrite<T>(store: UpstashClient, code: string, result: T): Promise<T> {
  await publishBoardNotifications(store, code);
  await invalidateOfficeOverview(store);
  return result;
}

/** The `{ action }` envelope, mapped onto upstash-client. */
async function dispatchAction(store: UpstashClient, p: Record<string, unknown>): Promise<unknown> {
  const code = str(p.code);
  try {
    switch (p.action) {
      // ── task board ──────────────────────────────────────────────────────
      case 'taskBoard':
        return { board: (await readBoard(store, code)) ?? { code, tasks: [], version: 0 } };
      case 'taskCreate':
        return afterTaskWrite(store, code, await createTask(store, code, {
          title: str(p.title),
          createdBy: str(p.requesterName),
          ...(p.id ? { id: str(p.id) } : {}),
          ...(p.owner ? { owner: str(p.owner), ownerClient: 'cc' as const } : {}),
          ...(p.verifier ? { verifier: str(p.verifier), verifierClient: 'cc' as const } : {}),
          ...(p.dod ? { dod: str(p.dod) } : {}),
          ...(p.requirements !== undefined ? { requirements: p.requirements as Parameters<typeof createTask>[2]['requirements'] } : {}),
          ...(p.requiresApproval === true ? { requiresApproval: true } : {}),
        }));
      case 'taskClaim':
        // Every MCP claim starts a fenced execution; the seatKey proves the seat.
        return afterTaskWrite(store, code, await claimTask(store, code, str(p.id), agent(p.name), Date.now(), executionProof(p)));
      case 'taskSubmit': {
        const proof = executionProof(p);
        return afterTaskWrite(store, code, await submitTask(
          store, code, str(p.id), agent(p.name),
          p.evidence as Parameters<typeof submitTask>[4],
          Date.now(),
          proof.seatKey || proof.attemptId ? proof : undefined,
        ));
      }
      case 'taskVerify': {
        const proof = executionProof(p);
        return afterTaskWrite(store, code, await verifyTask(
          store, code, str(p.id), agent(p.name),
          p.verdict === 'done' ? 'done' : 'rejected',
          typeof p.note === 'string' ? p.note : undefined,
          Date.now(),
          proof.seatKey ? { reviewerProof: proof } : {},
        ));
      }
      case 'taskReassign':
        return afterTaskWrite(store, code, await reassignTaskRoles(store, code, str(p.id), {
          ...(p.owner ? { owner: str(p.owner), ...(p.ownerClient ? { ownerClient: p.ownerClient as 'cc' | 'web' } : {}) } : {}),
          ...(p.verifier ? { verifier: str(p.verifier), ...(p.verifierClient ? { verifierClient: p.verifierClient as 'cc' | 'web' } : {}) } : {}),
        }, agent(p.requesterName)));
      case 'taskCancel':
        return afterTaskWrite(store, code, await cancelTask(
          store, code, str(p.id), agent(p.requesterName),
          typeof p.reason === 'string' ? p.reason : undefined,
        ));
      case 'taskUpdate':
        return afterTaskWrite(store, code, await updateTask(store, code, str(p.id), {
          ...(typeof p.title === 'string' ? { title: p.title } : {}),
          ...(typeof p.dod === 'string' ? { dod: p.dod } : {}),
          ...(p.requirements !== undefined ? { requirements: p.requirements as Parameters<typeof updateTask>[3]['requirements'] } : {}),
          actor: agent(p.requesterName),
        }));
      case 'taskWait': {
        const host = await isProvenHost(store, code, p.hostKey);
        const proof = executionProof(p);
        return afterTaskWrite(store, code, await waitTask(store, code, str(p.id), agent(p.name), {
          scope: p.scope === 'review' ? 'review' : 'owner',
          reasonCode: str(p.reasonCode) as Parameters<typeof waitTask>[4]['reasonCode'],
          reason: str(p.reason),
          resumeWhen: str(p.resumeWhen),
          ...(typeof p.waitingFor === 'string' && p.waitingFor ? { waitingFor: p.waitingFor } : {}),
        }, Date.now(), host, proof.seatKey ? proof : undefined));
      }
      case 'taskResume': {
        const host = await isProvenHost(store, code, p.hostKey);
        const proof = executionProof(p);
        return afterTaskWrite(store, code, await resumeTask(store, code, str(p.id), agent(p.name), str(p.resolution),
          Date.now(), host, proof.seatKey ? proof : undefined));
      }
      case 'taskPause':
      case 'taskUnpause': {
        // Pausing is a control action, not a work action: the owner may freeze
        // its own task, and the proven host may freeze anyone's. A bystander
        // agent stopping somebody else's work is how boards quietly die.
        const host = await isProvenHost(store, code, p.hostKey);
        if (!host) {
          const board = await readBoard(store, code);
          const task = board?.tasks.find(item => item.id === str(p.id));
          if (!task || !task.owner || task.owner.trim().toLowerCase() !== str(p.requesterName).trim().toLowerCase()) {
            throw new RemoteRoomApiError('Only the task owner or the host can pause or resume this task.', 403, 'access_denied');
          }
        }
        return afterTaskWrite(store, code, p.action === 'taskPause'
          ? await pauseTask(store, code, str(p.id), agent(p.requesterName), typeof p.reason === 'string' ? p.reason : undefined)
          : await unpauseTask(store, code, str(p.id), agent(p.requesterName)));
      }
      case 'taskAbort':
        // Terminal, and in the user's name: only the proven host may stop work.
        await assertHostFor(store, code, str(p.hostKey));
        return afterTaskWrite(store, code, await abortTask(store, code, str(p.id),
          { name: str(p.requesterName) || 'host', client: 'web' },
          typeof p.reason === 'string' ? p.reason : undefined));
      case 'taskApprove': {
        await assertHostFor(store, code, str(p.hostKey));
        const decision = p.decision === 'rejected' ? 'rejected' : 'approved';
        return afterTaskWrite(store, code, await decideTaskApproval(store, code, str(p.id), decision,
          { name: str(p.requesterName) || 'host', client: 'web' },
          typeof p.note === 'string' ? p.note : undefined));
      }
      case 'taskRequestApproval':
        return afterTaskWrite(store, code, await requireTaskApproval(store, code, str(p.id),
          agent(p.requesterName), typeof p.reason === 'string' ? p.reason : undefined));
      case 'taskQa': {
        const status = str(p.status) as 'pending' | 'passed' | 'failed';
        if (!['pending', 'passed', 'failed'].includes(status)) {
          throw new RemoteRoomApiError('QA status must be pending, passed or failed.', 400, 'bad_request');
        }
        return afterTaskWrite(store, code, await recordTaskQa(store, code, str(p.id), agent(p.name), status,
          typeof p.notes === 'string' ? p.notes : undefined));
      }
      case 'taskRetry': {
        const proof = executionProof(p);
        return afterTaskWrite(store, code, await retryTask(store, code, str(p.id), agent(p.requesterName), {
          ...(typeof p.reason === 'string' ? { reason: p.reason } : {}),
          ...(typeof p.to === 'string' && p.to ? { to: p.to } : {}),
        }));
      }
      case 'taskReviewAck': {
        const proof = executionProof(p);
        return afterTaskWrite(store, code, await acknowledgeTaskReview(store, code, str(p.id), agent(p.name), p.started === true,
          typeof p.notificationId === 'string' && p.notificationId ? p.notificationId : undefined, Date.now(),
          proof.seatKey ? proof : undefined));
      }
      case 'taskExecution': {
        const operation = str(p.operation) as 'renew' | 'recover' | 'release' | 'handoff';
        if (!['renew', 'recover', 'release', 'handoff'].includes(operation)) {
          throw new RemoteRoomApiError(`Unknown execution operation "${operation}".`, 400, 'bad_request');
        }
        return afterTaskWrite(store, code, await operateTaskExecution(store, code, str(p.id), agent(p.name), operation,
          executionProof(p), {
            ...(typeof p.resolution === 'string' ? { resolution: p.resolution } : {}),
            ...(typeof p.to === 'string' ? { to: p.to } : {}),
          }));
      }
      case 'agentCapabilities': {
        const room = await reportAgentCapabilities(store, code, str(p.name), p.capabilities,
          typeof p.seatKey === 'string' ? p.seatKey : undefined, sanitizeCapabilityReport);
        // A new report can make a waiting review assignable.
        const board = await readBoard(store, code).catch(() => null);
        const me = room.participants.find(item => item.name === str(p.name) && item.client === 'cc');
        return { capabilities: me?.capabilities, ...(board ? { board } : {}) };
      }

      // ── resident webhooks ───────────────────────────────────────────────
      case 'webhookSet': {
        // Validate the destination before storing it for server-side delivery.
        const check = validateWebhookUrl(str(p.url));
        if (check.ok === false) {
          throw new RemoteRoomApiError(`Refusing that webhook URL: ${check.reason}`, 400, 'bad_request');
        }
        const webhook = await registerRoomWebhook(store, code, {
          url: str(p.url),
          registeredBy: str(p.requesterName),
          ...(typeof p.secret === 'string' && p.secret ? { secret: p.secret } : {}),
        });
        const { secret: _secret, ...publicWebhook } = webhook;
        return { webhook: publicWebhook };
      }
      case 'webhookList':
        return { webhooks: (await listRoomWebhooks(store, code)).map(({ secret: _secret, ...hook }) => hook) };
      case 'webhookDelete': {
        return { removed: await unregisterRoomWebhook(store, code, str(p.id), str(p.requesterName)) };
      }

      // ── host / moderator controls ───────────────────────────────────────
      case 'setReplyMode': {
        const hostRoom = await assertHostFor(store, code, str(p.hostKey));
        const room = await setReplyMode(
          store, code, hostRoom.createdBy,
          p.mode as Parameters<typeof setReplyMode>[3],
          p.config as Parameters<typeof setReplyMode>[4],
        );
        return { room };
      }
      case 'directInvoke': {
        const source = p.source === 'moderator' ? 'moderator' : 'host';
        if (source === 'moderator') {
          const room = await storeGetRoom(store, code);
          const seat = findSeat(room, 'cc', p.seatKey);
          if (!seat || seat.canSpeak === false || room.replyMode !== 'moderator' || !isConfiguredModerator(room, seat.name, 'cc')) {
            throw new RemoteRoomApiError('Only the seated moderator can direct this turn.', 403, 'NotHostError');
          }
        } else {
          await assertHostFor(store, code, str(p.hostKey));
        }
        const target = p.target as { name?: string } | undefined;
        const state = await getTurnState(store, code);
        const next = addHostDirected(state ?? { queue: [], startedAt: Date.now() } as never, str(target?.name), 'cc', source);
        await setTurnState(store, code, next);
        return { added: true };
      }
      case 'skipCurrent': {
        await assertHostFor(store, code, str(p.hostKey));
        const state = await getTurnState(store, code);
        if (!state) return { skipped: null };
        const next = skipQueueHead(state);
        await setTurnState(store, code, next);
        return { skipped: next.currentName ?? null };
      }

      default:
        throw new RemoteRoomApiError(
          `Unsupported room action "${String(p.action)}" on this deployment.`,
          400,
          'unsupported_action',
        );
    }
  } catch (e) {
    if (e instanceof TaskExecutionError) throw new RemoteRoomApiError(e.message, 409, `task_execution_${e.code}`);
    if (e instanceof SeatProofError) throw new RemoteRoomApiError(e.message, 403, 'task_execution_identity_required');
    if (e instanceof WebhookLimitError) throw new RemoteRoomApiError(e.message, 409, 'WebhookLimitError');
    if (e instanceof NotParticipantError) throw new RemoteRoomApiError(e.message, 403, 'NotParticipantError');
    return translate(e);
  }
}

export async function assertHostFor(
  store: UpstashClient, code: string, hostKey: string | undefined,
): Promise<Room> {
  const room = await storeGetRoom(store, code);
  if (hostKey && room.hostKeyHash) {
    try {
      await verifyHostKey(store, code, hostKey);
      return room;
    } catch (error) {
      if (!(error instanceof HostNameTakenError)) throw error;
    }
  }
  throw new RemoteRoomApiError('A valid room host key is required.', 403, 'NotHostError');
}

/**
 * Map a storage-layer throw onto the code the tool layer knows how to explain.
 * Anything unrecognised is rethrown untouched — inventing a code for an error
 * we do not understand would hand the agent confident, wrong guidance.
 */
function translate(e: unknown): never {
  if (e instanceof RemoteRoomApiError) throw e;
  if (e instanceof MutedError) throw new RemoteRoomApiError(e.message, 403, 'MutedError');
  if (e instanceof NotYourTurnError) throw new RemoteRoomApiError(e.message, 409, 'NotYourTurnError');
  if (e instanceof NotHostError) throw new RemoteRoomApiError(e.message, 403, 'NotHostError');
  if (e instanceof HostNameTakenError) throw new RemoteRoomApiError(e.message, 409, 'HostNameTakenError');
  if (e instanceof RoomNotFoundError) throw new RemoteRoomApiError(e.message, 404, 'RoomNotFoundError');
  throw e;
}

async function guarded<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (e) {
    return translate(e);
  }
}

export async function createRoom(
  client: RemoteRoomClient,
  input: { topic: string; createdBy: string },
): Promise<Room & { hostKey: string }> {
  // Codes are generated here rather than by the caller, matching the hosted
  // server. A collision is a 1-in-many-millions event, but retrying twice is
  // cheaper than explaining to a user why their room code was already taken.
  let lastError: unknown;
  for (let attempt = 0; attempt < 3; attempt++) {
    const code = generateCode();
    try {
      return await storeCreateRoom(client.store, { code, topic: input.topic, createdBy: input.createdBy, requireUnusedCode: true });
    } catch (e) {
      if (!(e instanceof RoomCodeTakenError)) return translate(e);
      lastError = e;
    }
  }
  return translate(lastError);
}

export async function getRoom(client: RemoteRoomClient, code: string): Promise<Room> {
  return guarded(() => storeGetRoom(client.store, code));
}

/** Read the speaking entitlement from storage, including legacy grace and
 * moderator direct assignments. No commercial HTTP/auth service is required. */
export async function getSpeakingTurn(client: RemoteRoomClient, code: string, name: string) {
  const room = await storeGetRoom(client.store, code);
  if (room.status !== 'active' || !room.participants.some(p => p.name === name && p.client === 'cc' && p.canSpeak !== false)) return null;
  const mode = room.replyMode;
  if (mode !== 'sequential' && mode !== 'moderator') return null;
  const { state } = await sweepTimeouts(client.store, code, room);
  if (!state || state.mode !== mode) return null;
  const directed = state.hostDirected?.some(p => p.name === name && p.client === 'cc');
  if (!directed && !canAgentSpeakNow(state, name, 'cc')) return null;
  return {
    mode,
    round: state.round ?? 1,
    role: directed ? 'assignee' as const : myRoleInTurn(state, name, 'cc'),
    isLead: state.currentName === name && state.currentClient === 'cc'
      && (state.currentRole === 'lead' || state.currentRole === 'wrap'),
  };
}

/**
 * Refresh what the room knows about who is present.
 *
 * The hosted server has a dedicated `sweep` action that also expires stale
 * seats. Here the same read is a `getRoom`, which already normalises the
 * stored record; presence expiry is the caller's business via
 * `isParticipantStale`, not a stored mutation.
 */
export async function sweepRoom(client: RemoteRoomClient, code: string): Promise<Room> {
  return guarded(() => storeGetRoom(client.store, code));
}

export async function joinRoom(
  client: RemoteRoomClient,
  code: string,
  participant: Participant,
  options: { hostKey?: string; seatKey?: string; grantRef?: string } = {},
): Promise<Room & { participant: Participant; seatKey?: string }> {
  return guarded(async () => {
    const result = await storeJoinRoom(client.store, code, participant, {
      ...(options.hostKey ? { hostKey: options.hostKey } : {}),
      ...(options.seatKey ? { seatKey: options.seatKey } : {}),
      // Which MCP grant opened this seat. Without it a restart that lost its
      // seatKey is indistinguishable from a stranger using the same name, and
      // the room forks a second row for the same agent.
      ...(options.grantRef ? { grantRef: options.grantRef } : {}),
      requireSeatProof: true,
      priorIdentity: { name: participant.name, client: 'cc' as const },
    });
    // A joining agent may be the reviewer a solo submission was waiting for,
    // and a rejoin may have rotated a seat that held an execution lease.
    try { await reconcileTaskReviews(client.store, code); } catch { /* best effort */ }
    await publishBoardNotifications(client.store, code);
    return result as Room & { participant: Participant; seatKey?: string };
  });
}

export async function listMessages(client: RemoteRoomClient, code: string, since: number): Promise<Message[]> {
  return guarded(() => storeListMessages(client.store, code, since));
}

export async function appendMessage(
  client: RemoteRoomClient,
  code: string,
  message: Message,
  kind: 'message' | 'status' = 'message',
): Promise<unknown> {
  const result = await guarded(() => storeAppendMessage(client.store, code, message, kind));
  // Fan out to resident webhooks. The hosted server does this from its send
  // path; storage does not do it for us, so without this a registered webhook
  // would be a row in Redis that never fires — a tool that appears to work and
  // silently does nothing, which is worse than one that refuses.
  //
  // Best-effort and never fatal: a subscriber's broken endpoint must not turn
  // a delivered message into a failed room_send.
  try {
    const room = await storeGetRoom(client.store, code);
    const cursor = (result as { cursor?: number } | null)?.cursor ?? null;
    await dispatchRoomWebhooks(client.store, room, message, cursor);
  } catch { /* delivery is not the sender's problem */ }
  return result;
}

export async function setListenUntil(
  client: RemoteRoomClient,
  code: string,
  name: string,
  until: number,
): Promise<void> {
  await guarded(async () => {
    await storeSetListenUntil(client.store, code, name, until);
    await updatePresence(client.store, code, name, Date.now());
  });
}

export async function removeParticipant(
  client: RemoteRoomClient,
  code: string,
  requesterName: string,
  targetName: string,
): Promise<Room> {
  // MCP agents are always 'cc' seats; the web seats leave through the UI.
  return guarded(() => storeRemoveParticipant(client.store, code, requesterName, targetName, 'cc'));
}

export async function endRoom(
  client: RemoteRoomClient,
  code: string,
  _requesterName: string,
  hostKey: string | undefined,
): Promise<Room> {
  const room = await guarded(async () => {
    await assertHostFor(client.store, code, hostKey);
    return storeEndRoom(client.store, code);
  });
  // Permanent archive: rooms expire in 30 days, the minutes should not. Loaded
  // lazily so the office module can import this one without a cycle, and
  // best-effort so an archive failure never blocks ending a meeting.
  try {
    const { captureRoomArchive } = await import('./_office.js');
    await captureRoomArchive(client.store, code, { name: room.createdBy || 'host', kind: 'host' });
  } catch { /* the room ended; the dashboard can archive it later */ }
  return room;
}

export async function reactivateRoom(
  client: RemoteRoomClient,
  code: string,
  _requesterName: string,
  hostKey: string | undefined,
): Promise<Room> {
  return guarded(async () => {
    await assertHostFor(client.store, code, hostKey);
    return storeReactivateRoom(client.store, code);
  });
}

export async function createRoomReport(client: RemoteRoomClient, code: string): Promise<RoomReport> {
  return guarded(async () => {
    const room = await storeGetRoom(client.store, code);
    const messages = await storeListMessages(client.store, code, 0);
    return storeCreateRoomReport(client.store, room, messages);
  });
}
