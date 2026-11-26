import type { Message, MessageMetadata, RoleInTurn, InvocationType, Room, TaskBoard } from '@agent-room/shared';
import { MAX_MESSAGES_PER_ROOM, ROOM_TTL_SECONDS, recordTaskNotificationPublished, sessionStartedAt } from '@agent-room/shared';
import type { UpstashClient } from './client.js';
import { findSpeaker, MutedError, NotYourTurnError, getRoom } from './rooms.js';
import type { TurnSpokenEntry } from './turnState.js';
import {
  advanceOnTimeout,
  advanceTurn,
  applyGraceSupplementReply,
  canAgentSpeakNow,
  casTurnState,
  consumeHostDirectedDetailed,
  isGraceSupplementSpeaker,
  isHumanSender,
  moderatorReply,
  newModeratorTurn,
  newSequentialTurn,
  renewTurnDeadline,
  shouldStartNewTurn,
  skipQueueHead,
} from './turnState.js';

function msgsKey(code: string): string { return `room-msgs:${code}`; }
// Tracks the absolute count of messages ever appended to this room. Used by
// listMessages to translate an agent's logical cursor (= "I've consumed N
// messages so far") into the right LRANGE start position even after LTRIM has
// dropped the oldest entries. Without this, once the list crosses
// MAX_MESSAGES_PER_ROOM the index stored in the cursor stops mapping to the
// list slot the agent thinks it does, and agents silently MISS messages
// (witnessed: 499 in list, +2 RPUSH, LTRIM keeps last 500 → first new
// message is now at index 498, but cursor=499 LRANGEs from 499 and only
// returns the second new message). The counter key is INCRed in the same
// pipeline as RPUSH/LTRIM so it can never drift relative to the list.
function msgCountKey(code: string): string { return `room-msg-count:${code}`; }

/** Next poll cursor after a full `listMessages(..., 0)` when the room has a counter key; `null` = legacy room. */
export async function getMessageTotalCount(client: UpstashClient, code: string): Promise<number | null> {
  const countRaw = await client.command<unknown>(['GET', msgCountKey(code)]);
  if (countRaw === null || countRaw === undefined) return null;
  const totalCount = typeof countRaw === 'number' ? countRaw : parseInt(String(countRaw), 10);
  return Number.isFinite(totalCount) ? totalCount : null;
}

// Supplement-skip token. A supplement agent that has nothing to add MUST
// emit this exact string (after trim) — appendMessage detects it, advances
// the turn with status='no_addition', and does NOT append a message to the
// chat. Slice B does exact-match only; fuzzy matching ("无补充", "Nothing
// to add", etc.) is deferred to a later iteration once we have real prompt
// outputs to calibrate against.
export const NO_ADDITION_TOKEN = '__no_addition__';

// Result of a successful appendMessage call. `appended` is true for normal
// chat messages (the message ended up in the list); false for messages
// that were absorbed by the turn machinery (the supplement-skip token, or
// any future "swallowed" case). Callers like the MCP room_send handler use
// this to decide what hint to send back to the agent.
export interface AppendResult {
  appended: boolean;
  reason?: 'no_addition';
  // The metadata that ended up on the message (or, in the no_addition
  // case, the metadata that WOULD have been attached). Useful for
  // surfacing roleAtSend/turnId in the tool response.
  metadata: MessageMetadata;
  // Sequential lead-grace path: when a queue-head supplement preempts the
  // Lead, the Lead is logged as skipped_by_grace inside the CAS mutator.
  // We surface that entry here so the MCP layer can post a sys message
  // explaining the skip (mirrors how advanceOnTimeout's skipped[] flows
  // to emitTimeoutSysMessage).
  leadSkipped?: TurnSpokenEntry;
}

