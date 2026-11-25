import { useState } from 'react';
import type { ClientKind, Participant, RoomArtifact, Task, TaskState } from '@agent-room/shared';
import { artifactLabel } from '@agent-room/shared';
import {
  blockTask,
  cancelTask,
  createTask,
  reassignTaskRoles,
  resumeTask,
  updateTask,
  verifyTask,
} from '../lib/roomApi.js';
import type { useTaskBoard } from '../hooks/useTaskBoard.js';
import { TaskTimeline } from './TaskTimeline.js';

interface Props {
  code: string;
  me: { name: string };
  isHost: boolean;
  ended: boolean;
  /** Agent participants (client === 'cc'), the assignable owners/verifiers. */
  agents: Participant[];
  artifacts: RoomArtifact[];
  /** Rooms with no messages have nothing to freeze into a report. */
  canExport: boolean;
  reportBusy: boolean;
  onExportReport: () => void;
  /** Drops text into the room composer so the host can chase a task in chat. */
  onMention: (text: string) => void;
  /** Opens the file shelf filtered to this task's materials and deliverables. */
  onOpenTaskFiles?: (taskId: string) => void;
  /**
   * Owned by Room so the mobile tab strip can badge "needs review" without a
   * second poller running against the same board key.
   */
  taskBoard: ReturnType<typeof useTaskBoard>;
}

const STATE_TONE: Record<TaskState, { label: string; chip: string; rail: string }> = {
  todo:            { label: 'To do',       chip: 'bg-surface-sunken text-ink-muted ring-border',            rail: 'bg-ink-faint' },
  in_progress:     { label: 'In progress', chip: 'bg-blue-50 text-blue-800 ring-blue-200',                  rail: 'bg-blue-500' },
  awaiting_review: { label: 'Needs review', chip: 'bg-amber-50 text-amber-800 ring-amber-200',              rail: 'bg-amber-500' },
  blocked:         { label: 'Blocked',     chip: 'bg-rose-50 text-rose-800 ring-rose-200',                  rail: 'bg-rose-500' },
  done:            { label: 'Done',        chip: 'bg-emerald-50 text-emerald-800 ring-emerald-200',         rail: 'bg-emerald-500' },
  rejected:        { label: 'Rejected',    chip: 'bg-rose-50 text-rose-800 ring-rose-200',                  rail: 'bg-rose-500' },
  cancelled:       { label: 'Cancelled',   chip: 'bg-surface-sunken text-ink-faint ring-border-faint',      rail: 'bg-border' },
};

// Action-first ordering: what needs the host's thumb comes before what is
// merely running. Closed states drop below the fold entirely.
const OPEN_ORDER: TaskState[] = ['awaiting_review', 'blocked', 'in_progress', 'todo'];
const CLOSED: ReadonlySet<TaskState> = new Set<TaskState>(['done', 'rejected', 'cancelled']);

/** Split the board into the action-ordered open list and the closed archive. */
export function partitionTasks(tasks: Task[]): { open: Task[]; closed: Task[] } {
  return {
    open: tasks.filter(t => !CLOSED.has(t.state))
      .sort((a, b) => OPEN_ORDER.indexOf(a.state) - OPEN_ORDER.indexOf(b.state) || a.id.localeCompare(b.id)),
    closed: tasks.filter(t => CLOSED.has(t.state)).sort((a, b) => b.updatedAt - a.updatedAt),
  };
}

/**
 * The reviewer line on a card. Says why a review has nobody on it instead of
 * leaving the line blank, and names who actually ruled once it is done.
 */
export function taskReviewLabel(task: Task): string {
  if (task.state === 'done' && task.verdict?.by) return `Verified by @${task.verdict.by}`;
  if (task.state === 'awaiting_review' && task.reviewStatus === 'waiting_for_capability') {
    return `Reviewer @${task.verifier ?? '—'} lacks a requirement`;
  }
  if (task.state === 'awaiting_review' && !task.verifier?.trim()) return 'Waiting for an independent reviewer';
  if (!task.verifier?.trim()) return 'Assigned on submission';
  return `@${task.verifier}${task.reviewStatus === 'verifier_offline' ? ' · offline' : ''}`;
}

/** An explicit owner/review wait that has not been resolved yet. */
export function openWait(task: Task): NonNullable<Task['waiting']> | undefined {
  return task.waiting && task.waiting.resumedAt === undefined ? task.waiting : undefined;
}

