// 3D 디오라마 — the office as the painting it was drawn as.
//
// The floor is a single isometric artwork (`public/office-diorama-bg.png`): a
// glass meeting wing, the boss's platform, five desks and a lounge. Each staff
// member is a name tag pinned onto the desk the artwork already gives them, with
// the critter of that seat, the state the server reported and — when the seat
// has one — the connection badge that says whether an outside client or 망고 is
// driving it. Nothing is animated: this view is the "is everyone all right?"
// picture, and the walking lives in the observation floor.
//
// The stage keeps the artwork's 3:2 and every tag is placed in percent of it, so
// a 390px phone and a 1280px desk show the same room, just larger. Tags are sized
// in CSS pixels (a 9px label stays 9px), which is why the seats were picked far
// enough apart that the six of them never touch on a phone.
import { useRef, useState } from 'react';
import type { OfficeAgentView } from '@agent-room/shared';
import { useI18n, type MessageKey } from '../../../i18n/index.js';
import { presenceLabel } from '../../../i18n/labels.js';
import { ConnectionBadge } from '../ConnectionBadge.js';
import { DioramaCritter } from './DioramaCritter.js';
import { placeAgents } from './dioramaSeats.js';

const TONE = {
  working: '#0ea5e9',
  reviewing: '#f59e0b',
  idle: '#10b981',
  paused: '#94a3b8',
  offline: '#64748b',
  disabled: '#94a3b8',
} as const;

type Tone = keyof typeof TONE;

const TONE_LABEL: Record<Tone, MessageKey> = {
  working: 'presence.working',
  reviewing: 'presence.reviewing',
  idle: 'presence.idle',
  paused: 'presence.paused',
  offline: 'presence.offline',
  disabled: 'presence.disabled',
};

/** The state the tag paints, in the same words the rest of the office uses. */
function toneOf(agent: OfficeAgentView): Tone {
  if (!agent.enabled) return 'disabled';
  const status = agent.presence.status;
  if (status === 'working' || status === 'reviewing' || status === 'idle' || status === 'paused' || status === 'offline') {
    return status;
  }
  return 'idle';
}

function agentStatus(agent: OfficeAgentView, unavailable: string) {
  return agent.presence.status === 'offline' && agent.presence.heartbeatAgeMs === undefined
    ? unavailable
    : presenceLabel(agent.presence, agent.enabled);
}

