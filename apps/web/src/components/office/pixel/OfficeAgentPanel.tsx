// The character sheet: who this AI is, what it holds right now, and the few
// writes that change that — pause, resume, approve, reject, hand it a new job.
//
// It is the same office API the tabs use, opened from the floor so the boss can
// stay on the map. Every button states its effect in the label and the server's
// refusal is shown verbatim, because a silent no-op here would look like the
// agent ignored an order.
import { useState } from 'react';
import type { OfficeAgentView, OfficeOverview } from '@agent-room/shared';
import {
  applyTemplate,
  approveTask,
  deleteTemplate,
  pauseAgent,
  pauseTask,
  rejectTask,
  resumeTask,
  saveTemplate,
} from '../../../lib/officeApi.js';
import { paletteFor } from './palette.js';
import { openTasksFor } from './scene.js';
import { Badge, Button, ErrorNote, Field, Input, TextArea, timeAgo, useOfficeAction } from '../ui.js';

const STATUS_TONE: Record<string, 'good' | 'warn' | 'bad' | 'info' | 'neutral'> = {
  working: 'info', reviewing: 'warn', idle: 'good', paused: 'neutral', offline: 'neutral',
};

const STATE_TONE: Record<string, 'neutral' | 'good' | 'warn' | 'bad' | 'info'> = {
  todo: 'neutral', pending_approval: 'warn', in_progress: 'info', paused: 'neutral',
  awaiting_review: 'warn', blocked: 'bad', rejected: 'bad', done: 'good', cancelled: 'neutral', aborted: 'neutral',
};

interface Props {
  agent: OfficeAgentView;
  overview: OfficeOverview;
  onClose: () => void;
  onChanged: () => void | Promise<void>;
  onNotify?: (message: string | null) => void;
  fullscreen?: boolean;
}