/**
 * Whether this viewer may rule on a task, mirroring verifyTask's server-side
 * guards: only 'awaiting_review' is rulable, the owner never rules on their
 * own delivery, an open review wait must be resolved first, and a designated
 * verifier excludes everyone else — except the host, who may rule from the
 * board (verifyTask's hostOverride). Kept in sync deliberately so the UI never
 * renders an Approve button the server rejects.
 */
export function canRuleOn(task: Task, viewer: { name: string; client: ClientKind }, ended: boolean, isHost = false): boolean {
  if (ended || task.state !== 'awaiting_review') return false;
  if (openWait(task)) return false;
  // Identity is (name, client) everywhere in this app, and a room can hold
  // both "Robin - web" and "Robin - cc". Matching on name alone hid Approve
  // from a host who shares a display name with the agent that owns the task.
  // An unrecorded client matches, same direction the server takes.
  if (task.owner === viewer.name
    && (task.ownerClient === undefined || task.ownerClient === viewer.client)) return false;
  if (task.verifier && !isHost && !(task.verifier === viewer.name
    && (task.verifierClient === undefined || task.verifierClient === viewer.client))) return false;
  return true;
}

// Shared control sizing. 40px tall on touch, 32px from `sm:` up — the old
// board-less UI used 28px controls that were unhittable on a phone.
const CTRL = 'min-h-10 sm:min-h-8 rounded-lg px-2.5 text-[13px] sm:text-xs font-semibold transition active:scale-[0.98] disabled:opacity-50 disabled:cursor-not-allowed';
const FIELD = 'w-full min-h-10 rounded-lg border border-border bg-white px-3 text-[15px] sm:text-[13px] text-ink outline-none focus:border-accent focus:ring-2 focus:ring-accent-tint disabled:opacity-60';

export function TaskBoard({ code, me, isHost, ended, agents, artifacts, canExport, reportBusy, onExportReport, onMention, taskBoard }: Props) {
  const { board, loaded, busy, run } = taskBoard;
  const [composing, setComposing] = useState(false);
  const [showClosed, setShowClosed] = useState(false);
  const [view, setView] = useState<'board' | 'timeline'>('board');

  const tasks = board?.tasks ?? [];
  const { open, closed } = partitionTasks(tasks);
  const needsMe = open.filter(t => canRuleOn(t, { name: me.name, client: 'web' }, ended, isHost)).length;

  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col">
      <div className="shrink-0 border-b border-border-faint bg-surface p-3 sm:p-4">
        <div className="flex items-center justify-between gap-3">
          <div className="min-w-0">
            <h2 className="text-sm font-semibold text-ink">Tasks</h2>
            <p className="text-[11px] text-ink-soft">
              {!loaded ? 'Loading board' : open.length === 0 && closed.length === 0
                ? 'No tasks yet'
                : `${open.length} open · ${closed.length} closed`}
            </p>
          </div>
          {needsMe > 0 && (
            <span className="shrink-0 rounded-full bg-amber-50 px-2.5 py-1 text-[11px] font-bold text-amber-800 ring-1 ring-inset ring-amber-200">
              {needsMe} to review
            </span>
          )}
        </div>
        {tasks.length > 0 && (
          <div className="mt-3 flex gap-1.5" role="group" aria-label="Task views">
            {(['board', 'timeline'] as const).map(value => (
              <button
                key={value}
                type="button"
                aria-pressed={view === value}
                onClick={() => setView(value)}
                className={`${CTRL} flex-1 border ${view === value
                  ? 'border-accent-tint-border bg-accent-tint text-accent'
                  : 'border-border bg-surface-softer text-ink-muted'}`}
              >
                {value === 'board' ? 'Board' : 'Timeline'}
              </button>
            ))}
          </div>
        )}
        {!ended && (
          <button
            type="button"
            onClick={() => setComposing(v => !v)}
            className={`mt-3 w-full ${CTRL} ${composing
              ? 'border border-border bg-surface-softer text-ink-muted'
              : 'bg-accent text-white shadow-sm hover:opacity-90'}`}
          >
            {composing ? 'Cancel' : 'New task'}
          </button>
        )}
        {composing && (
          <NewTaskForm
            agents={agents}
            busy={busy}
            onCancel={() => setComposing(false)}
            onSubmit={async (input) => {
              const ok = await run(
                c => createTask(c, code, { ...input, createdBy: me.name }),
                'Could not create task',
              );
              if (ok) setComposing(false);
            }}
          />
        )}
      </div>

      <div className="min-h-0 min-w-0 flex-1 overflow-y-auto overflow-x-hidden p-3 sm:p-4">
        {!loaded ? (
          <BoardSkeleton />
        ) : tasks.length === 0 ? (
          <EmptyBoard hasAgents={agents.length > 0} />
        ) : view === 'timeline' ? (
          <TaskTimeline tasks={tasks} filterable />
        ) : (
          <div className="space-y-2.5">
            {open.map(task => (
              <TaskCard
                key={task.id}
                task={task}
                me={me}
                isHost={isHost}
                ended={ended}
                agents={agents}
                busy={busy}
                run={run}
                code={code}
                onMention={onMention}
              />
            ))}

            {closed.length > 0 && (
              <>
                <button
                  type="button"
                  onClick={() => setShowClosed(v => !v)}
                  className="mt-4 flex w-full items-center justify-between rounded-lg border border-border-faint bg-surface-softer px-3 py-2.5 text-[13px] sm:text-xs font-semibold text-ink-muted transition hover:border-border"
                >
                  <span>Closed ({closed.length})</span>
                  <span className="text-ink-faint">{showClosed ? 'Hide' : 'Show'}</span>
                </button>
                {showClosed && closed.map(task => (
                  <TaskCard
                    key={task.id}
                    task={task}
                    me={me}
                    isHost={isHost}
                    ended={ended}
                    agents={agents}
                    busy={busy}
                    run={run}
                    code={code}
                    onMention={onMention}
                  />
                ))}
              </>
            )}
          </div>
        )}

        <DeliverySection
          artifacts={artifacts}
          canExport={canExport}
          reportBusy={reportBusy}
          onExportReport={onExportReport}
        />
      </div>
    </div>
  );
}

