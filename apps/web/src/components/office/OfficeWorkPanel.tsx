// Work: the boss's queue. What waits for a decision, what is running, what
// failed, and what QA still owes — with the two or three buttons that actually
// change the board, and a plain reason box because a decision without a reason
// is one nobody can audit later.
import { useState } from 'react';
import type { OfficeOverview, OfficeTaskRef } from '@agent-room/shared';
import { abortTask, approveTask, archiveRoomNow, deleteRoom, endRoom, handoffRoom, pauseTask, rejectTask, requestApproval, resumeTask, retryTask } from '../../lib/officeApi.js';
import { Badge, Button, Card, Empty, ErrorNote, Input, SectionTitle, formatDate, useOfficeAction } from './ui.js';
import { useI18n } from '../../i18n/index.js';
import { qaStatusLabel, roomStatusLabel, taskStateLabel } from '../../i18n/labels.js';

interface Props {
  overview: OfficeOverview;
  onChanged: () => void;
}

const STATE_TONE: Record<string, 'neutral' | 'good' | 'warn' | 'bad' | 'info'> = {
  todo: 'neutral',
  pending_approval: 'warn',
  in_progress: 'info',
  paused: 'neutral',
  awaiting_review: 'warn',
  blocked: 'bad',
  rejected: 'bad',
  done: 'good',
  cancelled: 'neutral',
  aborted: 'neutral',
};

function TaskRow({ task, onChanged, run, busy }: {
  task: OfficeTaskRef;
  onChanged: () => void;
  run: (key: string, action: () => Promise<unknown>) => Promise<boolean>;
  busy: string | null;
}) {
  const { t } = useI18n();
  const [note, setNote] = useState('');
  const key = `${task.code}:${task.id}`;
  const runKey = (name: string) => `${name}-${key}`;
  return (
    <li className="grid gap-2 py-3 sm:grid-cols-[1fr_auto] sm:items-start">
      <div className="min-w-0">
        <div className="flex flex-wrap items-center gap-2">
          <span className="font-mono text-[11px] text-ink-faint">{task.id}</span>
          <span className="text-sm font-semibold text-ink">{task.title}</span>
          <Badge tone={STATE_TONE[task.state] ?? 'neutral'}>{taskStateLabel(task.state)}</Badge>
          {task.qaStatus ? <Badge tone={task.qaStatus === 'failed' ? 'bad' : task.qaStatus === 'passed' ? 'good' : 'warn'}>{t('work.row.qa', { status: qaStatusLabel(task.qaStatus) })}</Badge> : null}
          {task.retryCount ? <Badge tone="warn">{t('work.row.retry', { count: task.retryCount })}</Badge> : null}
        </div>
        <p className="mt-0.5 text-[11px] text-ink-soft">
          <a href={`/r/${task.code}`} className="font-mono hover:text-ink">{task.code}</a>
          {' · '}{task.roomTopic}
          {task.owner ? ` · ${t('work.row.owner', { name: task.owner })}` : ` · ${t('work.row.unassigned')}`}
          {task.verifier ? ` · ${t('work.row.verifier', { name: task.verifier })}` : ''}
          {' · '}{formatDate(task.updatedAt)}
        </p>
        {task.approvalNote ? <p className="mt-1 text-[11px] text-ink-muted">{t('work.row.note', { note: task.approvalNote })}</p> : null}
      </div>
      <div className="flex flex-wrap items-start gap-1.5">
        <Input
          value={note}
          onChange={event => setNote(event.target.value)}
          placeholder={t('work.row.reason')}
          className="!w-40 !py-1.5 !text-[11px]"
          aria-label={t('work.row.reasonAria', { id: task.id })}
        />
        {task.state === 'pending_approval' ? (
          <>
            <Button disabled={busy !== null} onClick={() => void run(runKey('approve'), () => approveTask(task.code, task.id, note || undefined))}>{t('work.act.approve')}</Button>
            <Button variant="danger" disabled={busy !== null} onClick={() => void run(runKey('reject'), () => rejectTask(task.code, task.id, note || undefined))}>{t('work.act.reject')}</Button>
          </>
        ) : null}
        {task.state === 'rejected' ? (
          <Button variant="ghost" disabled={busy !== null}
            onClick={() => void run(runKey('retry'), () => retryTask(task.code, task.id, { reason: note || undefined }))}>
            {t('work.act.retry')}
          </Button>
        ) : null}
        {task.state === 'paused' ? (
          <Button variant="ghost" disabled={busy !== null} onClick={() => void run(runKey('resume'), () => resumeTask(task.code, task.id))}>{t('work.act.resume')}</Button>
        ) : ['in_progress', 'todo', 'blocked'].includes(task.state) ? (
          <Button variant="quiet" disabled={busy !== null}
            onClick={() => void run(runKey('pause'), () => pauseTask(task.code, task.id, note || undefined))}>
            {t('work.act.pause')}
          </Button>
        ) : null}
        {!['done', 'cancelled', 'aborted', 'pending_approval'].includes(task.state) ? (
          <Button variant="danger" disabled={busy !== null}
            title={t('work.act.abortTitle')}
            onClick={() => {
              if (!window.confirm(t('work.act.abortConfirm', { id: task.id }))) return;
              void run(runKey('abort'), () => abortTask(task.code, task.id, note || undefined));
            }}>
            {t('work.act.abort')}
          </Button>
        ) : null}
        {task.state === 'todo' && !task.requiresApproval ? (
          <Button variant="quiet" disabled={busy !== null}
            onClick={() => void run(runKey('gate'), () => requestApproval(task.code, task.id, note || undefined))}>
            {t('work.act.hold')}
          </Button>
        ) : null}
        {busy === runKey('approve') || busy === runKey('reject') ? <span className="text-[11px] text-ink-faint">{t('work.act.saving')}</span> : null}
      </div>
    </li>
  );
}

