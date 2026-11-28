import { useRef, useState } from 'react';
import type { OfficeAgentView } from '@agent-room/shared';
import { useI18n } from '../../../i18n/index.js';
import { presenceLabel } from '../../../i18n/labels.js';

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

  return (
    <section>
      {agents.length === 0 ? <p>{t('diorama.empty')}</p> : (
        <ul className="grid grid-cols-1 gap-3 rounded-xl border border-border bg-surface-soft p-3 sm:grid-cols-2 lg:grid-cols-3">
          {agents.map(item => {
            const status = agentStatus(item, unavailable);
            return (
              <li key={item.id} className="relative min-w-0 rounded-lg border border-border bg-white p-3">
                <button type="button"
                  className="relative z-10 block max-w-full rounded-lg border border-border bg-white px-2 py-1 text-left focus-visible:ring-2 focus-visible:ring-sky-500"
                  aria-label={t('diorama.detailsButton', { name: item.name, status })}
                  onClick={event => {
                    opener.current = event.currentTarget;
                    setAgentId(item.id);
                    dialog.current?.showModal();
                  }}>
                  <strong className="block truncate">{item.name}</strong>
                  <span className="text-xs text-ink-soft">{status}</span>
                </button>
                <div aria-hidden="true" className="relative mx-auto h-20 w-32 [perspective:250px]">
                  <div className="absolute inset-x-1 top-4 h-16 rounded-lg border border-sky-700 bg-sky-100 [transform:rotateX(53deg)_rotateZ(-23deg)] [box-shadow:0_9px_0_#21627b,0_15px_10px_#21536b55]">
                    <div className="absolute left-5 top-3 h-4 w-8 rounded-sm bg-slate-800 [box-shadow:0_4px_0_#0f172a]" />
                    <div className="absolute right-6 top-6 h-4 w-4 rounded-full bg-amber-400 [box-shadow:0_4px_0_#a16207]" />
                  </div>
                </div>
              </li>
            );
          })}
        </ul>
      )}
      <dialog ref={dialog} aria-labelledby="diorama-agent-heading"
        className="fixed inset-y-0 left-auto right-0 m-0 h-dvh max-h-none w-full max-w-md overflow-auto rounded-l-xl bg-white p-5 text-ink shadow-xl backdrop:bg-black/40"
        onClose={() => { setAgentId(undefined); opener.current?.focus(); }}>
        <div className="flex items-start justify-between gap-3">
          <h2 id="diorama-agent-heading" className="text-lg font-semibold">
            {agent ? t('diorama.details', { name: agent.name }) : ''}
          </h2>
          <button type="button" className="rounded border border-border px-3 py-1" onClick={() => dialog.current?.close()}>{t('diorama.close')}</button>
        </div>
        {agent ? (
          <div className="mt-4 space-y-2">
            <p>{t('diorama.role', { role: agent.role })}</p>
            <p>{agentStatus(agent, unavailable)}</p>
            {agent.presence.taskId ? (
              <p>{t('diorama.task', { taskTitle: agent.presence.taskTitle || agent.presence.taskId })}</p>
            ) : agent.presence.status === 'idle' ? <p>{t('diorama.noTask')}</p> : null}
            {heartbeat !== undefined ? <p>{t('diorama.updated', { updatedAt: formatter.format(generatedAt - heartbeat) })}</p> : null}
            {agent.presence.taskId && agent.presence.roomCode ? (
              <a className="inline-block underline" href={`/r/${encodeURIComponent(agent.presence.roomCode)}`}>{t('diorama.openRoom')}</a>
            ) : null}
          </div>
        ) : null}
      </dialog>
    </section>
  );
}