function TaskCard({ task, me, isHost, ended, agents, busy, run, code, onMention, onOpenTaskFiles }: {
  task: Task;
  me: { name: string };
  isHost: boolean;
  ended: boolean;
  agents: Participant[];
  busy: boolean;
  run: ReturnType<typeof useTaskBoard>['run'];
  code: string;
  onMention: (text: string) => void;
  onOpenTaskFiles?: (taskId: string) => void;
}) {
  const [panel, setPanel] = useState<'none' | 'reject' | 'block' | 'assign' | 'resume'>('none');
  const [note, setNote] = useState('');
  const tone = STATE_TONE[task.state];

  const iAmOwner = task.owner === me.name
    && (task.ownerClient === undefined || task.ownerClient === 'web');
  const canRule = canRuleOn(task, { name: me.name, client: 'web' }, ended, isHost);
  const wait = openWait(task);
  const canBlock = !ended && (isHost || iAmOwner) && (task.state === 'in_progress' || task.state === 'todo');
  // A recorded wait is released with a resolution, not a bare reopen.
  const canResume = !ended && !!wait
    && (isHost || (wait.waitingFor?.trim().toLowerCase() === me.name.trim().toLowerCase()));
  const canReopen = !ended && isHost && !wait
    && (task.state === 'blocked' || task.state === 'rejected' || task.state === 'awaiting_review');
  const canAssign = !ended && isHost && !CLOSED.has(task.state);
  const canCancel = !ended && isHost && !CLOSED.has(task.state)
    && !task.evidence && !task.readinessNote?.trim();

  const closePanel = () => { setPanel('none'); setNote(''); };

  return (
    <article className="overflow-hidden rounded-xl border border-border-faint bg-surface">
      <div className="flex">
        <div className={`w-1 shrink-0 ${tone.rail}`} aria-hidden="true" />
        <div className="min-w-0 flex-1 p-3">
          <div className="flex items-start justify-between gap-2">
            <div className="min-w-0">
              <div className="flex items-center gap-2">
                <span className="font-mono text-[11px] font-semibold text-ink-faint">{task.id}</span>
                <span className={`rounded-full px-2 py-0.5 text-[10px] font-bold uppercase tracking-wide ring-1 ring-inset ${tone.chip}`}>
                  {tone.label}
                </span>
              </div>
              <h3 className="mt-1.5 text-[14px] font-semibold leading-snug text-ink break-words">{task.title}</h3>
            </div>
          </div>

          <dl className="mt-2 flex min-w-0 flex-wrap gap-x-4 gap-y-1 text-[11px] text-ink-soft">
            <div className="flex gap-1">
              <dt className="text-ink-faint">Owner</dt>
              <dd className="font-semibold text-ink-muted break-all">{task.owner ?? 'unassigned'}</dd>
            </div>
            <div className="flex gap-1">
              <dt className="text-ink-faint">Verifier</dt>
              <dd className="font-semibold text-ink-muted break-all">{taskReviewLabel(task)}</dd>
            </div>
          </dl>
          {task.state === 'awaiting_review' && task.reviewReceipt && (
            <p className="mt-1 text-[11px] text-ink-soft">
              Review {task.reviewReceipt.startedAt !== undefined ? 'accepted' : 'acknowledged'} by @{task.reviewReceipt.by}
            </p>
          )}
          {task.state === 'awaiting_review' && task.reviewReadiness && (
            <p className="mt-1 text-[11px] text-amber-800 break-words">Review needs: {task.reviewReadiness}</p>
          )}
          <ExecutionLine task={task} />

          {/*
            The task's paper trail. A done task with no deliverable is the
            failure the board exists to prevent, so it says so here instead of
            leaving a reader to assume the work exists because the state says
            done.
          */}
          {(task.files?.inputs?.length || task.files?.deliverables?.length) ? (
            <button
              type="button"
              onClick={() => onOpenTaskFiles?.(task.id)}
              className="mt-1.5 flex flex-wrap items-center gap-2 rounded-lg border border-border-faint bg-surface-softer px-2.5 py-1.5 text-[11px] font-semibold text-ink-muted transition hover:border-accent/40 hover:text-accent"
            >
              {task.files?.deliverables?.length ? <span>🗂 {task.files.deliverables.length} deliverable{task.files.deliverables.length === 1 ? '' : 's'}</span> : null}
              {task.files?.inputs?.length ? <span>📎 {task.files.inputs.length} input{task.files.inputs.length === 1 ? '' : 's'}</span> : null}
              <span className="text-accent">Open files</span>
            </button>
          ) : task.state === 'done' ? (
            <p className="mt-1.5 rounded-lg bg-amber-50 px-2.5 py-1.5 text-[11px] font-semibold text-amber-800">
              Done with no file attached — nothing here can be re-checked later.
            </p>
          ) : null}

          {task.dod && (
            <p className="mt-2 rounded-lg bg-surface-softer px-2.5 py-2 text-[12px] leading-relaxed text-ink-muted break-words">
              <span className="font-semibold text-ink-faint">Done when: </span>{task.dod}
            </p>
          )}
          {task.subtasks?.length ? (
            <p className="mt-2 text-[11px] font-semibold text-ink-soft">
              Subtasks {task.subtasks.filter(s => s.done).length}/{task.subtasks.length}
            </p>
          ) : null}
          {task.state === 'awaiting_review' && (task.readinessNote || task.evidence) && (
            <ReviewEvidence task={task} />
          )}
          {wait ? (
            <Callout
              tone="rose"
              title={`${wait.scope === 'review' ? 'Review waiting' : 'Waiting'} · ${wait.reasonCode.replaceAll('_', ' ')}${wait.waitingFor ? ` · needs @${wait.waitingFor}` : ''}`}
              body={`${wait.reason}\nResume when: ${wait.resumeWhen}`}
            />
          ) : task.state === 'blocked' && task.blocked && (
            <Callout tone="rose" title={`Blocked by ${task.blocked.by}`} body={task.blocked.reason} />
          )}
          {task.verdict && CLOSED.has(task.state) && task.verdict.note && (
            <Callout
              tone={task.verdict.verdict === 'done' ? 'emerald' : 'rose'}
              title={`${task.verdict.verdict === 'done' ? 'Approved' : 'Rejected'} by ${task.verdict.by}`}
              body={task.verdict.note}
            />
          )}

          {panel === 'none' ? (
            <div className="mt-3 flex flex-wrap gap-2">
              {canRule && (
                <>
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() => void run(
                      c => verifyTask(c, code, task.id, { name: me.name, client: 'web' }, 'done', undefined, Date.now(), { hostOverride: isHost }),
                      'Approve failed',
                    )}
                    className={`${CTRL} bg-emerald-600 text-white hover:bg-emerald-700`}
                  >
                    Approve
                  </button>
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() => setPanel('reject')}
                    className={`${CTRL} border border-rose-200 bg-rose-50 text-rose-700 hover:bg-rose-100`}
                  >
                    Reject
                  </button>
                </>
              )}
              {canResume && (
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => setPanel('resume')}
                  className={`${CTRL} border border-border bg-surface-softer text-ink-muted hover:border-accent/40 hover:text-accent`}
                >
                  Resume
                </button>
              )}
              {canReopen && (
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => void run(c => updateTask(c, code, task.id, { state: 'todo' }), 'Reopen failed')}
                  className={`${CTRL} border border-border bg-surface-softer text-ink-muted hover:border-accent/40 hover:text-accent`}
                >
                  Reopen
                </button>
              )}
              {canBlock && (
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => setPanel('block')}
                  className={`${CTRL} border border-border bg-surface-softer text-ink-muted hover:border-rose-300 hover:text-rose-600`}
                >
                  Block
                </button>
              )}
              {canAssign && (
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => setPanel('assign')}
                  className={`${CTRL} border border-border bg-surface-softer text-ink-muted hover:border-accent/40 hover:text-accent`}
                >
                  Reassign
                </button>
              )}
              {task.owner && !ended && (
                <button
                  type="button"
                  onClick={() => onMention(`@${task.owner} status on ${task.id} (${task.title})?`)}
                  className={`${CTRL} border border-accent-tint-border bg-accent-tint text-accent hover:bg-accent-tint-border`}
                >
                  Ask owner
                </button>
              )}
              {canCancel && (
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => void run(
                    c => cancelTask(c, code, task.id, { name: me.name, client: 'web' }, 'Cancelled by host'),
                    'Cancel failed',
                  )}
                  className={`${CTRL} ml-auto text-ink-faint hover:text-rose-600`}
                >
                  Cancel
                </button>
              )}
            </div>
          ) : panel === 'assign' ? (
            <AssignPanel
              agents={agents}
              task={task}
              busy={busy}
              onCancel={closePanel}
              onSubmit={async (patch) => {
                const ok = await run(
                  c => reassignTaskRoles(c, code, task.id, patch, { name: me.name, client: 'web' }),
                  'Reassign failed',
                );
                if (ok) closePanel();
              }}
            />
          ) : (
            <NotePanel
              id={`task-note-${task.id}`}
              label={panel === 'reject' ? 'What has to change before this passes?'
                : panel === 'resume' ? 'How was the missing condition met?' : 'What exactly is missing?'}
              submitLabel={panel === 'reject' ? 'Reject task' : panel === 'resume' ? 'Resume task' : 'Mark blocked'}
              destructive={panel !== 'resume'}
              value={note}
              onChange={setNote}
              busy={busy}
              onCancel={closePanel}
              onSubmit={async () => {
                const ok = await run(
                  c => panel === 'reject'
                    ? verifyTask(c, code, task.id, { name: me.name, client: 'web' }, 'rejected', note.trim(), Date.now(), { hostOverride: isHost })
                    : panel === 'resume'
                      ? resumeTask(c, code, task.id, { name: me.name, client: 'web' }, note.trim(), Date.now(), isHost)
                      : blockTask(c, code, task.id, { name: me.name, client: 'web' }, note.trim()),
                  panel === 'reject' ? 'Reject failed' : panel === 'resume' ? 'Resume failed' : 'Block failed',
                );
                if (ok) closePanel();
              }}
            />
          )}
        </div>
      </div>
    </article>
  );
}

