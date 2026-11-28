// The office's team chat: one room's conversation, kept as fresh as the free
// tier can afford, and the boss's own line into it.
//
// The panel polls faster than any other office screen (an agent answering is
// only worth watching while it answers), so the poll is the cheap shape the API
// offers: the cursor it already holds, and nothing else. The board and the live
// minutes are only read when the 회의록 tab is opened.
//
// One hook feeds both readers of the same conversation — the chat panel and the
// speech bubbles over the staff in the diorama — so the picture and the panel
// can never show two different moments of the room.
import { useCallback, useEffect, useRef, useState } from 'react';
import type { OfficeChatMessage, OfficeChatRoom, OfficeRoomDigest } from '@agent-room/shared';
import { roomChat, sayToRoom } from '../lib/officeApi.js';

/** How often an open panel re-reads the room. */
export const CHAT_POLL_MS = 8_000;
/** How many lines the panel keeps: enough to scroll back through a meeting. */
export const CHAT_KEEP = 120;

export interface RoomChat {
  room: OfficeChatRoom | null;
  messages: OfficeChatMessage[];
  digest: OfficeRoomDigest | null;
  loading: boolean;
  error: string | null;
  sending: boolean;
  sendError: string | null;
  send: (text: string) => Promise<boolean>;
  refresh: () => void;
  loadDigest: () => void;
}

function mergeMessages(current: OfficeChatMessage[], incoming: OfficeChatMessage[], replace: boolean): OfficeChatMessage[] {
  if (replace) return incoming.slice(-CHAT_KEEP);
  const seen = new Set(current.map(message => message.id));
  const fresh = incoming.filter(message => !seen.has(message.id));
  return fresh.length === 0 ? current : [...current, ...fresh].slice(-CHAT_KEEP);
}

export function useRoomChat(code: string | undefined, options: { active?: boolean; pollMs?: number } = {}): RoomChat {
  const active = options.active !== false && Boolean(code);
  const pollMs = options.pollMs ?? CHAT_POLL_MS;
  const [room, setRoom] = useState<OfficeChatRoom | null>(null);
  const [messages, setMessages] = useState<OfficeChatMessage[]>([]);
  const [digest, setDigest] = useState<OfficeRoomDigest | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [sending, setSending] = useState(false);
  const [sendError, setSendError] = useState<string | null>(null);

  // The cursor is the server's absolute message count. It is a ref because the
  // interval reads it every eight seconds and must never be a render behind.
  const cursor = useRef<number | null>(null);
  const inFlight = useRef(false);

  const pull = useCallback(async (options: { digest?: boolean; reset?: boolean } = {}) => {
    if (!code) return;
    if (inFlight.current) return;
    inFlight.current = true;
    try {
      const since = options.reset ? undefined : cursor.current ?? undefined;
      const payload = await roomChat(code, {
        ...(since !== undefined ? { since } : {}),
        ...(options.digest ? { digest: true } : {}),
      });
      cursor.current = payload.total;
      setRoom(payload.room);
      setMessages(current => mergeMessages(current, payload.messages, Boolean(payload.reset) || options.reset === true));
      if (payload.digest) setDigest(payload.digest);
      setError(null);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      inFlight.current = false;
    }
  }, [code]);

  // A different room is a different conversation: drop the old one before the
  // first read, so the panel never shows one room's lines under another's name.
  useEffect(() => {
    cursor.current = null;
    setRoom(null);
    setMessages([]);
    setDigest(null);
    setError(null);
    setSendError(null);
    if (!code) return undefined;
    let alive = true;
    setLoading(true);
    void pull({ reset: true }).finally(() => { if (alive) setLoading(false); });
    return () => { alive = false; };
  }, [code, pull]);

  // Polling slows with the panel closed (and stops with the tab in the
  // background): the office pays per Redis command, and a closed panel is nobody
  // watching — but the bubbles over the staff still want to be current.
  useEffect(() => {
    if (!active || !code) return undefined;
    const id = window.setInterval(() => {
      if (typeof document !== 'undefined' && document.visibilityState !== 'visible') return;
      void pull();
    }, pollMs);
    const onVisible = () => {
      if (typeof document !== 'undefined' && document.visibilityState === 'visible') void pull();
    };
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      window.clearInterval(id);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [active, code, pollMs, pull]);

  const refresh = useCallback(() => { void pull(); }, [pull]);
  const loadDigest = useCallback(() => {
    void pull({ digest: true, reset: true });
  }, [pull]);

  const send = useCallback(async (text: string) => {
    const trimmed = text.trim();
    if (!code || !trimmed || sending) return false;
    setSending(true);
    setSendError(null);
    try {
      const result = await sayToRoom(code, trimmed);
      setMessages(current => mergeMessages(current, [result.message], false));
      if (typeof result.total === 'number') cursor.current = result.total;
      else cursor.current = (cursor.current ?? 0) + 1;
      return true;
    } catch (cause) {
      setSendError(cause instanceof Error ? cause.message : String(cause));
      return false;
    } finally {
      setSending(false);
    }
  }, [code, sending]);

  return { room, messages, digest, loading, error, sending, sendError, send, refresh, loadDigest };
}