// Append a message. Server-side gates, in order:
//   1. Mute gate: (name, client) must be a non-muted participant. Throws
//      MutedError otherwise.
//   2. Turn gate (sequential/moderator modes only): the sender must be the
//      current turn-holder, OR a human (web client / host), OR present in
//      the host-directed one-shot allowlist. Throws NotYourTurnError
//      otherwise.
//
// Side effects on success:
//   - Sequential mode: a human message kicks off a new turn if none is
//     active; an agent message advances the turn cursor. Lazy timeout
//     check runs first, silently skipping past expired speakers (callers
//     that want sys messages for those skips watch via the listen poll).
//   - Message metadata is enriched with modeAtSend / roleAtSend / turnId
//     / invocationType. Callers that pre-set message.metadata fields keep
//     them — server-side fields are merged in, server wins on conflict.
//   - Supplement-skip token (`__no_addition__`) advances the turn WITHOUT
//     appending a chat message; returns { appended: false, reason: 'no_addition' }.
//   - `kind: 'status'` (from room_status) posts a status-tagged message that
//     never advances the turn. In sequential mode, when the sender is the
//     current speaker, it also renews their turn deadline (heartbeat) — a
//     long-running agent can signal "still working" without losing the floor.
export async function appendMessage(
  client: UpstashClient,
  code: string,
  message: Message,
  kind: 'message' | 'status' = 'message',
): Promise<AppendResult> {
  const room = await getRoom(client, code);
  if (!findSpeaker(room, message.name, message.client)) {
    throw new MutedError(message.name, room.createdBy);
  }
  const mode = room.replyMode ?? 'open';

  // Fast path: open mode — and the orchestrated modes (consensus / debate),
  // which are driven entirely server-side by a multi-round runner rather than
  // by the turn machinery. They post via appendDemoAgentMessage with no floor
  // to wait for, exactly like open mode, so they take the same gating-free path.
  if (mode === 'open' || mode === 'consensus' || mode === 'debate') {
    const metadata: MessageMetadata = {
      ...(message.metadata ?? {}),
      modeAtSend: mode,
      roleAtSend: 'open',
      invocationType: message.metadata?.invocationType ?? 'normal_turn',
    };
    const enriched: Message = { ...message, metadata };
    await rpushMessage(client, code, enriched, room.createdAt);
    return { appended: true, metadata };
  }

  // Non-open mode: validate and advance turn state atomically.
  // `casTurnState`'s mutator is synchronous and may throw NotYourTurnError
  // to reject — casTurnState re-throws non-Concurrency errors, which we
  // propagate up to the caller (MCP room_send turns this into
  // sent=false/not_your_turn).
  const text = message.text ?? '';
  const isSupplementSkipToken = text.trim() === NO_ADDITION_TOKEN;
  const decision: {
    roleAtSend: RoleInTurn;
    invocationType: InvocationType;
    turnId?: number;
    skipMessage: boolean;
    leadSkipped?: TurnSpokenEntry;
    extendsTurn?: boolean;
  } = {
    roleAtSend: 'open',
    invocationType: 'normal_turn',
    skipMessage: false,
  };

  await casTurnState(client, code, (prev) => {
    // Reset per-attempt decision state so a CAS retry doesn't carry over
    // leadSkipped / extendsTurn from a stale earlier attempt.
    decision.leadSkipped = undefined;
    decision.extendsTurn = false;
    // Lazy cleanup: skip any expired speakers before evaluating this
    // sender. Skipped sys messages are emitted by the listen poll, not
    // here — appendMessage is on the hot path and must not RPUSH a sys
    // event from inside a CAS mutator. We *do* update state.spoken so
    // the listen poll sees the skips and can emit the appropriate
    // events.
    const after = advanceOnTimeout(prev, room);
    let cur = after.state;
    const now = Date.now();

    if (isHumanSender(room, message.name, message.client)) {
      // Humans (web client or the host) are never turn-gated. If a new
      // turn should start, kick one off — sequential and moderator
      // modes each have their own initial-state shape.
      if (shouldStartNewTurn(cur, room)) {
        if (mode === 'sequential') {
          cur = newSequentialTurn(room, message.id);
        } else if (mode === 'moderator') {
          cur = newModeratorTurn(room, message.id);
          // Moderator mode requires a configured Moderator who is
          // currently present in the room. If we couldn't pick one,
          // newModeratorTurn returns null — the human message stands
          // alone and no agent is expected to reply. (The room remains
          // in moderator mode; sweepTimeouts will eventually auto-
          // fallback to open if this stays broken.)
        }
      }
      decision.roleAtSend = 'human';
      decision.invocationType = 'normal_turn';
      decision.turnId = cur?.turnId;
      return cur;
    }

    // cc agent (not the host) — must be the current speaker, or the
    // grace-eligible queue-head supplement, or in the host-directed
    // allowlist.
    if (cur && canAgentSpeakNow(cur, message.name, message.client, now)) {
      const isGrace = isGraceSupplementSpeaker(cur, message.name, message.client, now);
      const role: RoleInTurn = isGrace ? 'supplement' : cur.currentRole!;
      const turnId = cur.turnId;
      // room_status heartbeat: a status ping is posted as a status-tagged
      // message and never advances the turn. When the sender is the actual
      // current speaker in sequential mode, it also renews their deadline
      // (extendsTurn) — that is the "still working" heartbeat. A grace-
      // eligible queue-head supplement, or a moderator, just posts a side
      // note with no turn-state change.
      if (kind === 'status') {
        decision.roleAtSend = 'status';
        decision.invocationType = 'status_update';
        decision.turnId = turnId;
        if (!isGrace && cur.mode === 'sequential') {
          decision.extendsTurn = true;
          return renewTurnDeadline(cur, now);
        }
        return cur;
      }
      decision.roleAtSend = role;
      decision.invocationType = 'normal_turn';
      decision.turnId = turnId;
      // Supplement-skip token: advance with status='no_addition', do NOT
      // append a chat message. During lead grace we treat this as the
      // supplement bowing out (drop from queue, lead keeps the floor),
      // NOT as a preemption — opting out is a soft signal, not a claim
      // on the mic.
      if (isSupplementSkipToken) {
        decision.skipMessage = true;
        if (isGrace) {
          return skipQueueHead(cur, 'no_addition', now);
        }
        return advanceTurn(cur, 'no_addition', room, now);
      }
      // Moderator mode: Moderator-as-current keeps current after reply
      // (no queue pop). They route via room_direct_invoke; their
      // deadline resets each time they actually post a message.
      if (cur.mode === 'moderator' && role === 'moderator') {
        return moderatorReply(cur, room, now);
      }
      // Grace path: queue-head supplement preempts Lead. Log the Lead
      // as skipped_by_grace and surface that entry so the caller can
      // post a sys message.
      if (isGrace) {
        const result = applyGraceSupplementReply(
          cur, message.name, message.client, room, now,
        );
        decision.leadSkipped = result.leadSkipped;
        return result.state;
      }
      const closeOnResult = cur.mode === 'sequential'
        && (role === 'lead' || role === 'wrap')
        && /\[RESULT\]/i.test(text);
      return advanceTurn(cur, 'replied', room, now, closeOnResult ? { result: true } : undefined);
    }
    if (cur) {
      const directed = consumeHostDirectedDetailed(cur, message.name, message.client);
      if (directed.consumed) {
        // Moderator dispatch ('assignee') vs host override
        // ('host_directed') are tracked separately for reporting.
        decision.roleAtSend = directed.source === 'moderator' ? 'assignee' : 'host_directed';
        decision.invocationType = directed.source === 'moderator' ? 'moderator_assigned' : 'host_directed';
        decision.turnId = cur.turnId;
        // Directed messages don't consume the main turn queue slot —
        // the named current speaker stays current. The mutated
        // hostDirected list (one entry popped) is what gets persisted.
        return cur;
      }
    }
    // Moderator mode: a non-moderator cc agent that is neither the current
    // speaker nor a directly-invoked assignee may still post a *status
    // update* — a short "received / on it / done" signal back to the
    // Moderator. It is always allowed, never consumes the Moderator's
    // floor, and does NOT mutate turn state (queue / current / deadline
    // are untouched). Substantive analysis or challenge still requires a
    // Moderator @-invoke — that flows through the consumeHostDirected path
    // above. The message is appended normally, tagged roleAtSend='status'
    // / invocationType='status_update' so the UI and reports can render it
    // as a status ping rather than a turn reply.
    if (mode === 'moderator') {
      decision.roleAtSend = 'status';
      decision.invocationType = 'status_update';
      decision.turnId = cur?.turnId;
      // Return turn state unchanged — a status update is a side channel.
      return cur;
    }
    throw new NotYourTurnError(message.name, mode);
  });

  if (decision.skipMessage) {
    const metadata: MessageMetadata = {
      ...(message.metadata ?? {}),
      modeAtSend: mode,
      roleAtSend: decision.roleAtSend,
      invocationType: decision.invocationType,
      ...(decision.turnId !== undefined ? { turnId: decision.turnId } : {}),
    };
    return {
      appended: false,
      reason: 'no_addition',
      metadata,
      ...(decision.leadSkipped ? { leadSkipped: decision.leadSkipped } : {}),
    };
  }

  const metadata: MessageMetadata = {
    ...(message.metadata ?? {}),
    modeAtSend: mode,
    roleAtSend: decision.roleAtSend,
    invocationType: decision.invocationType,
    ...(decision.turnId !== undefined ? { turnId: decision.turnId } : {}),
    ...(decision.extendsTurn ? { extendsTurn: true } : {}),
  };
  const enriched: Message = { ...message, metadata };
  await rpushMessage(client, code, enriched, room.createdAt);
  return {
    appended: true,
    metadata,
    ...(decision.leadSkipped ? { leadSkipped: decision.leadSkipped } : {}),
  };
}