/** Fenced-execution state of the current attempt, when the task has one. */
export function executionSummary(task: Task, now = Date.now()): string | null {
  const exec = task.execution;
  if (!exec) return null;
  const attempt = task.attempts?.find(a => a.id === exec.attemptId);
  const count = task.attempts?.length ?? 0;
  const tries = count > 1 ? ` · attempt ${count}` : '';
  if (exec.decisionRequired) return `Needs a reopen/cancel decision${tries}`;
  if (attempt?.status === 'running' && task.lease && task.lease.status === 'active' && task.lease.expiresAt > now) {
    return `Executing · @${attempt.name}${tries}`;
  }
  if (exec.recoveryRequired) return `Execution ${attempt?.endReason?.replaceAll('_', ' ') ?? 'ended'} · needs recovery${tries}`;
  return attempt ? `Execution ${attempt.status}${tries}` : null;
}

function ExecutionLine({ task }: { task: Task }) {
  const line = executionSummary(task);
  const [open, setOpen] = useState(false);
  const events = task.timeline?.length ?? 0;
  if (!line && !events) return null;
  return (
    <div className="mt-1 min-w-0 text-[11px] text-ink-soft">
      {line && <p className="break-words">{line}</p>}
      {events > 0 && (
        <>
          <button
            type="button"
            onClick={() => setOpen(v => !v)}
            aria-expanded={open}
            className="mt-1 font-semibold underline underline-offset-2"
          >
            {open ? 'Hide activity' : `Activity (${events})`}
          </button>
          {open && <div className="mt-2"><TaskTimeline tasks={[task]} /></div>}
        </>
      )}
    </div>
  );
}

