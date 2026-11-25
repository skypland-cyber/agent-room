// Work: the boss's queue. What waits for a decision, what is running, what
// failed, and what QA still owes — with the two or three buttons that actually
// change the board, and a plain reason box because a decision without a reason
// is one nobody can audit later.
import { useState } from 'react';
import type { OfficeOverview, OfficeTaskRef } from '@agent-room/shared';
import { abortTask, approveTask, archiveRoomNow, pauseTask, rejectTask, requestApproval, resumeTask, retryTask } from '../../lib/officeApi.js';
import { Badge, Button, Card, Empty, ErrorNote, Input, SectionTitle, formatDate, useOfficeAction } from './ui.js';

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
  const [note, setNote] = useState('');
  const key = `${task.code}:${task.id}`;
  const runKey = (name: string) => `${name}-${key}`;
  return (
    <li className="grid gap-2 py-3 sm:grid-cols-[1fr_auto] sm:items-start">
      <div className="min-w-0">
        <div className="flex flex-wrap items-center gap-2">
          <span className="font-mono text-[11px] text-ink-faint">{task.id}</span>
          <span className="text-sm font-semibold text-ink">{task.title}</span>
          <Badge tone={STATE_TONE[task.state] ?? 'neutral'}>{task.state.replace(/_/g, ' ')}</Badge>
          {task.qaStatus ? <Badge tone={task.qaStatus === 'failed' ? 'bad' : task.qaStatus === 'passed' ? 'good' : 'warn'}>QA {task.qaStatus}</Badge> : null}
          {task.retryCount ? <Badge tone="warn">retry {task.retryCount}</Badge> : null}
        </div>
        <p className="mt-0.5 text-[11px] text-ink-soft">
          <a href={`/r/${task.code}`} className="font-mono hover:text-ink">{task.code}</a>
          {' · '}{task.roomTopic}
          {task.owner ? ` · owner ${task.owner}` : ' · unassigned'}
          {task.verifier ? ` · verifier ${task.verifier}` : ''}
          {' · '}{formatDate(task.updatedAt)}
        </p>
        {task.approvalNote ? <p className="mt-1 text-[11px] text-ink-muted">Note: {task.approvalNote}</p> : null}
      </div>
      <div className="flex flex-wrap items-start gap-1.5">
        <Input
          value={note}
          onChange={event => setNote(event.target.value)}
          placeholder="reason (optional)"
          className="!w-40 !py-1.5 !text-[11px]"
          aria-label={`Reason for ${task.id}`}
        />
        {task.state === 'pending_approval' ? (
          <>
            <Button disabled={busy !== null} onClick={() => void run(runKey('approve'), () => approveTask(task.code, task.id, note || undefined))}>Approve</Button>
            <Button variant="danger" disabled={busy !== null} onClick={() => void run(runKey('reject'), () => rejectTask(task.code, task.id, note || undefined))}>Reject</Button>
          </>
        ) : null}
        {task.state === 'rejected' ? (
          <Button variant="ghost" disabled={busy !== null}
            onClick={() => void run(runKey('retry'), () => retryTask(task.code, task.id, { reason: note || undefined }))}>
            Retry
          </Button>
        ) : null}
        {task.state === 'paused' ? (
          <Button variant="ghost" disabled={busy !== null} onClick={() => void run(runKey('resume'), () => resumeTask(task.code, task.id))}>Resume</Button>
        ) : ['in_progress', 'todo', 'blocked'].includes(task.state) ? (
          <Button variant="quiet" disabled={busy !== null}
            onClick={() => void run(runKey('pause'), () => pauseTask(task.code, task.id, note || undefined))}>
            Pause
          </Button>
        ) : null}
        {!['done', 'cancelled', 'aborted', 'pending_approval'].includes(task.state) ? (
          <Button variant="danger" disabled={busy !== null}
            title="Stop this work for good"
            onClick={() => {
              if (!window.confirm(`Abort ${task.id} for good? This cannot be undone.`)) return;
              void run(runKey('abort'), () => abortTask(task.code, task.id, note || undefined));
            }}>
            Abort
          </Button>
        ) : null}
        {task.state === 'todo' && !task.requiresApproval ? (
          <Button variant="quiet" disabled={busy !== null}
            onClick={() => void run(runKey('gate'), () => requestApproval(task.code, task.id, note || undefined))}>
            Hold for approval
          </Button>
        ) : null}
        {busy === runKey('approve') || busy === runKey('reject') ? <span className="text-[11px] text-ink-faint">saving…</span> : null}
      </div>
    </li>
  );
}