// Internal helper: write a message to the Redis list, pinning TTL to the
// room's hard 30-day deadline and keeping the absolute-count counter in lockstep.
// INCR on the count key MUST sit in the same pipeline as RPUSH so the count
// stays in lock-step with the list — listMessages relies on the invariant
// `totalCount - listLen = number of LTRIMmed entries` to compensate cursors.
// EXPIREAT (a fixed creation+TTL deadline) rather than EXPIRE means the
// message list dies exactly when the room does, instead of sliding forward.
async function rpushMessage(
  client: UpstashClient,
  code: string,
  message: Message,
  roomCreatedAt: number,
): Promise<void> {
  const expireAt = (Number.isFinite(roomCreatedAt) ? Math.floor(roomCreatedAt / 1000) : Math.floor(Date.now() / 1000)) + ROOM_TTL_SECONDS;
  // Older MCP clients (and raw API callers) can send a message with no
  // `text` — persisting it verbatim crashed every web viewer of the room
  // ("Cannot read properties of undefined (reading 'length')" in Bubble
  // rendering). Coerce to '' at the single write choke point.
  const safe = typeof message.text === 'string' ? message : { ...message, text: '' };
  await client.pipeline([
    ['RPUSH', msgsKey(code), JSON.stringify(safe)],
    ['INCR', msgCountKey(code)],
    ['LTRIM', msgsKey(code), -MAX_MESSAGES_PER_ROOM, -1],
    ['EXPIREAT', msgsKey(code), expireAt],
    ['EXPIREAT', msgCountKey(code), expireAt],
  ]);
}