function ReviewEvidence({ task }: { task: Task }) {
  const [open, setOpen] = useState(false);
  const ev = task.evidence;
  return (
    <div className="mt-2 rounded-lg border border-amber-200 bg-amber-50 p-2.5">
      <p className="text-[12px] leading-relaxed text-amber-900 break-words">
        {task.readinessNote ?? 'Evidence submitted and waiting on a peer ruling.'}
      </p>
      {ev && (
        <>
          <button
            type="button"
            onClick={() => setOpen(v => !v)}
            className="mt-2 text-[11px] font-semibold text-amber-800 underline underline-offset-2"
          >
            {open
              ? 'Hide evidence'
              : `Evidence from ${ev.submittedBy}${typeof ev.exitCode === 'number' ? ` (exit ${ev.exitCode})` : ''}`}
          </button>
          {open && (
            <div className="mt-2 space-y-2">
              {/* The check is a run OR a criterion-by-criterion account; show whichever was given. */}
              {([['Files', ev.fileListing], ['Excerpt', ev.fileExcerpt], ['Run output', ev.runOutput], ['Checks', ev.checks]] as const)
                .filter(([, body]) => Boolean(body))
                .map(([label, body]) => (
                <div key={label}>
                  <div className="text-[10px] font-bold uppercase tracking-wide text-amber-700">{label}</div>
                  <pre className="mt-1 max-h-40 overflow-auto rounded-md bg-ink px-2.5 py-2 text-[11px] leading-relaxed text-white/90">
                    <code>{body}</code>
                  </pre>
                </div>
              ))}
            </div>
          )}
        </>
      )}
    </div>
  );
}

