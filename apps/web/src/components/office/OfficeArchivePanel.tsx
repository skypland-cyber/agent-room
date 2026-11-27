// The record: meeting minutes that outlive their rooms, the deliverables those
// meetings produced, and the audit log of who changed what. All three are
// searchable because "what did we decide about the plaques in October" and
// "where is the file we sent them" are the same question asked twice.
import { useEffect, useState } from 'react';
import type { OfficeArchive, OfficeAuditEntry } from '@agent-room/shared';
import {
  getArchive, listArchives, listAudit, listDeliverables,
  type ArchiveSummary, type DeliverableEntry,
} from '../../lib/officeApi.js';
import { Badge, Button, Card, Empty, ErrorNote, Input, SectionTitle, formatDate, timeAgo, useOfficeAction } from './ui.js';
import { useI18n, type MessageKey } from '../../i18n/index.js';
import { auditActionLabel } from '../../i18n/labels.js';

interface Props {
  onChanged: () => void;
}

const ACTION_TONES: Array<{ labelKey: MessageKey; value: string }> = [
  { labelKey: 'record.filter.all', value: '' },
  { labelKey: 'record.filter.login', value: 'login' },
  { labelKey: 'record.filter.staff', value: 'agent.' },
  { labelKey: 'record.filter.tasks', value: 'task.' },
  { labelKey: 'record.filter.files', value: 'file.' },
  { labelKey: 'record.filter.projects', value: 'project.' },
  { labelKey: 'record.filter.backup', value: 'backup.' },
];

/** KB, or MB once a file is big enough that whole kilobytes stop helping. */
function sizeLabel(bytes: number): string {
  const kb = Math.max(1, Math.round((Number(bytes) || 0) / 1024));
  return kb >= 1024 ? `${(kb / 1024).toFixed(1)} MB` : `${kb} KB`;
}