// Append a server-originated system message. Bypasses the speaker/mute/turn
// gates because system messages are not sent by a participant — they are
// emitted by the server itself in response to events like mode changes,
// turn timeouts, host-driven skips, or moderator fallbacks. Callers should
// set `message.type = 'sys'` and use a synthetic sender (typically
// `name: 'system'`, `client: 'cc'`). The room must still exist; we hit
// getRoom() to refresh TTL and keep the count key aligned with the list.
export async function appendSystemMessage(
  client: UpstashClient,
  code: string,
  message: Message
): Promise<void> {
  const room = await getRoom(client, code); // throws RoomNotFoundError if the room is gone
  await rpushMessage(client, code, message, room.createdAt);
}

// Claim, append and acknowledge one task notification in the SAME script.
// A process dying between append and acknowledgement cannot duplicate it on
// the next read; an old assignment cannot notify a reviewer after a concurrent
// reassignment, and a notice from before a room reopen is never published.
// Returns 1 published, 0 stale/not applicable, 2 board version moved (retry).
export const TASK_NOTIFICATION_SCRIPT = `-- task-notification
local raw = redis.call('GET', KEYS[4])
if not raw then return 0 end
local board = cjson.decode(raw)
local task = nil
for _, candidate in ipairs(board.tasks) do
  if candidate.id == ARGV[4] then task = candidate break end
end
if not task or not task.notification or task.notification == cjson.null then return 0 end
local notice = task.notification
if notice.id ~= ARGV[5] or (notice.deliveredAt and notice.deliveredAt ~= cjson.null) then return 0 end
local waiting = task.waiting and task.waiting ~= cjson.null and (not task.waiting.resumedAt or task.waiting.resumedAt == cjson.null)
if notice.kind == 'review_requested' and (task.state ~= 'awaiting_review' or task.reviewStatus == 'waiting_for_capability' or task.verifier ~= notice.target or waiting) then return 0 end
if notice.kind == 'work_requested' and (task.owner ~= notice.target or (task.state ~= 'in_progress' and task.state ~= 'rejected') or waiting or (task.execution and task.execution ~= cjson.null and task.execution.decisionRequired == true)) then return 0 end
if notice.kind == 'waiting' and not waiting then return 0 end
if tostring(board.version) ~= ARGV[6] then return 2 end
local roomRaw = redis.call('GET', KEYS[1])
if not roomRaw then return 0 end
local room = cjson.decode(roomRaw)
if room.status ~= 'active' or tostring(room.reactivatedAt or room.createdAt) ~= ARGV[1] then return 0 end
redis.call('RPUSH', KEYS[2], ARGV[2])
redis.call('INCR', KEYS[3])
redis.call('LTRIM', KEYS[2], ARGV[3], -1)
redis.call('EXPIREAT', KEYS[2], tonumber(ARGV[8]))
redis.call('EXPIREAT', KEYS[3], tonumber(ARGV[8]))
-- Preserve empty JSON arrays: Lua cjson re-encoding would turn [] into {}.
-- The proposed board is serialized by JS and guarded by the board version.
redis.call('SET', KEYS[4], ARGV[7], 'KEEPTTL')
return 1`;

