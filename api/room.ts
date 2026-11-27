import type { VercelRequest, VercelResponse } from '@vercel/node';
import { isValidCode, type Message } from '@agent-room/shared';
import * as storage from '@agent-room/upstash-client';
import { assertHostFor, createRemoteRoomClient, publishBoardNotifications, RemoteRoomApiError } from './_mcpRoomClient.js';
import { digest, findSeat, withinRateLimit } from './_roomAccess.js';
import { captureRoomArchive, invalidateOfficeOverview } from './_office.js';

const string = (value: unknown) => typeof value === 'string' ? value : '';
/**
 * Room-side actions that change a task board (or end the room that holds one).
 * After them the office dashboard's cached payload no longer describes the
 * office, so the cache is dropped. Reads are absent on purpose: they are the
 * cheap half of the API and must not cost a DEL.
 */
const boardWriteOperations = new Set([
  'createTask', 'updateTask', 'reassignTaskRoles', 'cancelTask', 'verifyTask',
  'resumeTask', 'blockTask', 'endRoom', 'reactivateRoom',
]);

const hostOperations = new Set([
  'setMuted', 'setReplyMode', 'endRoom', 'reactivateRoom', 'directInvoke', 'hostSkipCurrent',
  'appendSystemMessage', 'createRoomReport', 'createTask', 'updateTask', 'reassignTaskRoles', 'cancelTask',
]);