function Callout({ tone, title, body }: { tone: 'emerald' | 'rose'; title: string; body: string }) {
  const skin = tone === 'emerald'
    ? 'border-emerald-200 bg-emerald-50 text-emerald-800'
    : 'border-rose-200 bg-rose-50 text-rose-800';
  return (
    <div className={`mt-2 rounded-lg border p-2.5 ${skin}`}>
      <div className="text-[11px] font-bold">{title}</div>
      <p className="mt-0.5 whitespace-pre-line text-[12px] leading-relaxed break-words">{body}</p>
    </div>
  );
}

function NotePanel({ id, label, submitLabel, destructive, value, onChange, busy, onCancel, onSubmit }: {
  id: string;
  label: string;
  submitLabel: string;
  destructive?: boolean;
  value: string;
  onChange: (v: string) => void;
  busy: boolean;
  onCancel: () => void;
  onSubmit: () => void;
}) {
  return (
    <div className="mt-3 rounded-lg border border-border bg-surface-softer p-2.5">
      <label className="block text-[11px] font-semibold text-ink-muted" htmlFor={id}>{label}</label>
      <textarea
        id={id}
        value={value}
        onChange={e => onChange(e.target.value)}
        rows={3}
        className={`mt-1.5 ${FIELD} resize-none py-2 leading-relaxed`}
      />
      <div className="mt-2 flex gap-2">
        <button
          type="button"
          disabled={busy || !value.trim()}
          onClick={onSubmit}
          className={`${CTRL} flex-1 ${destructive ? 'bg-rose-600 text-white hover:bg-rose-700' : 'bg-accent text-white hover:opacity-90'}`}
        >
          {submitLabel}
        </button>
        <button type="button" onClick={onCancel} className={`${CTRL} border border-border bg-white text-ink-muted`}>
          Cancel
        </button>
      </div>
    </div>
  );
}

