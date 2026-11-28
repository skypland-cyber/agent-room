// 팀 채팅방 — the meeting the diorama is a picture of, in words.
//
// The 3D view answers "is everyone all right?"; it cannot answer "what did they
// just decide?". So the same room is readable from the same screen: the live
// conversation, the minutes cut from it, who is answering right now, and a box
// the boss can type into without opening the room itself.
//
// Two tabs over one read: 대화 is the transcript, 회의록 is the same transcript
// folded into decisions / results / open items and the board. The minutes are
// requested only when that tab is opened — the dashboard pays per Redis command,
// and no one reads the minutes of a room they are not looking at.
import { useEffect, useRef, useState } from 'react';
import type { OfficeAgentView, OfficeChatMessage, OfficeRoomSummary, OfficeRoomDigest } from '@agent-room/shared';
import type { RoomChat } from '../../hooks/useRoomChat.js';
import { useI18n, type MessageKey } from '../../i18n/index.js';
import { presenceLabel, taskStateLabel } from '../../i18n/labels.js';

type Tab = 'chat' | 'minutes';

export interface TeamChatProps {
  chat: RoomChat;
  rooms: OfficeRoomSummary[];
  code?: string;
  onCode: (code: string) => void;
  agents: OfficeAgentView[];
  onClose: () => void;
  onOpenRoom?: (code: string) => void;
  /** Told when a line was posted, so the diorama can refresh its bubbles. */
  onSent?: () => void;
  className?: string;
}

function clock(at: number, lang: 'ko' | 'en'): string {
  return new Date(at).toLocaleTimeString(lang === 'ko' ? 'ko-KR' : 'en-GB', { hour: '2-digit', minute: '2-digit' });
}

/** The agents a room is waiting on right now, from their own heartbeats. */
function answering(agents: OfficeAgentView[], code?: string): OfficeAgentView[] {
  if (!code) return [];
  return agents.filter(agent => agent.enabled && agent.presence.roomCode === code
    && (agent.presence.status === 'working' || agent.presence.status === 'reviewing'));
}

function Row({ message, lang }: { message: OfficeChatMessage; lang: 'ko' | 'en' }) {
  const { t } = useI18n();
  if (message.type === 'sys') {
    return (
      <li className="px-1">
        <p className="rounded-lg bg-surface-sunken px-2 py-1.5 text-[10px] leading-relaxed text-ink-soft">
          <span className="mr-1 font-semibold text-ink-muted">{t('chat.system')}</span>
          {message.text}
        </p>
      </li>
    );
  }
  const mine = message.client === 'web';
  return (
    <li className="flex gap-2">
      <span
        aria-hidden="true"
        className="mt-0.5 grid h-6 w-6 shrink-0 place-items-center rounded-full text-[9px] font-bold text-white"
        style={{ background: message.color || '#64748b' }}
      >
        {message.initials || message.name.slice(0, 2).toUpperCase()}
      </span>
      <div className="min-w-0 flex-1">
        <p className="flex items-baseline gap-1.5">
          <span className="truncate text-[11px] font-semibold text-ink">{message.name}</span>
          {message.role ? <span className="shrink-0 text-[9px] text-ink-faint">{message.role}</span> : null}
          <span className="ml-auto shrink-0 text-[9px] tabular-nums text-ink-faint">{clock(message.time, lang)}</span>
        </p>
        <div className={`mt-0.5 rounded-xl px-2.5 py-1.5 text-[11px] leading-relaxed ${mine ? 'bg-accent-tint text-ink' : 'bg-surface-soft text-ink-muted'}`}>
          <p className="whitespace-pre-wrap break-words">{message.text}</p>
          {message.attachments?.length ? (
            <p className="mt-1 flex flex-wrap gap-1 text-[9px] text-ink-soft">
              {message.attachments.map(file => (
                <span key={file.id} className="rounded bg-white/70 px-1.5 py-0.5 ring-1 ring-black/5">📎 {file.name}</span>
              ))}
            </p>
          ) : null}
        </div>
      </div>
    </li>
  );
}