export function OfficeWorkPanel({ overview, onChanged }: Props) {
  const { t } = useI18n();
  const [showAll, setShowAll] = useState(false);
  const [reviewer, setReviewer] = useState('');
  /** The last handoff's outcome, shown once under the rooms list. */
  const [handoff, setHandoff] = useState<{ ok: string; skipped: string[] } | null>(null);
  const { busy, error, run } = useOfficeAction(onChanged);
  const running = overview.openTasks.filter(task => task.state !== 'pending_approval');
  const visible = showAll ? running : running.slice(0, 12);
  const reviews = running.filter(task => task.state === 'awaiting_review');
  const reviewers = [...new Set(reviews.flatMap(task => task.verifier ? [task.verifier] : []))].sort();
  const filter = reviewers.includes(reviewer) ? reviewer : '';
  const reviewQueue = reviews.filter(task => !filter || task.verifier === filter)
    .sort((a, b) => (a.review?.requestedAt ?? a.updatedAt) - (b.review?.requestedAt ?? b.updatedAt));

  return (
    <div className="grid gap-5">
      <Card className="border-amber-200/70">
        <SectionTitle
          title={t('work.approvals.title', { count: overview.approvals.length })}
          hint={t('work.approvals.hint')}
        />
        <ErrorNote error={error} />
        {overview.approvals.length === 0 ? (
          <Empty>{t('work.approvals.empty')}</Empty>
        ) : (
          <ul className="divide-y divide-border-faint">
            {overview.approvals.map(task => <TaskRow key={`${task.code}-${task.id}`} task={task} onChanged={onChanged} run={run} busy={busy} />)}
          </ul>
        )}
      </Card>

      <Card>
        <SectionTitle title={t('work.review.title', { count: reviewQueue.length })} />
        {reviewers.length > 0 ? (
          <label className="flex items-center gap-2 text-sm">
            {t('work.review.verifier')}
            <select value={filter} onChange={event => setReviewer(event.target.value)} className="rounded border border-border bg-white px-2 py-1">
              <option value="">{t('work.review.all')}</option>
              {reviewers.map(name => <option key={name} value={name}>{name}</option>)}
            </select>
          </label>
        ) : null}
        {reviewQueue.length === 0 ? <Empty>{t('work.review.empty')}</Empty> : (
          <ul className="divide-y divide-border-faint">
            {reviewQueue.map(task => (
              <li key={task.code + ':' + task.id} className="py-3">
                <p className="font-semibold">{task.id} · {task.title}</p>
                <p className="text-sm">{task.verifier || t('work.review.unassigned')} · {formatDate(task.review?.requestedAt ?? task.updatedAt)}</p>
                {task.review ? (
                  <p className="text-sm">
                    {task.review.attempt !== undefined ? t('work.review.attempt', { count: task.review.attempt }) + ' · ' : ''}
                    {t('work.review.files', { count: task.review.deliverableCount })}
                  </p>
                ) : null}
                {task.review?.previousVerdict ? <p className="text-sm">{t('work.review.previous', { note: task.review.previousVerdict })}</p> : null}
                <a className="text-sm underline" href={`/r/${encodeURIComponent(task.code)}?taskFiles=${encodeURIComponent(task.id)}`}>{t('work.review.open')}</a>
              </li>
            ))}
          </ul>
        )}
      </Card>

      <div className="grid gap-5 lg:grid-cols-[1.4fr_1fr]">
        <Card>
          <SectionTitle
            title={t('work.open.title', { count: running.length })}
            hint={t('work.open.hint')}
            action={running.length > 12 ? (
              <Button variant="ghost" onClick={() => setShowAll(value => !value)}>{showAll ? t('work.open.showLess') : t('work.open.showAll')}</Button>
            ) : undefined}
          />
          {visible.length === 0 ? <Empty>{t('work.open.empty')}</Empty> : (
            <ul className="divide-y divide-border-faint">
              {visible.map(task => <TaskRow key={`${task.code}-${task.id}`} task={task} onChanged={onChanged} run={run} busy={busy} />)}
            </ul>
          )}
        </Card>

        <div className="grid gap-5">
          <Card>
            <SectionTitle title={t('work.qa.title', { count: overview.qaQueue.length })} hint={t('work.qa.hint')} />
            {overview.qaQueue.length === 0 ? <Empty>{t('work.qa.empty')}</Empty> : (
              <ul className="grid gap-2 text-xs">
                {overview.qaQueue.map(task => (
                  <li key={`${task.code}-${task.id}`} className="rounded-lg border border-border-faint bg-surface-soft px-3 py-2">
                    <span className="font-mono text-[11px] text-ink-faint">{task.id}</span> {task.title}
                  </li>
                ))}
              </ul>
            )}
          </Card>

          <Card>
            <SectionTitle title={t('work.rooms.title', { count: overview.rooms.length })} hint={t('work.rooms.hint')} />
            {overview.rooms.length === 0 ? <Empty>{t('work.rooms.empty')}</Empty> : (
              <ul className="grid gap-2">
                {overview.rooms.map(room => {
                  const live = room.status === 'active';
                  // A room lives 30 days and then its data is gone: the badge is
                  // the only place that says so before it happens.
                  const expiryTone = !live ? 'neutral' : room.daysLeft <= 1 ? 'bad' : room.daysLeft <= 3 ? 'warn' : 'neutral';
                  return (
                  <li key={room.code} className="rounded-xl border border-border-faint bg-white px-3 py-2">
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <a href={`/r/${room.code}`} className="min-w-0">
                        <span className="block truncate text-xs font-semibold text-ink">{room.topic}</span>
                        <span className="font-mono text-[10px] text-ink-faint">
                          {room.code} · {t('work.room.seated', { count: room.participants })} · {t('work.room.agents', { count: room.agents })}
                        </span>
                      </a>
                      <div className="flex flex-wrap items-center gap-1">
                        <Badge tone={live ? 'good' : 'neutral'}>{roomStatusLabel(room.status)}</Badge>
                        {live && room.autoCloseAt ? (
                          <span title={t('work.room.autoCloseTitle')}>
                            <Badge tone="info">
                              {t('work.room.autoCloseIn', { minutes: Math.max(1, Math.ceil((room.autoCloseAt - Date.now()) / 60_000)) })}
                            </Badge>
                          </span>
                        ) : null}
                        {!live && room.autoClosedAt ? (
                          <span title={t('work.room.autoClosedTitle')}>
                            <Badge tone="neutral">{t('work.room.autoClosed')}</Badge>
                          </span>
                        ) : null}
                        <Badge tone={expiryTone}>
                          {room.daysLeft > 0
                            ? t('work.room.dday', { days: room.daysLeft })
                            : t('work.room.expired')}
                        </Badge>
                        {room.successorRoomCode ? (
                          <a href={`/r/${room.successorRoomCode}`} title={t('work.room.handedOffTitle')}>
                            <Badge tone="info">{t('work.room.handedOff', { code: room.successorRoomCode })}</Badge>
                          </a>
                        ) : null}
                        {room.predecessorRoomCode ? (
                          <a href={`/r/${room.predecessorRoomCode}`} title={t('work.room.predecessorTitle')}>
                            <Badge tone="neutral">{t('work.room.predecessor', { code: room.predecessorRoomCode })}</Badge>
                          </a>
                        ) : null}
                        <Button variant="quiet" title={t('work.room.archiveTitle')}
                          disabled={busy !== null}
                          onClick={() => void run(`archive-${room.code}`, () => archiveRoomNow(room.code))}>
                          {t('work.room.archive')}
                        </Button>
                        {live && !room.successorRoomCode ? (
                          <Button
                            variant={room.handoffDue ? 'primary' : 'ghost'}
                            title={`${t('work.room.handoffTitle')} — ${t('work.room.handoffNote')}`}
                            disabled={busy !== null}
                            onClick={() => {
                              if (!window.confirm(t('work.room.handoffConfirm', { code: room.code }))) return;
                              void run(`handoff-${room.code}`, async () => {
                                const result = await handoffRoom(room.code);
                                setHandoff({
                                  ok: t('work.room.handoffDone', { code: result.successorCode }),
                                  skipped: result.skipped,
                                });
                                return result;
                              });
                            }}>
                            {t('work.room.handoff')}
                          </Button>
                        ) : null}
                        <a href="/new" title={t('work.room.newTitle')}
                          className="inline-flex items-center justify-center gap-1.5 rounded-lg border border-transparent bg-surface-sunken px-3 py-2 text-xs font-semibold text-ink-muted transition hover:text-ink">
                          {t('work.room.new')}
                        </a>
                        {live ? (
                          <Button variant="quiet" title={t('work.room.endTitle')}
                            disabled={busy !== null}
                            onClick={() => void run(`end-${room.code}`, () => endRoom(room.code))}>
                            {t('work.room.end')}
                          </Button>
                        ) : null}
                        <Button variant="danger" title={t('work.room.deleteTitle')}
                          disabled={busy !== null}
                          onClick={() => {
                            if (!window.confirm(t('work.room.deleteConfirm', { code: room.code }))) return;
                            void run(`delete-${room.code}`, () => deleteRoom(room.code));
                          }}>
                          {t('work.room.delete')}
                        </Button>
                      </div>
                    </div>
                    <p className="mt-1 text-[10px] text-ink-faint">
                      {t('work.room.line', { open: room.openTasks, done: room.doneTasks, pending: room.pendingApproval })}
                      {' · '}
                      {room.daysLeft > 0
                        ? t('work.room.expiryTitle', { days: room.daysLeft })
                        : t('work.room.expired')}
                    </p>
                  </li>
                  );
                })}
              </ul>
            )}
            {handoff ? (
              <p className="mt-2 text-[11px] leading-relaxed text-ink-soft">
                <span className="font-semibold text-emerald-700">{handoff.ok}</span>
                {handoff.skipped.length > 0
                  ? ` ${t('work.room.handoffSkipped', { list: handoff.skipped.join('; ') })}`
                  : ''}
              </p>
            ) : null}
          </Card>
        </div>
      </div>
    </div>
  );
}