function AssignPanel({ agents, task, busy, onCancel, onSubmit }: {
  agents: Participant[];
  task: Task;
  busy: boolean;
  onCancel: () => void;
  onSubmit: (patch: { owner?: string; ownerClient?: 'cc'; verifier?: string; verifierClient?: 'cc' }) => void;
}) {
  const [owner, setOwner] = useState(task.owner ?? '');
  const [verifier, setVerifier] = useState(task.verifier ?? '');
  // An empty select omits the field from the patch, so the existing holder
  // survives. Validate the pair the server will actually end up with, and
  // case-insensitively, the way reassignTaskRoles does.
  const resultOwner = owner || task.owner;
  const resultVerifier = verifier || task.verifier;
  const conflict = Boolean(resultOwner) && Boolean(resultVerifier)
    && resultOwner!.trim().toLowerCase() === resultVerifier!.trim().toLowerCase();
  const unchanged = !owner && !verifier;

  return (
    <div className="mt-3 space-y-2 rounded-lg border border-border bg-surface-softer p-2.5">
      <AgentSelect id={`owner-${task.id}`} label="Owner" value={owner} onChange={setOwner} agents={agents} anyLabel="Leave unchanged" />
      <AgentSelect id={`verifier-${task.id}`} label="Verifier" value={verifier} onChange={setVerifier} agents={agents} anyLabel="Leave unchanged" />
      {conflict && (
        <p className="text-[11px] font-semibold text-rose-700">
          That leaves {resultOwner} as both owner and verifier. Nobody signs off on their own delivery.
        </p>
      )}
      <div className="flex gap-2">
        <button
          type="button"
          disabled={busy || conflict || unchanged}
          onClick={() => onSubmit({
            ...(owner ? { owner, ownerClient: 'cc' as const } : {}),
            ...(verifier ? { verifier, verifierClient: 'cc' as const } : {}),
          })}
          className={`${CTRL} flex-1 bg-accent text-white hover:opacity-90`}
        >
          Save roles
        </button>
        <button type="button" onClick={onCancel} className={`${CTRL} border border-border bg-white text-ink-muted`}>
          Cancel
        </button>
      </div>
    </div>
  );
}

function AgentSelect({ id, label, value, onChange, agents, anyLabel }: {
  id: string;
  label: string;
  value: string;
  onChange: (v: string) => void;
  agents: Participant[];
  anyLabel: string;
}) {
  return (
    <div>
      <label htmlFor={id} className="block text-[11px] font-semibold text-ink-muted">{label}</label>
      <select id={id} value={value} onChange={e => onChange(e.target.value)} className={`mt-1 ${FIELD} font-semibold`}>
        <option value="">{anyLabel}</option>
        {agents.map(a => <option key={`${a.name}-${a.client}`} value={a.name}>{a.name}</option>)}
      </select>
    </div>
  );
}

function NewTaskForm({ agents, busy, onCancel, onSubmit }: {
  agents: Participant[];
  busy: boolean;
  onCancel: () => void;
  onSubmit: (input: { title: string; dod?: string; owner?: string; ownerClient?: 'cc'; verifier?: string; verifierClient?: 'cc' }) => void;
}) {
  const [title, setTitle] = useState('');
  const [dod, setDod] = useState('');
  const [owner, setOwner] = useState(agents[0]?.name ?? '');
  const [verifier, setVerifier] = useState(agents.find(a => a.name !== agents[0]?.name)?.name ?? '');
  const conflict = Boolean(owner) && owner === verifier;

  return (
    <form
      className="mt-3 space-y-2.5 rounded-lg border border-border bg-surface-softer p-3"
      onSubmit={e => {
        e.preventDefault();
        if (!title.trim() || conflict) return;
        onSubmit({
          title: title.trim(),
          ...(dod.trim() ? { dod: dod.trim() } : {}),
          ...(owner ? { owner, ownerClient: 'cc' as const } : {}),
          ...(verifier ? { verifier, verifierClient: 'cc' as const } : {}),
        });
      }}
    >
      <div>
        <label htmlFor="new-task-title" className="block text-[11px] font-semibold text-ink-muted">What needs doing</label>
        <input
          id="new-task-title"
          value={title}
          onChange={e => setTitle(e.target.value)}
          placeholder="Add rate limiting to the login route"
          autoFocus
          className={`mt-1 ${FIELD}`}
        />
      </div>
      <div>
        <label htmlFor="new-task-dod" className="block text-[11px] font-semibold text-ink-muted">
          Done when <span className="font-medium text-ink-faint">optional but recommended</span>
        </label>
        <textarea
          id="new-task-dod"
          value={dod}
          onChange={e => setDod(e.target.value)}
          rows={2}
          placeholder="Tests pass and a 6th request inside a minute returns 429"
          className={`mt-1 ${FIELD} resize-none py-2 leading-relaxed`}
        />
      </div>
      {agents.length === 0 ? (
        <p className="rounded-lg bg-white px-2.5 py-2 text-[11px] leading-relaxed text-ink-soft">
          No agents in the room yet. Create the task anyway and assign it once an agent joins.
        </p>
      ) : (
        <div className="grid grid-cols-2 gap-2 [&>*]:min-w-0">
          <AgentSelect id="new-task-owner" label="Owner" value={owner} onChange={setOwner} agents={agents} anyLabel="Unassigned" />
          <AgentSelect id="new-task-verifier" label="Verifier" value={verifier} onChange={setVerifier} agents={agents} anyLabel="Any peer" />
        </div>
      )}
      {conflict && (
        <p className="text-[11px] font-semibold text-rose-700">
          Pick a different verifier. An agent cannot sign off on its own work.
        </p>
      )}
      <div className="flex gap-2">
        <button type="submit" disabled={busy || !title.trim() || conflict} className={`${CTRL} flex-1 bg-accent text-white hover:opacity-90`}>
          {busy ? 'Creating' : 'Create task'}
        </button>
        <button type="button" onClick={onCancel} className={`${CTRL} border border-border bg-white text-ink-muted`}>
          Cancel
        </button>
      </div>
    </form>
  );
}