async function run(body: Record<string, unknown>, store: storage.UpstashClient) {
  const { action, code, hostKey, seatKey } = body;
  const args = Array.isArray(body.args) ? body.args : [];
  if (typeof code !== 'string' || !isValidCode(code)) {
    throw new RemoteRoomApiError('Invalid room code.', 400, 'bad_request');
  }

  if (action === 'createRoom') {
    const input = args[0] as Partial<storage.CreateRoomInput> | undefined;
    const createdBy = string(input?.createdBy).trim();
    const topic = string(input?.topic).trim();
    if (!createdBy || createdBy.length > 100 || !topic || topic.length > 500) {
      throw new RemoteRoomApiError('Invalid room name or topic.', 400, 'bad_request');
    }
    return storage.createRoom(store, { code, createdBy, topic, requireUnusedCode: true });
  }
  if (action === 'getRoomReport') return storage.getRoomReport(store, code);

  const room = await storage.getRoom(store, code);
  const seat = findSeat(room, 'web', seatKey);
  if (action === 'getRoom') {
    if (seat) return room;
    const { topic, createdBy, createdAt, status, version, participants } = room;
    return { code, topic, createdBy, createdAt, status, version,
      participants: participants.map(({ name, role, color, initials, client }) => ({ name, role, color, initials, client })) };
  }
  if (action === 'joinRoom') {
    const input = args[0] as { name?: unknown; role?: unknown; color?: unknown; initials?: unknown } | undefined;
    const name = string(input?.name).trim();
    if (!name || name.length > 100) throw new RemoteRoomApiError('Invalid participant name.', 400, 'bad_request');
    const now = Date.now();
    return storage.joinRoom(store, code, {
      name, role: string(input?.role).slice(0, 100), color: string(input?.color).slice(0, 40),
      initials: string(input?.initials).slice(0, 8), client: 'web', joinedAt: now, lastSeenAt: now,
    }, {
      requireSeatProof: true, hostKey: string(hostKey), seatKey: string(seatKey),
      priorIdentity: seat?.name === name ? { name, client: 'web' } : undefined,
    });
  }

  if (!seat) throw new RemoteRoomApiError('Join the room to obtain a valid participant key.', 403, 'not_participant');
  const isHost = seat.name === room.createdBy && !!room.hostKeyHash &&
    typeof hostKey === 'string' && digest(hostKey) === room.hostKeyHash;
  if (hostOperations.has(string(action))) await assertHostFor(store, code, string(hostKey));
  const actor = { name: seat.name, client: 'web' as const };
  const targetClient = args[2] === 'cc' ? 'cc' : 'web';

  switch (action) {
    case 'listMessages':
      return storage.listMessages(store, code, Math.max(0, Number(args[0]) || 0));
    case 'getMessageTotalCount':
      return storage.getMessageTotalCount(store, code);
    case 'getTaskBoard':
      return storage.getTaskBoard(store, code);
    case 'getTurnState':
      return storage.getTurnState(store, code);
    case 'updatePresence':
      return storage.updatePresence(store, code, seat.name, Date.now());
    case 'appendMessage': {
      const input = args[0] as Partial<Message> | undefined;
      if (!input || typeof input.text !== 'string' || input.text.length > 32000) {
        throw new RemoteRoomApiError('Invalid message.', 400, 'bad_request');
      }
      const { name, role, color, initials } = seat;
      return storage.appendMessage(store, code, {
        id: Number.isSafeInteger(input.id) ? input.id! : Date.now(),
        name, role, color, initials, client: 'web', type: 'msg', text: input.text,
        time: Date.now(), attachments: Array.isArray(input.attachments) ? input.attachments.slice(0, 6) : undefined,
      });
    }
    case 'appendSystemMessage':
      return storage.appendSystemMessage(store, code, args[0] as Message);
    case 'setMuted':
      return storage.setMuted(store, code, room.createdBy, string(args[1]), targetClient, args[3] === true);
    case 'removeParticipant': {
      const target = string(args[1]);
      if (!isHost && (target !== seat.name || targetClient !== 'web')) {
        throw new RemoteRoomApiError('Only the host can remove another participant.', 403, 'NotHostError');
      }
      return storage.removeParticipant(store, code, seat.name, target, targetClient);
    }
    case 'endRoom': {
      const ended = await storage.endRoom(store, code);
      // Rooms expire; the minutes do not. Best-effort: ending a meeting must
      // not fail because the office archive is unavailable.
      await captureRoomArchive(store, code, { name: seat.name, kind: 'host' }).catch(() => undefined);
      return ended;
    }
    case 'reactivateRoom':
      return storage.reactivateRoom(store, code);
    case 'setReplyMode':
      return storage.setReplyMode(store, code, room.createdBy, args[1] as Parameters<typeof storage.setReplyMode>[3],
        args[2] as Parameters<typeof storage.setReplyMode>[4]);
    case 'directInvoke':
      return storage.directInvoke(store, code, args[0] as Parameters<typeof storage.directInvoke>[2], 'host');
    case 'hostSkipCurrent':
      return storage.hostSkipCurrent(store, code, room);
    case 'createRoomReport':
      return storage.createRoomReport(store, room, await storage.listMessages(store, code, 0));
    case 'publishTaskNotifications':
      await publishBoardNotifications(store, code);
      return;
    case 'createTask': {
      const input = args[0] as Parameters<typeof storage.createTask>[2];
      return storage.createTask(store, code, { title: input.title, createdBy: room.createdBy,
        owner: input.owner, ownerClient: input.ownerClient, verifier: input.verifier,
        verifierClient: input.verifierClient, dod: input.dod, requirements: input.requirements });
    }
    case 'updateTask':
      return storage.updateTask(store, code, string(args[0]), { state: 'todo', actor });
    case 'reassignTaskRoles': {
      const patch = args[1] as Parameters<typeof storage.reassignTaskRoles>[3];
      return storage.reassignTaskRoles(store, code, string(args[0]), {
        owner: patch.owner, ownerClient: patch.ownerClient, verifier: patch.verifier, verifierClient: patch.verifierClient,
      }, actor);
    }
    case 'cancelTask':
      return storage.cancelTask(store, code, string(args[0]), actor, string(args[2]));
    case 'verifyTask':
      return storage.verifyTask(store, code, string(args[0]), actor, args[2] === 'done' ? 'done' : 'rejected',
        string(args[3]), Date.now(), { hostOverride: isHost });
    case 'resumeTask':
      return storage.resumeTask(store, code, string(args[0]), actor, string(args[2]), Date.now(), isHost);
    case 'blockTask':
      if (!isHost) {
        const task = (await storage.getTaskBoard(store, code))?.tasks.find(item => item.id === args[0]);
        if (!task || task.owner !== seat.name || task.ownerClient === 'cc') {
          throw new RemoteRoomApiError('Only the task owner or host can block a task.', 403, 'access_denied');
        }
      }
      return storage.blockTask(store, code, string(args[0]), actor, string(args[2]));
    default:
      throw new RemoteRoomApiError('Unknown room operation.', 400, 'bad_request');
  }
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  res.setHeader('Cache-Control', 'no-store');
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).end();
  }
  if (!req.headers['content-type']?.startsWith('application/json') || !req.body ||
      typeof req.body !== 'object' || Array.isArray(req.body)) {
    return res.status(400).json({ error: 'bad_request' });
  }
  const body = req.body as Record<string, unknown>;
  res.setHeader('Content-Type', 'application/json');
  try {
    const { store } = createRemoteRoomClient(undefined);
    if (body.action === 'createRoom' || body.action === 'joinRoom') {
      const ip = req.headers['x-vercel-forwarded-for'] ?? req.socket?.remoteAddress ?? 'unknown';
      if (!await withinRateLimit(store, `web:${digest(String(ip))}`, 30)) {
        res.setHeader('Retry-After', '60');
        return res.status(429).json({ error: 'rate_limited', message: 'Too many room create or join requests.' });
      }
    }
    const result = await run(body, store);
    if (boardWriteOperations.has(String(body.action))) await invalidateOfficeOverview(store);
    return res.status(200).send(JSON.stringify({ result }, (key, value) =>
      ['hostKeyHash', 'seatKeyHash', 'ownerEmail', 'ownerId'].includes(key) ? undefined : value));
  } catch (error) {
    const status = error instanceof RemoteRoomApiError ? error.status
      : error instanceof storage.RoomNotFoundError ? 404
      : error instanceof storage.HostNameTakenError ? 403
      : error instanceof storage.RoomCodeTakenError ? 409
      : error instanceof storage.UpstashError ? 503 : 400;
    const message = status >= 500 ? 'Room service is unavailable.' : error instanceof Error ? error.message : 'Invalid request.';
    return res.status(status).json({ error: error instanceof Error ? error.name : 'bad_request', message });
  }
}
