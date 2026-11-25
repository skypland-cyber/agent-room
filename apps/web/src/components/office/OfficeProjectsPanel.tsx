// Projects: a standing space per client or line of work, with the two things a
// meeting cannot carry — long-term memory and instructions the agents must
// follow. Rooms and tasks link into it, so a project page answers "what do we
// know and what are we doing about it".
import { useState } from 'react';
import type { OfficeProject, OfficeProjectSummary } from '@agent-room/shared';
import {
  addGuideline, addMemory, deleteGuideline, deleteMemory, deleteProject, saveProject, updateGuideline, updateMemory,
} from '../../lib/officeApi.js';
import { Badge, Button, Card, Empty, ErrorNote, Field, Input, SectionTitle, TextArea, formatDate, useOfficeAction } from './ui.js';

interface Props {
  projects: OfficeProjectSummary[];
  onChanged: () => void;
}

export function OfficeProjectsPanel({ projects, onChanged }: Props) {
  const [selected, setSelected] = useState<string | null>(projects[0]?.id ?? null);
  const [form, setForm] = useState({ id: '', name: '', description: '' });
  const [memory, setMemory] = useState({ title: '', body: '', tags: '', pinned: false });
  const [guideline, setGuideline] = useState({ title: '', body: '' });
  const { busy, error, run } = useOfficeAction(onChanged);

  const project = projects.find(item => item.id === selected) ?? projects[0] ?? null;

  const createProject = async () => {
    const ok = await run('project', () => saveProject({ name: form.name.trim(), description: form.description.trim() }));
    if (ok) setForm({ id: '', name: '', description: '' });
  };

  return (
    <div className="grid gap-5 lg:grid-cols-[1fr_1.6fr]">
      <div className="grid gap-5">
        <Card>
          <SectionTitle title="Projects" hint="Independent workspaces. Each keeps its own memory and instructions." />
          <ErrorNote error={error} />
          {projects.length === 0 ? (
            <Empty>No projects yet. Create one below — a client, a product line, a recurring job.</Empty>
          ) : (
            <ul className="mt-2 grid gap-1.5">
              {projects.map(item => (
                <li key={item.id}>
                  <button
                    type="button"
                    onClick={() => setSelected(item.id)}
                    className={`w-full rounded-xl border px-3 py-2.5 text-left transition ${
                      project?.id === item.id ? 'border-accent-tint-border bg-accent-tint/40' : 'border-border bg-white hover:bg-surface-soft'
                    }`}
                  >
                    <div className="flex items-center justify-between gap-2">
                      <span className="text-sm font-semibold text-ink">{item.name}</span>
                      {item.status === 'archived' ? <Badge>Archived</Badge> : <Badge tone="good">Active</Badge>}
                    </div>
                    <p className="mt-0.5 line-clamp-1 text-[11px] text-ink-soft">
                      {item.memoryCount} memories · {item.guidelineCount} instructions · {item.taskRefs.length} linked tasks
                    </p>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </Card>

        <Card>
          <SectionTitle title={form.id ? 'Edit project' : 'New project'} />
          <form
            className="grid gap-3"
            onSubmit={event => { event.preventDefault(); void createProject(); }}
          >
            <Field label="Name"><Input value={form.name} onChange={event => setForm({ ...form, name: event.target.value })} required maxLength={80} placeholder="Acme rebrand" /></Field>
            <Field label="Description"><TextArea value={form.description} onChange={event => setForm({ ...form, description: event.target.value })} maxLength={1000} placeholder="Q1 print catalogue and plaques" /></Field>
            <Button type="submit" disabled={busy !== null}>Create project</Button>
          </form>
        </Card>
      </div>

      {project ? (
        <ProjectDetail
          key={project.id}
          project={project}
          busy={busy}
          run={run}
          onDelete={() => {
            if (!window.confirm(`Delete ${project.name}? Its memory and instructions go with it (meeting archives stay).`)) return;
            void run('delete-project', () => deleteProject(project.id));
          }}
          memoryForm={memory}
          setMemoryForm={setMemory}
          guidelineForm={guideline}
          setGuidelineForm={setGuideline}
        />
      ) : (
        <Card><Empty>Pick a project to see its memory and instructions.</Empty></Card>
      )}
    </div>
  );
}

interface DetailProps {
  project: OfficeProject;
  busy: string | null;
  run: (key: string, action: () => Promise<unknown>) => Promise<boolean>;
  onDelete: () => void;
  memoryForm: { title: string; body: string; tags: string; pinned: boolean };
  setMemoryForm: (value: { title: string; body: string; tags: string; pinned: boolean }) => void;
  guidelineForm: { title: string; body: string };
  setGuidelineForm: (value: { title: string; body: string }) => void;
}

function ProjectDetail({ project, busy, run, onDelete, memoryForm, setMemoryForm, guidelineForm, setGuidelineForm }: DetailProps) {
  const [editingMemory, setEditingMemory] = useState<string | null>(null);
  const [editingGuideline, setEditingGuideline] = useState<string | null>(null);

  const saveMemoryEntry = async () => {
    const payload = { title: memoryForm.title, body: memoryForm.body, tags: memoryForm.tags, pinned: memoryForm.pinned };
    const ok = editingMemory
      ? await run('memory', () => updateMemory(project.id, editingMemory, payload))
      : await run('memory', () => addMemory(project.id, payload));
    if (ok) { setMemoryForm({ title: '', body: '', tags: '', pinned: false }); setEditingMemory(null); }
  };

  const saveGuidelineEntry = async () => {
    const ok = editingGuideline
      ? await run('guideline', () => updateGuideline(project.id, editingGuideline, guidelineForm))
      : await run('guideline', () => addGuideline(project.id, guidelineForm));
    if (ok) { setGuidelineForm({ title: '', body: '' }); setEditingGuideline(null); }
  };

  return (
    <div className="grid gap-5">
      <Card>
        <SectionTitle
          title={project.name}
          hint={project.description || 'No description yet.'}
          action={<Button variant="danger" onClick={onDelete} disabled={busy !== null}>Delete</Button>}
        />
        <dl className="grid grid-cols-2 gap-3 text-xs sm:grid-cols-4">
          <div><dt className="text-ink-faint">Status</dt><dd className="font-semibold text-ink">{project.status}</dd></div>
          <div><dt className="text-ink-faint">Memories</dt><dd className="font-semibold text-ink">{project.memory.length}</dd></div>
          <div><dt className="text-ink-faint">Instructions</dt><dd className="font-semibold text-ink">{project.guidelines.length}</dd></div>
          <div><dt className="text-ink-faint">Created</dt><dd className="font-semibold text-ink">{formatDate(project.createdAt)}</dd></div>
        </dl>
        {project.roomCodes.length > 0 ? (
          <div className="mt-3 flex flex-wrap gap-1.5">
            {project.roomCodes.map(code => (
              <a key={code} href={`/r/${code}`} className="rounded-full bg-surface-sunken px-2.5 py-1 font-mono text-[11px] text-ink-muted hover:text-ink">{code}</a>
            ))}
          </div>
        ) : null}
      </Card>

      <Card>
        <SectionTitle title="Long-term memory" hint="Facts the agents should carry into every meeting for this project." />
        {project.memory.length === 0 ? <Empty>Nothing remembered yet.</Empty> : (
          <ul className="grid gap-2">
            {project.memory.map(entry => (
              <li key={entry.id} className="rounded-xl border border-border-faint bg-surface-soft p-3">
                <div className="flex items-start justify-between gap-2">
                  <div className="min-w-0">
                    <p className="text-xs font-semibold text-ink">
                      {entry.pinned ? '📌 ' : ''}{entry.title}
                      {entry.tags.length ? <span className="ml-2 text-[10px] font-normal text-ink-faint">{entry.tags.join(' · ')}</span> : null}
                    </p>
                    <p className="mt-0.5 whitespace-pre-wrap text-xs leading-relaxed text-ink-muted">{entry.body}</p>
                    <p className="mt-1 text-[10px] text-ink-faint">{entry.by} · {formatDate(entry.updatedAt)}</p>
                  </div>
                  <div className="flex shrink-0 gap-1">
                    <Button variant="quiet" onClick={() => {
                      setEditingMemory(entry.id);
                      setMemoryForm({ title: entry.title, body: entry.body, tags: entry.tags.join(', '), pinned: entry.pinned });
                    }}>Edit</Button>
                    <Button variant="danger" disabled={busy !== null}
                      onClick={() => void run('memory', () => deleteMemory(project.id, entry.id))}>×</Button>
                  </div>
                </div>
              </li>
            ))}
          </ul>
        )}
        <form className="mt-3 grid gap-2 rounded-xl border border-dashed border-border p-3"
          onSubmit={event => { event.preventDefault(); void saveMemoryEntry(); }}>
          <div className="grid gap-2 sm:grid-cols-[1fr_1fr]">
            <Input value={memoryForm.title} onChange={event => setMemoryForm({ ...memoryForm, title: event.target.value })} placeholder="Title (e.g. Tone of voice)" maxLength={120} />
            <Input value={memoryForm.tags} onChange={event => setMemoryForm({ ...memoryForm, tags: event.target.value })} placeholder="tags, comma separated" />
          </div>
          <TextArea value={memoryForm.body} onChange={event => setMemoryForm({ ...memoryForm, body: event.target.value })} placeholder="What should be remembered?" required />
          <div className="flex items-center justify-between">
            <label className="flex items-center gap-2 text-[11px] text-ink-muted">
              <input type="checkbox" checked={memoryForm.pinned} onChange={event => setMemoryForm({ ...memoryForm, pinned: event.target.checked })} />
              Pin to the top
            </label>
            <div className="flex gap-1.5">
              {editingMemory ? <Button variant="ghost" onClick={() => { setEditingMemory(null); setMemoryForm({ title: '', body: '', tags: '', pinned: false }); }}>Cancel</Button> : null}
              <Button type="submit" disabled={busy !== null}>{editingMemory ? 'Save memory' : 'Remember this'}</Button>
            </div>
          </div>
        </form>
      </Card>

      <Card>
        <SectionTitle title="Work instructions" hint="Rules every agent follows on this project — read with each assignment." />
        {project.guidelines.length === 0 ? <Empty>No standing instructions yet.</Empty> : (
          <ol className="grid gap-2">
            {project.guidelines.map((entry, index) => (
              <li key={entry.id} className="rounded-xl border border-border-faint bg-white p-3">
                <div className="flex items-start justify-between gap-2">
                  <div className="min-w-0">
                    <p className="text-xs font-semibold text-ink">{index + 1}. {entry.title}</p>
                    <p className="mt-0.5 whitespace-pre-wrap text-xs leading-relaxed text-ink-muted">{entry.body}</p>
                  </div>
                  <div className="flex shrink-0 gap-1">
                    <Button variant="quiet" onClick={() => {
                      setEditingGuideline(entry.id);
                      setGuidelineForm({ title: entry.title, body: entry.body });
                    }}>Edit</Button>
                    <Button variant="danger" disabled={busy !== null}
                      onClick={() => void run('guideline', () => deleteGuideline(project.id, entry.id))}>×</Button>
                  </div>
                </div>
              </li>
            ))}
          </ol>
        )}
        <form className="mt-3 grid gap-2 rounded-xl border border-dashed border-border p-3"
          onSubmit={event => { event.preventDefault(); void saveGuidelineEntry(); }}>
          <Input value={guidelineForm.title} onChange={event => setGuidelineForm({ ...guidelineForm, title: event.target.value })} placeholder="Instruction title (e.g. Print specs)" maxLength={160} />
          <TextArea value={guidelineForm.body} onChange={event => setGuidelineForm({ ...guidelineForm, body: event.target.value })} placeholder="CMYK only, 300dpi, no bleed under 3mm." required />
          <div className="flex justify-end gap-1.5">
            {editingGuideline ? <Button variant="ghost" onClick={() => { setEditingGuideline(null); setGuidelineForm({ title: '', body: '' }); }}>Cancel</Button> : null}
            <Button type="submit" disabled={busy !== null}>{editingGuideline ? 'Save instruction' : 'Add instruction'}</Button>
          </div>
        </form>
      </Card>
    </div>
  );
}
