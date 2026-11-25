// The record: meeting minutes that outlive their rooms, and the audit log of
// who changed what. Both are searchable because "what did we decide about the
// plaques in October" is the question this screen exists to answer.
import { useEffect, useState } from 'react';
import type { OfficeArchive, OfficeAuditEntry } from '@agent-room/shared';
import { getArchive, listArchives, listAudit, type ArchiveSummary } from '../../lib/officeApi.js';
import { Badge, Button, Card, Empty, ErrorNote, Input, SectionTitle, formatDate, timeAgo, useOfficeAction } from './ui.js';

interface Props {
  onChanged: () => void;
}

const ACTION_TONES: Array<{ label: string; value: string; tone: 'neutral' | 'info' | 'warn' | 'bad' }> = [
  { label: 'Everything', value: '', tone: 'neutral' },
  { label: 'Sign-ins', value: 'login', tone: 'info' },
  { label: 'Staff', value: 'agent.', tone: 'info' },
  { label: 'Tasks', value: 'task.', tone: 'warn' },
  { label: 'Files', value: 'file.', tone: 'info' },
  { label: 'Projects', value: 'project.', tone: 'info' },
  { label: 'Backup & settings', value: 'backup.', tone: 'bad' },
];

export function OfficeArchivePanel({ onChanged }: Props) {
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<ArchiveSummary[]>([]);
  const [selected, setSelected] = useState<OfficeArchive | null>(null);
  const [searching, setSearching] = useState(false);
  const [auditAction, setAuditAction] = useState('');
  const [auditActor, setAuditActor] = useState('');
  const [entries, setEntries] = useState<OfficeAuditEntry[]>([]);
  const { busy, error, run } = useOfficeAction(onChanged);

  const search = async (value: string) => {
    setSearching(true);
    try {
      const found = await listArchives(value);
      setResults(found);
    } finally {
      setSearching(false);
    }
  };

  useEffect(() => { void search(''); }, []);

  useEffect(() => {
    void listAudit({ ...(auditAction ? { action: auditAction } : {}), ...(auditActor ? { actor: auditActor } : {}), limit: 100 })
      .then(setEntries)
      .catch(() => setEntries([]));
  }, [auditAction, auditActor]);

  const open = async (id: string) => {
    const archive = await getArchive(id);
    setSelected(archive);
  };

  return (
    <div className="grid gap-5 lg:grid-cols-[1.15fr_1fr]">
      <Card>
        <SectionTitle
          title="Meeting archive"
          hint="Every ended meeting is kept forever, with its transcript and board. Search reaches the words spoken, not just the topic."
        />
        <form
          className="flex gap-2"
          onSubmit={event => { event.preventDefault(); void search(query); }}
        >
          <Input value={query} onChange={event => setQuery(event.target.value)} placeholder="Search minutes — e.g. plaques, 견적, Prime Gift" />
          <Button type="submit" disabled={searching}>{searching ? 'Searching…' : 'Search'}</Button>
        </form>
        <ErrorNote error={error} />
        {results.length === 0 ? (
          <div className="mt-3"><Empty>{query ? `No minutes match “${query}”.` : 'No archived meetings yet. Ending a room archives it automatically.'}</Empty></div>
        ) : (
          <ul className="mt-3 grid max-h-[320px] gap-1.5 overflow-y-auto pr-1">
            {results.map(archive => (
              <li key={archive.id}>
                <button type="button" onClick={() => void open(archive.id)}
                  className={`w-full rounded-xl border px-3 py-2 text-left transition ${
                    selected?.id === archive.id ? 'border-accent-tint-border bg-accent-tint/40' : 'border-border-faint bg-white hover:bg-surface-soft'
                  }`}>
                  <div className="flex items-center justify-between gap-2">
                    <span className="truncate text-xs font-semibold text-ink">{archive.topic}</span>
                    <span className="shrink-0 text-[10px] text-ink-faint">{formatDate(archive.archivedAt)}</span>
                  </div>
                  <p className="mt-0.5 line-clamp-2 text-[11px] leading-relaxed text-ink-soft">{archive.snippet}</p>
                  <p className="mt-0.5 font-mono text-[10px] text-ink-faint">{archive.roomCode} · {archive.messageCount} messages</p>
                </button>
              </li>
            ))}
          </ul>
        )}

        {selected ? (
          <div className="mt-4 rounded-xl border border-border bg-surface-soft p-3">
            <div className="flex items-center justify-between gap-2">
              <h3 className="text-xs font-semibold text-ink">{selected.topic} · {selected.roomCode}</h3>
              <Button variant="quiet" onClick={() => setSelected(null)}>Close</Button>
            </div>
            <pre className="mt-2 max-h-[360px] overflow-auto whitespace-pre-wrap rounded-lg bg-white p-3 text-[11px] leading-relaxed text-ink-muted">
              {selected.minutes}
            </pre>
          </div>
        ) : null}
      </Card>

      <Card>
        <SectionTitle
          title="Work log"
          hint="Who did what, when. Append-only; the newest 1,000 entries are kept."
          action={<Button variant="ghost" disabled={busy !== null} onClick={() => void run('reload', () => listAudit({ limit: 100 }))}>Refresh</Button>}
        />
        <div className="mb-3 flex flex-wrap gap-1.5">
          {ACTION_TONES.map(tab => (
            <button key={tab.value} type="button" onClick={() => setAuditAction(tab.value)}
              className={`rounded-full px-2.5 py-1 text-[11px] font-semibold transition ${
                auditAction === tab.value ? 'bg-ink text-white' : 'bg-surface-sunken text-ink-muted hover:text-ink'
              }`}>
              {tab.label}
            </button>
          ))}
        </div>
        <Input value={auditActor} onChange={event => setAuditActor(event.target.value)} placeholder="Filter by who (e.g. owner, Qwen)" className="!py-1.5 !text-xs" />
        <ul className="mt-3 max-h-[520px] divide-y divide-border-faint overflow-y-auto pr-1">
          {entries.length === 0 ? <Empty>No entries for this filter.</Empty> : entries.map(entry => (
            <li key={entry.id} className="py-2">
              <div className="flex flex-wrap items-center gap-2">
                <Badge tone={entry.action.startsWith('task.') ? 'warn' : entry.action.startsWith('backup.') ? 'bad' : 'neutral'}>
                  {entry.action}
                </Badge>
                <span className="text-[11px] font-semibold text-ink">{entry.actor.name}</span>
                {entry.target ? <span className="font-mono text-[10px] text-ink-faint">{entry.target}</span> : null}
                {entry.roomCode ? <a href={`/r/${entry.roomCode}`} className="font-mono text-[10px] text-ink-faint hover:text-ink">{entry.roomCode}</a> : null}
                <span className="ml-auto text-[10px] text-ink-faint" title={new Date(entry.at).toISOString()}>{timeAgo(entry.at)}</span>
              </div>
              {entry.detail ? <p className="mt-0.5 text-[11px] leading-relaxed text-ink-soft">{entry.detail}</p> : null}
            </li>
          ))}
        </ul>
      </Card>
    </div>
  );
}