function BoardSkeleton() {
  return (
    <div className="space-y-2.5" aria-hidden="true">
      {[0, 1, 2].map(i => (
        <div key={i} className="animate-pulse overflow-hidden rounded-xl border border-border-faint bg-surface">
          <div className="flex">
            <div className="w-1 shrink-0 bg-border" />
            <div className="flex-1 space-y-2 p-3">
              <div className="h-3 w-20 rounded bg-surface-sunken" />
              <div className="h-4 w-3/4 rounded bg-surface-sunken" />
              <div className="h-3 w-1/2 rounded bg-surface-sunken" />
            </div>
          </div>
        </div>
      ))}
    </div>
  );
}

function EmptyBoard({ hasAgents }: { hasAgents: boolean }) {
  return (
    <div className="rounded-xl border border-dashed border-border bg-surface-softer p-5 text-center">
      <h3 className="text-[13px] font-semibold text-ink">Nothing assigned yet</h3>
      <p className="mx-auto mt-1.5 max-w-xs text-[12px] leading-relaxed text-ink-soft">
        {hasAgents
          ? 'Create a task to hand real work to an agent. Every task gets an owner and a different verifier, so nothing is done just because its owner says so.'
          : 'Bring an agent into the room first, then create a task to hand it real work with an owner and a separate verifier.'}
      </p>
    </div>
  );
}

function DeliverySection({ artifacts, canExport, reportBusy, onExportReport }: {
  artifacts: RoomArtifact[];
  canExport: boolean;
  reportBusy: boolean;
  onExportReport: () => void;
}) {
  return (
    <section className="mt-6 border-t border-border-faint pt-4">
      <div className="flex items-center justify-between gap-2">
        <h2 className="text-sm font-semibold text-ink">Delivery log</h2>
        <span className="text-[11px] text-ink-soft">{artifacts.length}</span>
      </div>
      {artifacts.length ? (
        <div className="mt-2.5 space-y-2">
          {artifacts.slice(-8).reverse().map(a => (
            <div key={a.id} className="rounded-lg border border-border-faint bg-surface-softer p-2.5">
              <div className="flex items-center justify-between gap-2">
                <span className="text-[10px] font-bold uppercase tracking-wide text-ink-muted">{artifactLabel(a.kind)}</span>
                <span className="text-[10px] text-ink-faint">{a.author}</span>
              </div>
              <p className="mt-1 text-[12px] leading-relaxed text-ink break-words">{a.text}</p>
            </div>
          ))}
        </div>
      ) : (
        <p className="mt-2 rounded-lg border border-border-faint bg-surface-softer p-3 text-[12px] leading-relaxed text-ink-soft">
          Mark a message with [DECISION], [TODO], [STATUS], or [RESULT] and it lands here.
        </p>
      )}
      <button
        type="button"
        onClick={onExportReport}
        disabled={reportBusy || !canExport}
        className={`mt-3 w-full ${CTRL} border border-accent-tint-border bg-accent-tint text-accent hover:bg-accent-tint-border`}
      >
        {reportBusy ? 'Saving' : 'Save and share report'}
      </button>
    </section>
  );
}