export function OfficeArchivePanel({ onChanged }: Props) {
  const { t } = useI18n();
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<ArchiveSummary[]>([]);
  const [selected, setSelected] = useState<OfficeArchive | null>(null);
  const [searching, setSearching] = useState(false);
  const [auditAction, setAuditAction] = useState('');
  const [auditActor, setAuditActor] = useState('');
  const [entries, setEntries] = useState<OfficeAuditEntry[]>([]);
  const [files, setFiles] = useState<DeliverableEntry[]>([]);
  /** The selected archive's own deliverables, with links minted for this read. */
  const [selectedFiles, setSelectedFiles] = useState<DeliverableEntry[]>([]);
  const [fileQuery, setFileQuery] = useState('');
  const [fileSearching, setFileSearching] = useState(false);
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

  const searchFiles = async (value: string) => {
    setFileSearching(true);
    try {
      const found = await listDeliverables({ query: value, limit: 100 });
      setFiles(found.files);
    } finally {
      setFileSearching(false);
    }
  };

  useEffect(() => { void search(''); void searchFiles(''); }, []);

  useEffect(() => {
    void listAudit({ ...(auditAction ? { action: auditAction } : {}), ...(auditActor ? { actor: auditActor } : {}), limit: 100 })
      .then(setEntries)
      .catch(() => setEntries([]));
  }, [auditAction, auditActor]);

  const open = async (id: string) => {
    // One archive at a time: its minutes, and the files it kept, read together
    // so the detail view never borrows a link from a list that may not hold it.
    const [archive, own] = await Promise.all([
      getArchive(id),
      listDeliverables({ archiveId: id, limit: 200 }).then(result => result.files).catch(() => []),
    ]);
    setSelected(archive);
    setSelectedFiles(own);
  };

  return (
    <div className="grid gap-5">
      <Card>
        <SectionTitle
          title={t('record.files.title')}
          hint={t('record.files.hint')}
          action={<Badge tone="info">{t('record.files.count', { count: files.length })}</Badge>}
        />
        <form className="flex gap-2" onSubmit={event => { event.preventDefault(); void searchFiles(fileQuery); }}>
          <Input value={fileQuery} onChange={event => setFileQuery(event.target.value)} placeholder={t('record.files.placeholder')} />
          <Button type="submit" disabled={fileSearching}>{fileSearching ? t('record.archive.searching') : t('common.search')}</Button>
        </form>
        {files.length === 0 ? (
          <div className="mt-3"><Empty>{t('record.files.empty')}</Empty></div>
        ) : (
          <ul className="mt-3 grid max-h-[320px] gap-1.5 overflow-y-auto pr-1 sm:grid-cols-2">
            {files.map(file => (
              <li key={`${file.roomCode}-${file.id}`} className="rounded-xl border border-border-faint bg-white px-3 py-2">
                <div className="flex items-start justify-between gap-2">
                  <div className="min-w-0">
                    <p className="truncate text-xs font-semibold text-ink">{file.name}</p>
                    <p className="font-mono text-[10px] text-ink-faint">
                      {file.version > 1 ? `v${file.version} · ` : ''}{sizeLabel(file.size)}
                      {file.producer ? ` · ${file.producer}` : ''}
                    </p>
                    <a href={`/r/${file.roomCode}`} className="text-[10px] text-ink-faint hover:text-ink">{file.topic}</a>
                  </div>
                  {file.downloadUrl ? (
                    <a href={file.downloadUrl} target="_blank" rel="noreferrer"
                      className="shrink-0 rounded-lg border border-border bg-white px-2 py-1 text-[11px] font-semibold text-ink-muted transition hover:text-ink">
                      {t('record.files.download')}
                    </a>
                  ) : null}
                </div>
              </li>
            ))}
          </ul>
        )}
      </Card>

      <div className="grid gap-5 lg:grid-cols-[1.15fr_1fr]">
        <Card>
          <SectionTitle
            title={t('record.archive.title')}
            hint={t('record.archive.hint')}
          />
          <form
            className="flex gap-2"
            onSubmit={event => { event.preventDefault(); void search(query); }}
          >
            <Input value={query} onChange={event => setQuery(event.target.value)} placeholder={t('record.archive.placeholder')} />
            <Button type="submit" disabled={searching}>{searching ? t('record.archive.searching') : t('common.search')}</Button>
          </form>
          <ErrorNote error={error} />
          {results.length === 0 ? (
            <div className="mt-3"><Empty>{query ? t('record.archive.emptyMatch', { query }) : t('record.archive.emptyAll')}</Empty></div>
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
                    <p className="mt-0.5 font-mono text-[10px] text-ink-faint">
                      {archive.roomCode} · {t('record.archive.messages', { count: archive.messageCount })}
                      {archive.deliverableCount ? ` · ${t('record.files.count', { count: archive.deliverableCount })}` : ''}
                    </p>
                  </button>
                </li>
              ))}
            </ul>
          )}

          {selected ? (
            <div className="mt-4 rounded-xl border border-border bg-surface-soft p-3">
              <div className="flex items-center justify-between gap-2">
                <h3 className="text-xs font-semibold text-ink">{selected.topic} · {selected.roomCode}</h3>
                <Button variant="quiet" onClick={() => setSelected(null)}>{t('common.close')}</Button>
              </div>
              {selected.successorRoomCode ? (
                <p className="mt-1 text-[11px] text-ink-soft">
                  <a href={`/r/${selected.successorRoomCode}`} className="hover:text-ink">
                    {t('work.room.handedOff', { code: selected.successorRoomCode })}
                  </a>
                </p>
              ) : null}
              {selectedFiles.length > 0 ? (
                <ul className="mt-2 grid gap-1">
                  {selectedFiles.map(file => (
                    <li key={file.id} className="flex items-center justify-between gap-2 rounded-lg bg-white px-2 py-1.5">
                      <span className="min-w-0 truncate text-[11px] text-ink">
                        {file.name}{file.version > 1 ? ` · v${file.version}` : ''} <span className="text-ink-faint">{sizeLabel(file.size)}</span>
                      </span>
                      {file.downloadUrl ? (
                        <a href={file.downloadUrl} target="_blank" rel="noreferrer"
                          className="shrink-0 text-[11px] font-semibold text-ink-muted hover:text-ink">{t('record.files.download')}</a>
                      ) : null}
                    </li>
                  ))}
                </ul>
              ) : (selected.deliverables ?? []).length === 0 ? (
                <p className="mt-1 text-[11px] text-ink-faint">{t('record.files.none')}</p>
              ) : null}
              <pre className="mt-2 max-h-[360px] overflow-auto whitespace-pre-wrap rounded-lg bg-white p-3 text-[11px] leading-relaxed text-ink-muted">
                {selected.minutes}
              </pre>
            </div>
          ) : null}
        </Card>

        <Card>
          <SectionTitle
            title={t('record.audit.title')}
            hint={t('record.audit.hint')}
            action={<Button variant="ghost" disabled={busy !== null} onClick={() => void run('reload', () => listAudit({ limit: 100 }))}>{t('record.audit.refresh')}</Button>}
          />
          <div className="mb-3 flex flex-wrap gap-1.5">
            {ACTION_TONES.map(tab => (
              <button key={tab.value} type="button" onClick={() => setAuditAction(tab.value)}
                className={`rounded-full px-2.5 py-1 text-[11px] font-semibold transition ${
                  auditAction === tab.value ? 'bg-ink text-white' : 'bg-surface-sunken text-ink-muted hover:text-ink'
                }`}>
                {t(tab.labelKey)}
              </button>
            ))}
          </div>
          <Input value={auditActor} onChange={event => setAuditActor(event.target.value)} placeholder={t('record.audit.actorPlaceholder')} className="!py-1.5 !text-xs" />
          <ul className="mt-3 max-h-[520px] divide-y divide-border-faint overflow-y-auto pr-1">
            {entries.length === 0 ? <Empty>{t('record.audit.empty')}</Empty> : entries.map(entry => (
              <li key={entry.id} className="py-2">
                <div className="flex flex-wrap items-center gap-2">
                  <Badge tone={entry.action.startsWith('task.') ? 'warn' : entry.action.startsWith('backup.') ? 'bad' : 'neutral'}>
                    {auditActionLabel(entry.action)}
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
    </div>
  );
}