function Minutes({ digest, loading, lang }: { digest: OfficeRoomDigest | null; loading: boolean; lang: 'ko' | 'en' }) {
  const { t } = useI18n();
  if (!digest) return <p className="px-1 py-6 text-center text-[11px] text-ink-soft">{loading ? t('chat.minutes.loading') : t('chat.minutes.empty')}</p>;
  const sections: Array<{ key: MessageKey; rows: OfficeRoomDigest['decisions'] }> = [
    { key: 'chat.minutes.decisions', rows: digest.decisions },
    { key: 'chat.minutes.results', rows: digest.results },
    { key: 'chat.minutes.openItems', rows: digest.openItems },
  ];
  return (
    <div className="grid gap-3 px-0.5">
      <p className="rounded-lg bg-surface-sunken px-2.5 py-2 text-[11px] font-semibold text-ink-muted">
        {t('chat.minutes.summary', { messages: digest.messageCount, people: digest.participants.length })}
      </p>
      {digest.participants.length > 0 ? (
        <p className="text-[10px] leading-relaxed text-ink-soft">
          <span className="font-semibold text-ink-muted">{t('chat.minutes.participants')}</span> {digest.participants.join(' · ')}
        </p>
      ) : null}
      {sections.filter(section => section.rows.length > 0).map(section => (
        <section key={section.key}>
          <h3 className="text-[10px] font-bold uppercase tracking-wide text-ink-faint">{t(section.key)}</h3>
          <ul className="mt-1 grid gap-1">
            {section.rows.map(item => (
              <li key={`${section.key}-${item.at}-${item.name}`} className="rounded-lg border border-border-faint bg-white px-2 py-1.5 text-[11px] leading-relaxed text-ink-muted">
                <span className="mr-1 font-semibold text-ink">{item.name}</span>
                {item.text}
                <span className="ml-1 text-[9px] text-ink-faint">{clock(item.at, lang)}</span>
              </li>
            ))}
          </ul>
        </section>
      ))}
      <section>
        <h3 className="text-[10px] font-bold uppercase tracking-wide text-ink-faint">
          {t('chat.minutes.board', { done: digest.board.done, total: digest.board.total })}
        </h3>
        {digest.tasks.length === 0 ? (
          <p className="mt-1 text-[10px] text-ink-soft">{t('chat.minutes.boardEmpty')}</p>
        ) : (
          <ul className="mt-1 grid gap-0.5">
            {digest.tasks.map(task => (
              <li key={task.id} className="flex items-baseline gap-1.5 text-[10px] leading-relaxed">
                <span className="shrink-0 font-mono text-[9px] text-ink-faint">{task.id}</span>
                <span className="min-w-0 flex-1 truncate text-ink-muted">{task.title}</span>
                {task.owner ? <span className="shrink-0 text-ink-soft">{task.owner}</span> : null}
                <span className={`shrink-0 rounded px-1 text-[9px] font-semibold ${
                  task.state === 'done' ? 'bg-emerald-50 text-emerald-700'
                    : task.state === 'pending_approval' ? 'bg-amber-50 text-amber-800'
                      : 'bg-surface-sunken text-ink-soft'
                }`}>{taskStateLabel(task.state)}</span>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}

export function TeamChat({ chat, rooms, code, onCode, agents, onClose, onOpenRoom, onSent, className = '' }: TeamChatProps) {
  const { t, lang } = useI18n();
  const [tab, setTab] = useState<Tab>('chat');
  const [draft, setDraft] = useState('');
  const stream = useRef<HTMLDivElement>(null);
  const stuck = useRef(true);

  const { room, messages, digest, loading, error, sending, sendError, send, loadDigest, refresh } = chat;

  // The minutes are read when the tab is opened, and re-read whenever the tab is
  // opened again: the room kept talking while the reader was on the other tab.
  useEffect(() => {
    if (tab === 'minutes') loadDigest();
  }, [tab, loadDigest]);

  // Follow the conversation while the reader is at the bottom; leave the scroll
  // alone once they have scrolled up to read something.
  useEffect(() => {
    const element = stream.current;
    if (!element || !stuck.current) return;
    element.scrollTop = element.scrollHeight;
  }, [messages, tab]);

  const waiting = answering(agents, code);
  const ended = room?.status !== 'active';
  const activeRooms = rooms.filter(row => row.status === 'active');

  const submit = async () => {
    const text = draft.trim();
    if (!text) return;
    const ok = await send(text);
    if (ok) { setDraft(''); onSent?.(); }
  };

  return (
    <section
      aria-label={t('chat.title')}
      className={`flex min-h-0 flex-col overflow-hidden rounded-2xl border border-border bg-white/95 shadow-xl backdrop-blur ${className}`}
    >
      <header className="flex items-center gap-2 border-b border-border-faint px-3 py-2">
        <span aria-hidden="true" className="text-sm">💬</span>
        <h2 className="shrink-0 text-xs font-semibold tracking-tight text-ink">{t('chat.title')}</h2>
        {activeRooms.length > 0 ? (
          <select
            aria-label={t('chat.roomLabel')}
            value={code ?? ''}
            onChange={event => onCode(event.target.value)}
            className="min-w-0 flex-1 truncate rounded-lg border border-border bg-white px-1.5 py-1 text-[10px] font-semibold text-ink-muted"
          >
            {activeRooms.map(row => (
              <option key={row.code} value={row.code}>{row.code} · {row.topic}</option>
            ))}
          </select>
        ) : (
          <span className="min-w-0 flex-1 truncate text-[10px] text-ink-faint">{t('chat.noRoom')}</span>
        )}
        <button
          type="button"
          onClick={onClose}
          aria-label={t('chat.close')}
          title={t('chat.close')}
          className="shrink-0 rounded-full border border-border px-2 py-1 text-[10px] font-semibold text-ink-muted transition hover:text-ink"
        >
          {t('chat.close')}
        </button>
      </header>

      <div className="flex items-center gap-1 border-b border-border-faint px-2 py-1.5">
        {(['chat', 'minutes'] as Tab[]).map(item => (
          <button
            key={item}
            type="button"
            onClick={() => setTab(item)}
            aria-pressed={tab === item}
            className={`rounded-full px-2.5 py-1 text-[10px] font-semibold transition ${
              tab === item ? 'bg-ink text-white' : 'bg-surface-sunken text-ink-muted hover:text-ink'
            }`}
          >
            {t(item === 'chat' ? 'chat.tab.chat' : 'chat.tab.minutes')}
          </button>
        ))}
        <button
          type="button"
          onClick={refresh}
          title={t('common.refresh')}
          aria-label={t('common.refresh')}
          className="ml-auto rounded-full px-2 py-1 text-[10px] text-ink-faint transition hover:text-ink"
        >
          ↻
        </button>
        {onOpenRoom && room ? (
          <button
            type="button"
            onClick={() => onOpenRoom(room.code)}
            className="rounded-full px-2 py-1 text-[10px] font-semibold text-accent-deep transition hover:underline"
          >
            {t('chat.openRoom')}
          </button>
        ) : null}
      </div>

      <div
        ref={stream}
        onScroll={event => {
          const element = event.currentTarget;
          stuck.current = element.scrollHeight - element.scrollTop - element.clientHeight < 24;
        }}
        className="min-h-0 flex-1 overflow-y-auto overflow-x-hidden px-2 py-2"
      >
        {loading && messages.length === 0 ? (
          <p className="py-6 text-center text-[11px] text-ink-soft">{t('chat.loading')}</p>
        ) : error && messages.length === 0 ? (
          <p role="alert" className="rounded-lg border border-rose-200 bg-rose-50 px-2 py-1.5 text-[10px] text-rose-700">{error}</p>
        ) : tab === 'minutes' ? (
          <Minutes digest={digest} loading={loading} lang={lang} />
        ) : messages.length === 0 ? (
          <p className="py-6 text-center text-[11px] leading-relaxed text-ink-soft">{room ? t('chat.empty') : t('chat.noRoom')}</p>
        ) : (
          <ul className="grid gap-2">
            {messages.map(message => (
              <Row key={message.id} message={message} lang={lang} />
            ))}
          </ul>
        )}
      </div>

      {waiting.length > 0 ? (
        <p className="flex items-center gap-1.5 border-t border-border-faint px-3 py-1.5 text-[10px] font-semibold text-sky-700">
          <span aria-hidden="true" className="inline-block h-1.5 w-1.5 animate-pulse rounded-full bg-sky-500" />
          <span className="truncate">
            {waiting.length === 1
              ? t('chat.typing', { name: waiting[0]!.name })
              : t('chat.typingMore', { name: waiting[0]!.name, count: waiting.length - 1 })}
          </span>
          <span className="ml-auto shrink-0 text-[9px] font-normal text-ink-faint">
            {presenceLabel(waiting[0]!.presence, waiting[0]!.enabled)}
          </span>
        </p>
      ) : null}

      <form
        className="border-t border-border-faint p-2"
        onSubmit={event => { event.preventDefault(); void submit(); }}
      >
        {sendError ? <p role="alert" className="mb-1 rounded-lg bg-rose-50 px-2 py-1 text-[10px] text-rose-700">{sendError}</p> : null}
        {ended ? (
          <p className="px-1 py-1.5 text-center text-[10px] text-ink-soft">{t('chat.ended')}</p>
        ) : (
          <div className="flex items-end gap-1.5">
            <input
              value={draft}
              onChange={event => setDraft(event.target.value)}
              placeholder={t('chat.placeholder')}
              aria-label={t('chat.placeholder')}
              maxLength={4000}
              disabled={!room || sending}
              className="min-w-0 flex-1 rounded-xl border border-border bg-white px-2.5 py-2 text-[11px] text-ink outline-none placeholder:text-ink-faint focus:border-ink/40 disabled:bg-surface-sunken"
            />
            <button
              type="submit"
              disabled={!draft.trim() || !room || sending}
              className="shrink-0 rounded-xl bg-ink px-3 py-2 text-[11px] font-semibold text-white transition hover:bg-ink/90 disabled:opacity-40"
            >
              {sending ? t('chat.sending') : t('chat.send')}
            </button>
          </div>
        )}
      </form>
    </section>
  );
}