export function OfficeDiorama({ agents, generatedAt }: { agents: OfficeAgentView[]; generatedAt: number }) {
  const { t, lang } = useI18n();
  const [agentId, setAgentId] = useState<string>();
  const dialog = useRef<HTMLDialogElement>(null);
  const opener = useRef<HTMLButtonElement | null>(null);
  const agent = agents.find(row => row.id === agentId);
  const unavailable = t('diorama.unavailable');
  const formatter = new Intl.DateTimeFormat(lang === 'ko' ? 'ko-KR' : 'en-US', {
    dateStyle: 'short', timeStyle: 'short',
  });
  const heartbeat = agent?.presence.heartbeatAgeMs;
  const placed = placeAgents(agents);
  const seatOf = new Map(placed.map(row => [row.agent.id, row.seat]));
  // The pill above the artwork counts what the tags below it say, state by state,
  // and drops the states nobody is in: "작업 중 2 · 대기 3" instead of a fixed row
  // of zeroes that a phone has no room for.
  const counts: Array<[Tone, number]> = (['working', 'reviewing', 'idle', 'paused', 'offline', 'disabled'] as Tone[])
    .map(tone => [tone, agents.filter(row => toneOf(row) === tone).length] as [Tone, number])
    .filter(([, count]) => count > 0);
  const summary = counts.map(([tone, count]) => `${t(TONE_LABEL[tone])} ${count}`).join(' · ');

  if (agents.length === 0) return <p className="text-xs text-ink-soft">{t('diorama.empty')}</p>;

  return (
    <section>
      <div className="relative overflow-hidden rounded-2xl border border-border bg-[#efe4d2] shadow-card">
        <div className="relative aspect-[3/2] w-full">
          <picture className="absolute inset-0 block">
            <source srcSet="/office-diorama-bg.webp" type="image/webp" />
            <img
              src="/office-diorama-bg.png"
              alt={t('diorama.stageAlt')}
              draggable={false}
              className="h-full w-full select-none object-cover"
            />
          </picture>

          {/* Warm the corners so white tags read on the pale floor. */}
          <div aria-hidden="true" className="pointer-events-none absolute inset-0 bg-gradient-to-t from-black/25 via-transparent to-black/10" />

          {placed.map(({ agent: item, seat }) => {
            const tone = toneOf(item);
            const status = agentStatus(item, unavailable);
            const muted = tone === 'offline' || tone === 'disabled';
            return (
              <button
                key={item.id}
                type="button"
                aria-label={t('diorama.detailsButton', { name: item.name, status })}
                data-seat={seat.id}
                className="group absolute -translate-x-1/2 -translate-y-1/2 rounded-2xl p-0.5 outline-none transition focus-visible:ring-2 focus-visible:ring-white"
                style={{ left: `${seat.x}%`, top: `${seat.y}%` }}
                onClick={event => {
                  opener.current = event.currentTarget;
                  setAgentId(item.id);
                  dialog.current?.showModal();
                }}
              >
                <span className="flex flex-col items-center gap-0.5 sm:gap-1">
                  <span
                    className="relative block rounded-full bg-white transition group-hover:-translate-y-0.5"
                    style={{ boxShadow: `0 0 0 2px ${TONE[tone]}, 0 3px 10px rgba(15,23,42,0.30)` }}
                  >
                    <DioramaCritter
                      palette={seat.palette}
                      className={`h-6 w-6 rounded-full sm:h-9 sm:w-9 ${muted ? 'opacity-70 saturate-50' : ''}`}
                    />
                    {item.presence.connectionMode ? (
                      <span
                        aria-hidden="true"
                        className={`absolute -right-0.5 -top-0.5 h-2 w-2 rounded-full ring-2 ring-white sm:h-2.5 sm:w-2.5 ${
                          item.presence.connectionMode === 'external' ? 'bg-emerald-500' : 'bg-violet-500'
                        }`}
                      />
                    ) : null}
                  </span>

                  <span className="rounded-md bg-white/95 px-1 py-[1px] text-center shadow-sm ring-1 ring-black/5 sm:px-1.5 sm:py-0.5">
                    <span className="block max-w-[62px] truncate text-[10px] font-semibold leading-tight text-ink sm:max-w-[120px] sm:text-[11px]">
                      {item.name}
                    </span>
                    <span className="mt-[1px] flex items-center justify-center gap-1 text-[9px] leading-none text-ink-muted sm:text-[10px]">
                      <span aria-hidden="true" className="inline-block h-1 w-1 shrink-0 rounded-full" style={{ background: TONE[tone] }} />
                      <span className="whitespace-nowrap">{status}</span>
                    </span>
                    {item.presence.connectionMode ? (
                      <ConnectionBadge
                        mode={item.presence.connectionMode}
                        className="mt-0.5 hidden !gap-0.5 !px-1 !py-0 !text-[9px] leading-tight sm:inline-flex"
                      />
                    ) : null}
                  </span>
                </span>
              </button>
            );
          })}

          <p className="pointer-events-none absolute left-2 top-2 flex items-center gap-1.5 rounded-full bg-black/45 px-2 py-1 text-[9px] font-semibold leading-none text-white backdrop-blur-sm sm:left-3 sm:top-3 sm:text-[10px]">
            <span aria-hidden="true" className="relative flex h-1.5 w-1.5">
              <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-emerald-400 opacity-75" />
              <span className="relative inline-flex h-1.5 w-1.5 rounded-full bg-emerald-400" />
            </span>
            <span className="whitespace-nowrap">{summary}</span>
          </p>

          <p className="pointer-events-none absolute bottom-2 left-2 rounded-full bg-white/70 px-2 py-1 text-[9px] font-medium leading-none text-ink-muted backdrop-blur-sm sm:bottom-3 sm:left-3 sm:text-[10px]">
            {t('diorama.hint')}
          </p>
        </div>
      </div>

      {/* The tags carry the seat colour and the state ring; on a phone the only
          thing they cannot fit is the words for the connection dots, so the two
          colours are named once underneath the artwork. */}
      {agents.some(row => row.presence.connectionMode) ? (
        <div className="mt-1.5 flex flex-wrap items-center justify-center gap-x-3 gap-y-1 text-[10px] text-ink-soft sm:hidden">
          <span className="inline-flex items-center gap-1">
            <span aria-hidden="true" className="inline-block h-1.5 w-1.5 rounded-full bg-emerald-500" />
            {t('conn.external.full')}
          </span>
          <span className="inline-flex items-center gap-1">
            <span aria-hidden="true" className="inline-block h-1.5 w-1.5 rounded-full bg-violet-500" />
            {t('conn.delegated.full')}
          </span>
        </div>
      ) : null}

      <dialog
        ref={dialog}
        aria-labelledby="diorama-agent-heading"
        className="fixed inset-x-0 bottom-0 top-auto m-0 max-h-[86dvh] w-full max-w-full overflow-y-auto rounded-t-2xl bg-white p-5 text-ink shadow-2xl backdrop:bg-black/40 sm:inset-x-auto sm:inset-y-0 sm:right-0 sm:left-auto sm:h-dvh sm:max-h-none sm:w-full sm:max-w-md sm:rounded-none sm:rounded-l-2xl"
        onClose={() => { setAgentId(undefined); opener.current?.focus(); }}
      >
        <div aria-hidden="true" className="mx-auto mb-3 h-1 w-10 rounded-full bg-border sm:hidden" />
        <div className="flex items-start gap-3">
          {agent ? (
            <span className="mt-0.5 block rounded-full bg-white" style={{ boxShadow: `0 0 0 2px ${TONE[toneOf(agent)]}` }}>
              <DioramaCritter palette={seatOf.get(agent.id)?.palette ?? 'sand'} className="h-9 w-9" />
            </span>
          ) : null}
          <div className="min-w-0 flex-1">
            <h2 id="diorama-agent-heading" className="truncate text-lg font-semibold tracking-tight">
              {agent ? t('diorama.details', { name: agent.name }) : ''}
            </h2>
            {agent ? (
              <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
                <span
                  className="inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-semibold"
                  style={{ background: `${TONE[toneOf(agent)]}1a`, color: '#334155' }}
                >
                  <span aria-hidden="true" className="inline-block h-1.5 w-1.5 rounded-full" style={{ background: TONE[toneOf(agent)] }} />
                  {agentStatus(agent, unavailable)}
                </span>
                <ConnectionBadge mode={agent.presence.connectionMode} />
              </div>
            ) : null}
          </div>
          <button
            type="button"
            onClick={() => dialog.current?.close()}
            aria-label={t('diorama.close')}
            className="shrink-0 rounded-lg border border-border px-2.5 py-1 text-xs font-semibold text-ink-muted transition hover:text-ink"
          >
            ✕
          </button>
        </div>

        {agent ? (
          <dl className="mt-4 grid gap-2 text-xs">
            <div className="flex gap-2 rounded-lg bg-surface-sunken px-3 py-2">
              <dt className="w-16 shrink-0 font-semibold text-ink-soft">{t('diorama.roleLabel')}</dt>
              <dd className="min-w-0 text-ink">{agent.role || '—'}</dd>
            </div>
            <div className="flex gap-2 rounded-lg bg-surface-sunken px-3 py-2">
              <dt className="w-16 shrink-0 font-semibold text-ink-soft">{t('diorama.taskLabel')}</dt>
              <dd className="min-w-0 break-words text-ink">
                {agent.presence.taskId
                  ? (agent.presence.taskTitle || agent.presence.taskId)
                  : t('diorama.noTask')}
              </dd>
            </div>
            <div className="flex gap-2 rounded-lg bg-surface-sunken px-3 py-2">
              <dt className="w-16 shrink-0 font-semibold text-ink-soft">{t('diorama.quotaLabel')}</dt>
              <dd className="min-w-0 text-ink">{t('iso.staff.quota', {
                used: agent.tasksToday,
                limit: agent.dailyTaskLimit,
                remaining: agent.remainingToday,
              })}</dd>
            </div>
            {heartbeat !== undefined ? (
              <div className="flex gap-2 px-3 py-1">
                <dt className="w-16 shrink-0 font-semibold text-ink-soft">{t('diorama.updatedLabel')}</dt>
                <dd className="min-w-0 text-ink-muted">{formatter.format(generatedAt - heartbeat)}</dd>
              </div>
            ) : null}
          </dl>
        ) : null}

        {agent?.presence.taskId && agent.presence.roomCode ? (
          <a
            className="mt-4 inline-block rounded-lg bg-ink px-3 py-2 text-xs font-semibold text-white"
            href={`/r/${encodeURIComponent(agent.presence.roomCode)}`}
          >
            {t('diorama.openRoom')}
          </a>
        ) : null}
      </dialog>
    </section>
  );
}
