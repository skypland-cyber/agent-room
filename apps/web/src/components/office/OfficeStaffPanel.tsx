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
          title="AI staff"
          hint="Each entry is an agent you can assign work to. Paused staff keep their seat but receive nothing new."
        />
        <ErrorNote error={error} />
        {agents.length === 0 ? (
          <Empty>No AI staff yet. Add one on the right, then open a room and let it listen.</Empty>
        ) : (
          <ul className="mt-3 divide-y divide-border-faint">
            {agents.map(agent => (
              <li key={agent.id} className="flex flex-wrap items-start justify-between gap-3 py-3">
                <div className="min-w-0">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="text-sm font-semibold text-ink">{agent.name}</span>
                    <Badge tone={STATUS_TONE[agent.presence.status] ?? 'neutral'}>{agent.presence.label}</Badge>
                    {agent.requiresApproval ? <Badge tone="warn">Approval needed</Badge> : null}
                    {!agent.enabled ? <Badge tone="bad">Disabled</Badge> : null}
                  </div>
                  <p className="mt-0.5 text-xs text-ink-muted">{agent.role}</p>
                  <p className="mt-1 text-[11px] text-ink-faint">
                    {agent.tags.length ? `Tags: ${agent.tags.join(', ')} · ` : ''}
                    Today {agent.tasksToday}/{agent.dailyTaskLimit} ·
                    {' '}heartbeat {timeAgo(agent.presence.heartbeatAgeMs !== undefined ? Date.now() - agent.presence.heartbeatAgeMs : agent.lastHeartbeatAt)}
                    {agent.presence.roomCode ? ` · room ${agent.presence.roomCode}` : ''}
                  </p>
                </div>
                <div className="flex shrink-0 items-center gap-1.5">
                  <Button variant="ghost" onClick={() => startEdit(agent)}>Edit</Button>
                  <Button variant={agent.paused ? 'ghost' : 'quiet'} disabled={busy !== null}
                    onClick={() => void run(`pause-${agent.id}`, () => pauseAgent(agent.id, !agent.paused))}>
                    {agent.paused ? 'Resume' : 'Pause'}
                  </Button>
                  <Button variant="danger" disabled={busy !== null}
                    onClick={() => {
                      if (!window.confirm(`Remove ${agent.name} from the office? Their seat keys stay with the rooms.`)) return;
                      void run(`delete-${agent.id}`, () => deleteAgent(agent.id));
                    }}>
                    Remove
                  </Button>
                </div>
              </li>
            ))}
          </ul>
        )}
      </Card>

      <Card>
        <SectionTitle
          title={editing ? 'Edit AI staff' : 'Add AI staff'}
          hint="The name must match the name the agent uses when it joins a room."
          action={editing ? <Button variant="ghost" onClick={() => { setEditing(false); setForm({ ...EMPTY_FORM }); }}>Cancel</Button> : undefined}
        />
        <form
          className="grid gap-3"
          onSubmit={event => { event.preventDefault(); void submit(); }}
        >
          <Field label="Name" hint="Exactly as the agent introduces itself, e.g. Qwen.">
            <Input value={form.name} onChange={event => setForm({ ...form, name: event.target.value })} required maxLength={80} placeholder="Qwen" />
          </Field>
          <Field label="Role / speciality">
            <Input value={form.role} onChange={event => setForm({ ...form, role: event.target.value })} required maxLength={120} placeholder="Korean copywriter" />
          </Field>
          <Field label="Tags" hint="Work it may be assigned, comma separated. Templates match on these.">
            <Input value={form.tags} onChange={event => setForm({ ...form, tags: event.target.value })} placeholder="copy, ko, print" />
          </Field>
          <div className="grid grid-cols-2 gap-3">
            <Field label="Daily task limit" hint="0 = unlimited.">
              <Input type="number" min={0} max={500} value={form.dailyTaskLimit}
                onChange={event => setForm({ ...form, dailyTaskLimit: event.target.value })} />
            </Field>
            <div className="grid gap-2 self-end pb-1">
              <label className="flex items-center gap-2 text-xs text-ink-muted">
                <input type="checkbox" checked={form.requiresApproval}
                  onChange={event => setForm({ ...form, requiresApproval: event.target.checked })} />
                Its work needs approval
              </label>
              <label className="flex items-center gap-2 text-xs text-ink-muted">
                <input type="checkbox" checked={form.enabled}
                  onChange={event => setForm({ ...form, enabled: event.target.checked })} />
                Enabled
              </label>
            </div>
          </div>
          <Field label="Standing brief (optional)" hint="Handed to the agent with its assignments.">
            <TextArea value={form.brief} onChange={event => setForm({ ...form, brief: event.target.value })} maxLength={4000} placeholder="Writes in Korean, always cites the source sheet." />
          </Field>
          {error ? <p className="text-[11px] text-rose-600">{error}</p> : null}
          <div className="flex items-center gap-2">
            <Button type="submit" disabled={busy !== null}>{editing ? 'Save changes' : 'Add to the roster'}</Button>
            {editing ? <span className="text-[11px] text-ink-faint">Editing {form.name}</span> : null}
          </div>
        </form>
        {error && !editing ? <button type="button" className="mt-2 text-[11px] text-ink-faint underline" onClick={() => setError(null)}>dismiss</button> : null}
      </Card>
    </div>
  );
}
