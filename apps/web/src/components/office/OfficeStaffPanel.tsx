// AI staff: the roster behind the floor plan.
//
// A staff entry is what makes an agent assignable: name it, say what it is for,
// tag the work it may take, cap its day. Everything here is editable because
// the alternative — agents appearing in rooms with names nobody chose — is how
// a roster stops matching reality.
import { useState } from 'react';
import type { OfficeAgent, OfficeAgentView } from '@agent-room/shared';
import { deleteAgent, pauseAgent, saveAgent } from '../../lib/officeApi.js';
import { Badge, Button, Card, Empty, ErrorNote, Field, Input, SectionTitle, TextArea, timeAgo, useOfficeAction } from './ui.js';
import { useI18n } from '../../i18n/index.js';
import { linkStateLabel, presenceLabel } from '../../i18n/labels.js';

interface Props {
  agents: OfficeAgentView[];
  onChanged: () => void;
}

const STATUS_TONE: Record<string, 'good' | 'warn' | 'bad' | 'info' | 'neutral'> = {
  working: 'info', reviewing: 'warn', idle: 'good', paused: 'neutral', offline: 'neutral',
};

const EMPTY_FORM = {
  id: '', name: '', role: '', tags: '', dailyTaskLimit: '20', requiresApproval: false, enabled: true, brief: '',
};