/** The transcript line a task notification is published as. */
export function taskNotificationText(task: TaskBoard['tasks'][number]): string {
  const notice = task.notification!;
  const action = notice.kind === 'review_requested'
    ? 'Independently inspect the submitted evidence, then room_task verify. If access is missing, use room_task wait with scope review.'
    : notice.kind === 'work_requested'
      ? task.execution?.recoveryRequired
        ? 'Execution needs recovery. Read attempt history/evidence and room_task recover with a resolution; lease expiry is not task failure.'
        : 'Resume the task and submit evidence when its done-when criteria pass.'
      : `Waiting: ${task.waiting?.reason ?? ''}. Resume when: ${task.waiting?.resumeWhen ?? ''}. Use room_task resume with a resolution after the condition is met.`;
  return `📋 @${notice.target}: ${task.id} "${task.title}" — ${action}`;
}

/**
 * Publish every pending responsibility notification on the board as a
 * targeted system message, exactly once each. Board state is the durable
 * source of responsibility: if publishing fails, the intent stays on the task
 * and the next board read or join retries it. `onPublished` (webhooks) is
 * best-effort and never undoes a publication.
 */
export async function publishTaskNotifications(client: UpstashClient, code: string,
  onPublished?: (message: Message, room: Room) => Promise<void>,
  snapshot?: TaskBoard,
): Promise<number> {
  const raw = snapshot ? null : await client.command<string | null>(['GET', `task-board:${code}`]);
  if (!snapshot && !raw) return 0;
  let board = snapshot ?? JSON.parse(raw!) as TaskBoard;
  const pending = board.tasks.filter(t => t.notification && t.notification.deliveredAt === undefined);
  if (!pending.length) return 0;
  const room = await getRoom(client, code);
  const expireAt = (Number.isFinite(room.createdAt) ? Math.floor(room.createdAt / 1000) : Math.floor(Date.now() / 1000)) + ROOM_TTL_SECONDS;
  let delivered = 0;
  for (const [index, task] of pending.entries()) {
    const notice = task.notification!;
    const message: Message = { id: notice.at + index, type: 'sys', name: 'system', client: 'cc',
      initials: '📋', color: '#6366F1', role: '', time: notice.at, text: taskNotificationText(task),
      metadata: { eventType: 'task_update', taskId: task.id, taskEventId: notice.id,
        taskVersion: board.version, targetAgentName: notice.target, ...(notice.targetClient ? { targetAgentClient: notice.targetClient } : {}) } };
    for (let attempt = 0; attempt < 6; attempt++) {
      const current = board.tasks.find(t => t.id === task.id)?.notification;
      if (!current || current.id !== notice.id || current.deliveredAt !== undefined) break;
      const publishedAt = Date.now();
      const next: TaskBoard = { ...board, version: board.version + 1, tasks: board.tasks.map(t => t.id === task.id
        ? recordTaskNotificationPublished({ ...t, notification: { ...current, deliveredAt: publishedAt } }, board.version + 1, publishedAt) : t) };
      const accepted = Number(await client.command<number>(['EVAL', TASK_NOTIFICATION_SCRIPT, 4,
        `room:${code}`, msgsKey(code), msgCountKey(code), `task-board:${code}`,
        String(sessionStartedAt(room)), JSON.stringify(message), -MAX_MESSAGES_PER_ROOM, task.id, notice.id,
        String(board.version), JSON.stringify(next), expireAt]));
      if (accepted === 2) {
        const latest = await client.command<string | null>(['GET', `task-board:${code}`]);
        if (!latest) break;
        board = JSON.parse(latest) as TaskBoard;
        continue;
      }
      if (accepted === 1) {
        board = next; delivered++;
        try { await onPublished?.(message, room); } catch { /* external transport is best-effort; the inbox remains durable */ }
      }
      break;
    }
  }
  return delivered;
}