export function OfficeWorkPanel({ overview, onChanged }: Props) {
  const [showAll, setShowAll] = useState(false);
  const { busy, error, run } = useOfficeAction(onChanged);
  const running = overview.openTasks.filter(task => task.state !== 'pending_approval');
  const visible = showAll ? running : running.slice(0, 12);

  return (
    <div className="grid gap-5">
      <Card className="border-amber-200/70">
        <SectionTitle
          title={`Approvals (${overview.approvals.length})`}
          hint="Important work waits here. Nothing an agent can do will start these tasks before you rule."
        />
        <ErrorNote error={error} />
        {overview.approvals.length === 0 ? (
          <Empty>Nothing waiting for approval. Tasks created with &quot;requires approval&quot;, or by staff that do, land here.</Empty>
        ) : (
          <ul className="divide-y divide-border-faint">
            {overview.approvals.map(task => <TaskRow key={`${task.code}-${task.id}`} task={task} onChanged={onChanged} run={run} busy={busy} />)}
          </ul>
        )}
      </Card>

      <div className="grid gap-5 lg:grid-cols-[1.4fr_1fr]">
        <Card>
          <SectionTitle
            title={`Open work (${running.length})`}
            hint="Everything still asking something of somebody. Pausing keeps the evidence; aborting does not."
            action={running.length > 12 ? (
              <Button variant="ghost" onClick={() => setShowAll(value => !value)}>{showAll ? 'Show less' : 'Show all'}</Button>
            ) : undefined}
          />
          {visible.length === 0 ? <Empty>No open tasks across the office.</Empty> : (
            <ul className="divide-y divide-border-faint">
              {visible.map(task => <TaskRow key={`${task.code}-${task.id}`} task={task} onChanged={onChanged} run={run} busy={busy} />)}
            </ul>
          )}
        </Card>

        <div className="grid gap-5">
          <Card>
            <SectionTitle title={`QA queue (${overview.qaQueue.length})`} hint="Submitted work waiting for an independent quality pass." />
            {overview.qaQueue.length === 0 ? <Empty>No QA owed.</Empty> : (
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
            <SectionTitle title={`Meetings (${overview.rooms.length})`} hint="Open rooms and their boards. Archive keeps the minutes after the room expires." />
            {overview.rooms.length === 0 ? <Empty>No rooms yet — open one from a template or the room page.</Empty> : (
              <ul className="grid gap-2">
                {overview.rooms.map(room => (
                  <li key={room.code} className="rounded-xl border border-border-faint bg-white px-3 py-2">
                    <div className="flex items-center justify-between gap-2">
                      <a href={`/r/${room.code}`} className="min-w-0">
                        <span className="block truncate text-xs font-semibold text-ink">{room.topic}</span>
                        <span className="font-mono text-[10px] text-ink-faint">{room.code} · {room.participants} seated · {room.agents} agents</span>
                      </a>
                      <div className="flex shrink-0 items-center gap-1">
                        <Badge tone={room.status === 'active' ? 'good' : 'neutral'}>{room.status}</Badge>
                        <Button variant="quiet" title="Archive the minutes now"
                          disabled={busy !== null}
                          onClick={() => void run(`archive-${room.code}`, () => archiveRoomNow(room.code))}>
                          Archive
                        </Button>
                      </div>
                    </div>
                    <p className="mt-1 text-[10px] text-ink-faint">{room.openTasks} open · {room.doneTasks} done · {room.pendingApproval} awaiting approval</p>
                  </li>
                ))}
              </ul>
            )}
          </Card>
        </div>
      </div>
    </div>
  );
}
