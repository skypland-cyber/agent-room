// Recurring work: a template is a meeting that has not happened yet. One press
// opens the room, seats the staff it assigns, creates the tasks (some of them
// behind your approval), and leaves a join link to hand the agents.
import { useState } from 'react';
import type { OfficeTemplate } from '@agent-room/shared';
import { applyTemplate, deleteTemplate, saveTemplate } from '../../lib/officeApi.js';
import { formatTaskLines, parseTaskLines } from '../../lib/templateLines.js';
import { Badge, Button, Card, Empty, ErrorNote, Field, Input, SectionTitle, TextArea, useOfficeAction } from './ui.js';
import { useI18n } from '../../i18n/index.js';

interface Props {
  templates: OfficeTemplate[];
  onChanged: () => void;
}

interface Draft {
  id?: string;
  name: string;
  description: string;
  topic: string;
  guidelines: string;
  /** One task per line: Title | tag | owner | approval */
  lines: string;
}

const EMPTY: Draft = { name: '', description: '', topic: '', guidelines: '', lines: '초안 작성 | 카피' };

export function OfficeAutomationPanel({ templates, onChanged }: Props) {
  const { t } = useI18n();
  const [draft, setDraft] = useState<Draft>({ ...EMPTY });
  const [applied, setApplied] = useState<{ roomCode: string; joinUrl: string; skipped: string[]; seated: string[] } | null>(null);
  const { busy, error, run } = useOfficeAction(onChanged);

  const edit = (template: OfficeTemplate) => {
    setDraft({
      id: template.id,
      name: template.name,
      description: template.description,
      topic: template.topic,
      guidelines: template.guidelines ?? '',
      lines: formatTaskLines(template.tasks),
    });
    setApplied(null);
  };

  const submit = async () => {
    const tasks = parseTaskLines(draft.lines);
    if (!draft.name.trim() || tasks.length === 0) return;
    const ok = await run('save', () => saveTemplate({
      ...(draft.id ? { id: draft.id } : {}),
      name: draft.name.trim(),
      description: draft.description.trim(),
      topic: draft.topic.trim() || draft.name.trim(),
      guidelines: draft.guidelines.trim() || undefined,
      tasks,
    }));
    if (ok) setDraft({ ...EMPTY });
  };

  return (
    <div className="grid gap-5 lg:grid-cols-[1fr_1.1fr]">
      <Card>
        <SectionTitle title={t('recurring.title')} hint={t('recurring.hint')} />
        <ErrorNote error={error} />
        {templates.length === 0 ? <Empty>{t('recurring.empty')}</Empty> : (
          <ul className="grid gap-2">
            {templates.map(template => (
              <li key={template.id} className="rounded-xl border border-border-faint bg-white p-3">
                <div className="flex items-start justify-between gap-2">
                  <div className="min-w-0">
                    <p className="text-xs font-semibold text-ink">{template.name}</p>
                    <p className="mt-0.5 text-[11px] text-ink-soft">{template.description || template.topic}</p>
                    <p className="mt-1 text-[10px] text-ink-faint">
                      {t('recurring.meta', { tasks: template.tasks.length, approvals: template.tasks.filter(task => task.requiresApproval).length })}
                    </p>
                  </div>
                  <div className="flex shrink-0 flex-wrap justify-end gap-1">
                    <Button variant="ghost" onClick={() => edit(template)}>{t('recurring.act.edit')}</Button>
                    <Button disabled={busy !== null}
                      onClick={() => void run(`apply-${template.id}`, async () => {
                        const result = await applyTemplate(template.id);
                        setApplied(result);
                      })}>
                      {t('recurring.act.run')}
                    </Button>
                    <Button variant="danger" disabled={busy !== null}
                      onClick={() => {
                        if (!window.confirm(t('recurring.delete.confirm', { name: template.name }))) return;
                        void run(`delete-${template.id}`, () => deleteTemplate(template.id));
                      }}>×</Button>
                  </div>
                </div>
              </li>
            ))}
          </ul>
        )}

        {applied ? (
          <div className="mt-4 rounded-xl border border-emerald-200 bg-emerald-50 p-3">
            <p className="text-xs font-semibold text-emerald-800">{t('recurring.applied.title', { code: applied.roomCode })}</p>
            <p className="mt-1 text-[11px] text-emerald-800/80">
              {applied.seated.length ? t('recurring.applied.seated', { names: applied.seated.join(', ') }) : ''}
              {t('recurring.applied.handOff')}
            </p>
            <code className="mt-1 block break-all rounded bg-white px-2 py-1 font-mono text-[11px] text-ink">{applied.joinUrl}</code>
            {applied.skipped.length ? (
              <p className="mt-1 text-[11px] text-amber-800">{t('recurring.applied.skipped', { items: applied.skipped.join('; ') })}</p>
            ) : null}
            <div className="mt-2 flex gap-1.5">
              <a href={applied.joinUrl}><Button variant="ghost">{t('recurring.applied.join')}</Button></a>
              <a href={`/r/${applied.roomCode}`}><Button variant="quiet">{t('recurring.applied.room')}</Button></a>
            </div>
          </div>
        ) : null}
      </Card>

      <Card>
        <SectionTitle
          title={draft.id ? t('recurring.form.editTitle') : t('recurring.form.newTitle')}
          hint={t('recurring.form.hint')}
          action={draft.id ? <Button variant="ghost" onClick={() => setDraft({ ...EMPTY })}>{t('common.cancel')}</Button> : undefined}
        />
        <form className="grid gap-3" onSubmit={event => { event.preventDefault(); void submit(); }}>
          <Field label={t('recurring.form.name')}><Input value={draft.name} onChange={event => setDraft({ ...draft, name: event.target.value })} required maxLength={80} placeholder={t('recurring.form.namePlaceholder')} /></Field>
          <Field label={t('recurring.form.description')}><Input value={draft.description} onChange={event => setDraft({ ...draft, description: event.target.value })} maxLength={1000} placeholder={t('recurring.form.descriptionPlaceholder')} /></Field>
          <Field label={t('recurring.form.topic')} hint={t('recurring.form.topicHint')}><Input value={draft.topic} onChange={event => setDraft({ ...draft, topic: event.target.value })} maxLength={300} placeholder={t('recurring.form.topicPlaceholder')} /></Field>
          <Field label={t('recurring.form.tasks')} hint={t('recurring.form.tasksHint')}>
            <TextArea value={draft.lines} onChange={event => setDraft({ ...draft, lines: event.target.value })} className="min-h-[120px] font-mono !text-[11px]" />
          </Field>
          <Field label={t('recurring.form.guidelines')} hint={t('recurring.form.guidelinesHint')}>
            <TextArea value={draft.guidelines} onChange={event => setDraft({ ...draft, guidelines: event.target.value })} maxLength={6000} />
          </Field>
          <div className="flex items-center gap-2">
            <Button type="submit" disabled={busy !== null}>{draft.id ? t('recurring.form.save') : t('recurring.form.create')}</Button>
            <Badge tone="info">{t('recurring.form.count', { count: parseTaskLines(draft.lines).length })}</Badge>
          </div>
        </form>
      </Card>
    </div>
  );
}