// Cursor semantics: `fromIndex` is the absolute count of messages the caller
// has already consumed (0 on first call, advanced by `msgs.length` after
// each call). It is NOT a list-index — the on-disk list shifts whenever
// LTRIM trims the head, so a list-index cursor would skip messages past
// MAX_MESSAGES_PER_ROOM. The counter key + LLEN let us reconstruct where the
// caller's next unread message actually lives in the (possibly trimmed) list.
export async function listMessages(
  client: UpstashClient,
  code: string,
  fromIndex: number
): Promise<Message[]> {
  // One pipeline: ask for both the absolute count and the current list length.
  // count===null means this is a legacy room created before the counter was
  // introduced — fall back to treating fromIndex as a list-index (matches
  // pre-fix behavior; still buggy past 500 messages but no worse than before
  // and avoids breaking in-flight conversations during the rollout).
  const meta = await client.pipeline<unknown>([
    ['GET', msgCountKey(code)],
    ['LLEN', msgsKey(code)],
  ]);
  const countRaw = meta[0] as string | number | null;
  const listLen = Number(meta[1] ?? 0);
  if (listLen === 0) return [];

  let start: number;
  if (countRaw === null || countRaw === undefined) {
    start = fromIndex;
  } else {
    const totalCount = typeof countRaw === 'number' ? countRaw : parseInt(countRaw, 10);
    // `trimmed` is the number of head entries LTRIM has dropped over this
    // room's lifetime. Subtracting it from the agent's absolute cursor
    // gives the right list-index for the next unread message.
    const trimmed = totalCount - listLen;
    start = fromIndex - trimmed;
    // If the agent's cursor lags so far that messages it never saw have
    // already been LTRIMmed away, the best we can do is hand back the
    // surviving prefix from index 0 — those older messages are gone for
    // good (LTRIM is destructive; the report/minutes export is the only
    // way to recover full transcripts past the cap).
    if (start < 0) start = 0;
  }

  if (start >= listLen) return [];
  const raw = await client.command<string[]>(['LRANGE', msgsKey(code), start, -1]);
  return raw.map(line => {
    const m = JSON.parse(line) as Message;
    // Heal text-less messages already stored by older clients — without
    // this, one bad message bricks the room page for every viewer.
    if (typeof m.text !== 'string') m.text = '';
    return m;
  });
}

/**
 * Status-ping body posted after a task submit in turn-taking rooms. Kept here
 * (not at the call site) so every client emits the same recognisable prefix —
 * the room UI and the minutes digest both key off `[STATUS]`.
 */
export function buildTaskSubmitStatusText(taskId: string, evidenceSummary: string): string {
  const summary = evidenceSummary.trim().replace(/\s+/g, ' ').slice(0, 180);
  return `[STATUS] 待审核 / awaiting_review ${taskId}: ${summary || '(no run output)'}`;
}