export function OfficeStaffPanel({ agents, onChanged }: Props) {
  const { t } = useI18n();
  const [form, setForm] = useState({ ...EMPTY_FORM });
  const [editing, setEditing] = useState(false);
  const { busy, error, setError, run } = useOfficeAction(onChanged);

  const startEdit = (agent: OfficeAgent) => {
    setForm({
      id: agent.id,
      name: agent.name,
      role: agent.role,
      tags: agent.tags.join(', '),
      dailyTaskLimit: String(agent.dailyTaskLimit),
      requiresApproval: agent.requiresApproval,
      enabled: agent.enabled,
      brief: agent.brief ?? '',
    });
    setEditing(true);
  };

  const submit = async () => {
    const ok = await run('save', () => saveAgent({
      ...(form.id ? { id: form.id } : {}),
      name: form.name.trim(),
      role: form.role.trim(),
      tags: form.tags.split(',').map(tag => tag.trim()).filter(Boolean),
      dailyTaskLimit: Number(form.dailyTaskLimit),
      requiresApproval: form.requiresApproval,
      enabled: form.enabled,
      brief: form.brief.trim() || undefined,
    }));
    if (ok) {
      setForm({ ...EMPTY_FORM });
      setEditing(false);
    }
  };

  return (
    <div className="grid gap-5 lg:grid-cols-[1.4fr_1fr]">
      <Card>
        <SectionTitle
          title={t('staff.title')}
          hint={t('staff.hint')}
        />
        <ErrorNote error={error} />
        {agents.length === 0 ? (
          <Empty>{t('staff.empty')}</Empty>
        ) : (
          <ul className="mt-3 divide-y divide-border-faint">
            {agents.map(agent => (
              <li key={agent.id} className="flex flex-wrap items-start justify-between gap-3 py-3">
                <div className="min-w-0">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="text-sm font-semibold text-ink">{agent.name}</span>
                    <Badge tone={STATUS_TONE[agent.presence.status] ?? 'neutral'}>{presenceLabel(agent.presence, agent.enabled)}</Badge>
                    {/* Presence only gives up at ten minutes; a seat that went
                        quiet mid-task is the case somebody has to act on before
                        then, so the link state sits beside it. */}
                    {agent.presence.link && ['grace', 'recovering'].includes(agent.presence.link.state) ? (
                      <Badge tone={agent.presence.link.state === 'recovering' ? 'bad' : 'warn'}>
                        {linkStateLabel(agent.presence.link.state)}
                      </Badge>
                    ) : null}
                    {agent.presence.link?.reconnects ? (
                      <Badge tone="neutral">{t('staff.link.reconnects', { count: agent.presence.link.reconnects })}</Badge>
                    ) : null}
                    {agent.requiresApproval ? <Badge tone="warn">{t('staff.badge.approval')}</Badge> : null}
                    {!agent.enabled ? <Badge tone="bad">{t('staff.badge.disabled')}</Badge> : null}
                  </div>
                  <p className="mt-0.5 text-xs text-ink-muted">{agent.role}</p>
                  <p className="mt-1 text-[11px] text-ink-faint">
                    {agent.tags.length ? t('staff.meta.tags', { tags: agent.tags.join(', ') }) : ''}
                    {t('staff.meta.today', { used: agent.tasksToday, limit: agent.dailyTaskLimit })}
                    {t('staff.meta.heartbeat', { time: timeAgo(agent.presence.heartbeatAgeMs !== undefined ? Date.now() - agent.presence.heartbeatAgeMs : agent.lastHeartbeatAt) })}
                    {agent.presence.link?.lastHealthyAt
                      ? t('staff.meta.link', { time: timeAgo(agent.presence.link.lastHealthyAt) })
                      : ''}
                    {agent.presence.roomCode ? t('staff.meta.room', { code: agent.presence.roomCode }) : ''}
                  </p>
                </div>
                <div className="flex shrink-0 items-center gap-1.5">
                  <Button variant="ghost" onClick={() => startEdit(agent)}>{t('staff.act.edit')}</Button>
                  <Button variant={agent.paused ? 'ghost' : 'quiet'} disabled={busy !== null}
                    onClick={() => void run(`pause-${agent.id}`, () => pauseAgent(agent.id, !agent.paused))}>
                    {agent.paused ? t('staff.act.resume') : t('staff.act.pause')}
                  </Button>
                  <Button variant="danger" disabled={busy !== null}
                    onClick={() => {
                      if (!window.confirm(t('staff.remove.confirm', { name: agent.name }))) return;
                      void run(`delete-${agent.id}`, () => deleteAgent(agent.id));
                    }}>
                    {t('staff.act.remove')}
                  </Button>
                </div>
              </li>
            ))}
          </ul>
        )}
      </Card>

      <Card>
        <SectionTitle
          title={editing ? t('staff.form.editTitle') : t('staff.form.addTitle')}
          hint={t('staff.form.hint')}
          action={editing ? <Button variant="ghost" onClick={() => { setEditing(false); setForm({ ...EMPTY_FORM }); }}>{t('common.cancel')}</Button> : undefined}
        />
        <form
          className="grid gap-3"
          onSubmit={event => { event.preventDefault(); void submit(); }}
        >
          <Field label={t('staff.form.name')} hint={t('staff.form.nameHint')}>
            <Input value={form.name} onChange={event => setForm({ ...form, name: event.target.value })} required maxLength={80} placeholder="Qwen" />
          </Field>
          <Field label={t('staff.form.role')}>
            <Input value={form.role} onChange={event => setForm({ ...form, role: event.target.value })} required maxLength={120} placeholder="한국어 카피라이터" />
          </Field>
          <Field label={t('staff.form.tags')} hint={t('staff.form.tagsHint')}>
            <Input value={form.tags} onChange={event => setForm({ ...form, tags: event.target.value })} placeholder="카피, 한국어, 인쇄" />
          </Field>
          <div className="grid grid-cols-2 gap-3">
            <Field label={t('staff.form.limit')} hint={t('staff.form.limitHint')}>
              <Input type="number" min={0} max={500} value={form.dailyTaskLimit}
                onChange={event => setForm({ ...form, dailyTaskLimit: event.target.value })} />
            </Field>
            <div className="grid gap-2 self-end pb-1">
              <label className="flex items-center gap-2 text-xs text-ink-muted">
                <input type="checkbox" checked={form.requiresApproval}
                  onChange={event => setForm({ ...form, requiresApproval: event.target.checked })} />
                {t('staff.form.needsApproval')}
              </label>
              <label className="flex items-center gap-2 text-xs text-ink-muted">
                <input type="checkbox" checked={form.enabled}
                  onChange={event => setForm({ ...form, enabled: event.target.checked })} />
                {t('staff.form.enabled')}
              </label>
            </div>
          </div>
          <Field label={t('staff.form.brief')} hint={t('staff.form.briefHint')}>
            <TextArea value={form.brief} onChange={event => setForm({ ...form, brief: event.target.value })} maxLength={4000} placeholder="한국어로 쓰고, 항상 원본 시트를 인용한다." />
          </Field>
          {error ? <p className="text-[11px] text-rose-600">{error}</p> : null}
          <div className="flex items-center gap-2">
            <Button type="submit" disabled={busy !== null}>{editing ? t('staff.form.save') : t('staff.form.add')}</Button>
            {editing ? <span className="text-[11px] text-ink-faint">{t('staff.form.editing', { name: form.name })}</span> : null}
          </div>
        </form>
        {error && !editing ? <button type="button" className="mt-2 text-[11px] text-ink-faint underline" onClick={() => setError(null)}>{t('common.dismiss')}</button> : null}
      </Card>
    </div>
  );
}