export function OfficeAgentPanel({ agent, overview, onClose, onChanged, onNotify, fullscreen }: Props) {
  const { busy, error, setError, run } = useOfficeAction(onChanged);
  const [title, setTitle] = useState('');
  const [detail, setDetail] = useState('');
  const [needsApproval, setNeedsApproval] = useState(agent.requiresApproval);
  const [room, setRoom] = useState<{ code: string; assignedTo?: string; kind: 'work' | 'meeting' } | null>(null);

  const tasks = openTasksFor(agent, overview);
  const approvals = tasks.filter(task => task.state === 'pending_approval');
  const limit = agent.dailyTaskLimit || 0;
  const used = agent.tasksToday;
  const log = overview.recentAudit
    .filter(entry => entry.target === agent.id || (agent.presence.roomCode !== undefined && entry.roomCode === agent.presence.roomCode))
    .slice(0, 6);

  const submit = async (kind: 'work' | 'meeting') => {
    const cleanTitle = title.trim();
    if (!cleanTitle) {
      setError('Give the work a title first.');
      return;
    }
    await run(`order-${kind}`, async () => {
      const template = await saveTemplate({
        name: `${kind === 'meeting' ? 'Meeting' : 'Order'} · ${cleanTitle}`.slice(0, 80),
        topic: cleanTitle.slice(0, 300),
        description: `Raised from the office floor for ${agent.name}`,
        tasks: [{
          title: kind === 'meeting' ? `Agenda · ${cleanTitle}`.slice(0, 200) : cleanTitle,
          ...(detail.trim() ? { dod: detail.trim() } : {}),
          owner: agent.name,
          ...(needsApproval ? { requiresApproval: true } : {}),
        }],
      });
      try {
        const result = await applyTemplate(template.id);
        const assigned = result.plan?.find(row => row.index === 0)?.agentName;
        setRoom({ code: result.roomCode, ...(assigned ? { assignedTo: assigned } : {}), kind });
        setTitle('');
        setDetail('');
        onNotify?.(`Room ${result.roomCode} is open — ${assigned ? `${assigned} has the ${kind === 'meeting' ? 'agenda' : 'task'}` : 'the task is unassigned'}`);
      } finally {
        // The template existed only to open this room; leaving it behind would
        // fill the Recurring work tab with one-off jobs.
        await deleteTemplate(template.id).catch(() => undefined);
      }
    });
  };

  return (
    <aside
      aria-label={`${agent.name} details`}
      className={`absolute z-20 flex flex-col overflow-hidden rounded-xl border border-border bg-white shadow-xl ${
        fullscreen
          ? 'inset-x-2 bottom-2 max-h-[62%] sm:inset-y-2 sm:left-auto sm:right-2 sm:w-[340px] sm:max-h-none'
          : 'inset-x-2 bottom-2 max-h-[64%] sm:inset-y-2 sm:left-auto sm:right-2 sm:w-[330px] sm:max-h-none'
      }`}
    >
      <header className="flex items-start justify-between gap-2 border-b border-border-faint px-3 py-2.5">
        <div className="min-w-0">
          <div className="flex items-center gap-1.5">
            <span className="h-2.5 w-2.5 shrink-0 rounded-sm" style={{ background: paletteFor(agent.name).shirt }} />
            <p className="truncate text-sm font-semibold text-ink">{agent.name}</p>
            <Badge tone={STATUS_TONE[agent.presence.status] ?? 'neutral'}>{agent.presence.label}</Badge>
          </div>
          <p className="mt-0.5 truncate text-[11px] text-ink-soft">{agent.role}</p>
        </div>
        <button type="button" onClick={onClose} aria-label="Close" className="shrink-0 rounded-md px-1.5 py-0.5 text-sm text-ink-faint hover:text-ink">✕</button>
      </header>

      <div className="min-h-0 flex-1 overflow-y-auto px-3 py-2.5">
        <dl className="grid gap-1.5 text-[11px]">
          <div className="flex justify-between gap-2">
            <dt className="text-ink-faint">Today</dt>
            <dd className="font-semibold text-ink">
              {used} of {limit || '∞'} tasks
              <span className="ml-1 font-normal text-ink-faint">({agent.remainingToday} left)</span>
            </dd>
          </div>
          <div className="flex justify-between gap-2">
            <dt className="text-ink-faint">Heartbeat</dt>
            <dd className="font-semibold text-ink">{timeAgo(agent.presence.heartbeatAgeMs !== undefined ? Date.now() - agent.presence.heartbeatAgeMs : agent.lastHeartbeatAt)}</dd>
          </div>
          <div className="flex justify-between gap-2">
            <dt className="text-ink-faint">Approval gate</dt>
            <dd className="font-semibold text-ink">{agent.requiresApproval ? 'needs you' : 'works alone'}</dd>
          </div>
          <div className="flex justify-between gap-2">
            <dt className="text-ink-faint">Tags</dt>
            <dd className="truncate text-right font-semibold text-ink">{agent.tags.join(', ') || 'none'}</dd>
          </div>
          {agent.presence.roomCode ? (
            <div className="flex justify-between gap-2">
              <dt className="text-ink-faint">In room</dt>
              <dd className="font-semibold text-ink">
                <a href={`/r/${agent.presence.roomCode}`} className="font-mono text-accent-deep hover:underline">{agent.presence.roomCode}</a>
                {agent.presence.taskId ? ` · ${agent.presence.taskId}` : ''}
              </dd>
            </div>
          ) : null}
        </dl>

        {limit > 0 ? (
          <div className="mt-2 h-1.5 w-full overflow-hidden rounded-full bg-surface-sunken">
            <div className="h-full rounded-full bg-accent" style={{ width: `${Math.min(100, Math.round((used / limit) * 100))}%` }} />
          </div>
        ) : null}

        {agent.brief ? (
          <p className="mt-2 rounded-lg bg-surface-soft px-2 py-1.5 text-[11px] leading-relaxed text-ink-muted">{agent.brief}</p>
        ) : null}

        <ErrorNote error={error} />

        <div className="mt-3 flex flex-wrap gap-1.5">
          <Button
            variant={agent.paused ? 'ghost' : 'quiet'}
            disabled={busy !== null}
            onClick={() => void run('pause', () => pauseAgent(agent.id, !agent.paused))}
          >
            {agent.paused ? 'Resume this AI' : 'Pause this AI'}
          </Button>
          <Button variant="ghost" onClick={onClose}>Back to the floor</Button>
        </div>

        <section className="mt-3">
          <h3 className="text-[11px] font-semibold uppercase tracking-wide text-ink-faint">Holding now · {tasks.length}</h3>
          {tasks.length === 0 ? (
            <p className="mt-1 rounded-lg border border-dashed border-border px-2 py-2 text-[11px] text-ink-soft">Nothing open. Give it a job below.</p>
          ) : (
            <ul className="mt-1 grid gap-1.5">
              {tasks.slice(0, 6).map(task => (
                <li key={`${task.code}-${task.id}`} className="rounded-lg border border-border-faint px-2 py-1.5">
                  <div className="flex items-center gap-1.5">
                    <span className="font-mono text-[10px] text-ink-faint">{task.id}</span>
                    <span className="min-w-0 flex-1 truncate text-[11px] font-semibold text-ink">{task.title}</span>
                    <Badge tone={STATE_TONE[task.state] ?? 'neutral'}>{task.state.replace(/_/g, ' ')}</Badge>
                  </div>
                  <p className="mt-0.5 truncate text-[10px] text-ink-faint">
                    <a href={`/r/${task.code}`} className="font-mono hover:text-ink">{task.code}</a> · {task.roomTopic}
                  </p>
                  <div className="mt-1 flex flex-wrap gap-1">
                    {task.state === 'pending_approval' ? (
                      <>
                        <Button className="!px-2 !py-1 !text-[10px]" disabled={busy !== null}
                          onClick={() => void run(`approve-${task.id}`, () => approveTask(task.code, task.id, 'approved from the floor'))}>
                          Approve
                        </Button>
                        <Button className="!px-2 !py-1 !text-[10px]" variant="danger" disabled={busy !== null}
                          onClick={() => void run(`reject-${task.id}`, () => rejectTask(task.code, task.id, 'rejected from the floor'))}>
                          Reject
                        </Button>
                      </>
                    ) : task.state === 'paused' ? (
                      <Button className="!px-2 !py-1 !text-[10px]" variant="quiet" disabled={busy !== null}
                        onClick={() => void run(`resume-${task.id}`, () => resumeTask(task.code, task.id))}>
                        Resume task
                      </Button>
                    ) : ['in_progress', 'todo', 'blocked'].includes(task.state) ? (
                      <Button className="!px-2 !py-1 !text-[10px]" variant="quiet" disabled={busy !== null}
                        onClick={() => void run(`pause-${task.id}`, () => pauseTask(task.code, task.id, 'paused from the floor'))}>
                        Pause task
                      </Button>
                    ) : null}
                    <a href={`/r/${task.code}`} className="rounded-md px-2 py-1 text-[10px] font-semibold text-accent-deep hover:underline">Open room</a>
                  </div>
                </li>
              ))}
            </ul>
          )}
          {approvals.length > 0 ? (
            <p className="mt-1.5 rounded-lg border border-amber-200 bg-amber-50 px-2 py-1.5 text-[10px] leading-relaxed text-amber-800">
              {agent.name} is waiting in the CEO office for {approvals.length === 1 ? 'one decision' : `${approvals.length} decisions`}.
            </p>
          ) : null}
        </section>

        <section className="mt-3 rounded-lg border border-border-faint p-2">
          <h3 className="text-[11px] font-semibold uppercase tracking-wide text-ink-faint">New work order</h3>
          <div className="mt-1.5 grid gap-1.5">
            <Field label="What should it do?">
              <Input value={title} onChange={event => setTitle(event.target.value)} maxLength={200} placeholder="Quote the plaque order" className="!py-1.5 !text-[11px]" />
            </Field>
            <Field label="Definition of done (optional)">
              <TextArea value={detail} onChange={event => setDetail(event.target.value)} maxLength={2000} placeholder="Three variants, Korean, with the price sheet" className="!min-h-[52px] !py-1.5 !text-[11px]" />
            </Field>
            <label className="flex items-center gap-1.5 text-[11px] text-ink-muted">
              <input type="checkbox" checked={needsApproval} onChange={event => setNeedsApproval(event.target.checked)} />
              Wait for my approval before it starts
            </label>
            <div className="flex flex-wrap gap-1.5">
              <Button className="!px-2 !py-1 !text-[10px]" disabled={busy !== null || !title.trim()} onClick={() => void submit('work')}>
                {busy === 'order-work' ? 'Opening…' : 'Send work order'}
              </Button>
              <Button className="!px-2 !py-1 !text-[10px]" variant="ghost" disabled={busy !== null || !title.trim()} onClick={() => void submit('meeting')}>
                {busy === 'order-meeting' ? 'Opening…' : 'Open as a meeting'}
              </Button>
            </div>
          </div>
          {room ? (
            <div className="mt-2 rounded-lg bg-surface-soft px-2 py-1.5 text-[10px] leading-relaxed text-ink-muted">
              <p>
                {room.kind === 'meeting' ? 'Meeting room' : 'Work order'} opened: <span className="font-mono font-semibold text-ink">{room.code}</span>
                {' · '}
                {room.assignedTo ? `assigned to ${room.assignedTo}` : 'left unassigned (agent paused, disabled or at its daily limit)'}
              </p>
              <div className="mt-1 flex gap-2">
                <a href={`/r/${room.code}`} className="font-semibold text-accent-deep hover:underline">Open the room</a>
                <a href={`/j/${room.code}`} className="font-semibold text-accent-deep hover:underline">Join link</a>
              </div>
            </div>
          ) : null}
        </section>

        <section className="mt-3">
          <h3 className="text-[11px] font-semibold uppercase tracking-wide text-ink-faint">Recent log</h3>
          {log.length === 0 ? (
            <p className="mt-1 text-[11px] text-ink-faint">No entries yet.</p>
          ) : (
            <ul className="mt-1 grid gap-1">
              {log.map(entry => (
                <li key={entry.id} className="flex gap-1.5 text-[10px] leading-relaxed text-ink-muted">
                  <span className="shrink-0 text-ink-faint">{timeAgo(entry.at)}</span>
                  <span className="min-w-0 truncate"><span className="font-semibold text-ink">{entry.action}</span>{entry.detail ? ` · ${entry.detail}` : ''}</span>
                </li>
              ))}
            </ul>
          )}
        </section>

        <button type="button" onClick={onClose} className="mt-3 w-full rounded-lg bg-surface-sunken px-3 py-1.5 text-[11px] font-semibold text-ink-muted sm:hidden">
          Back to the floor
        </button>
      </div>
    </aside>
  );
}
