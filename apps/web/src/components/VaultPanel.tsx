// The room's file shelf: materials on one side, deliverables on the other.
//
// The two look the same because they behave the same — folders, tags, search,
// versions, preview, download — and differ only in lifetime and authorship,
// which is exactly what the version chip, the producer line and the "keep after
// the meeting" note state. One component, one interaction model, so a person who
// has learned one has learned both.
//
// Drag-and-drop is here because a meeting's material arrives as a handful of
// files from a desktop folder, and "choose file" five times is the step where
// people give up. Dropping anywhere on the panel uploads to the open tab.

import { useCallback, useEffect, useRef, useState, type DragEvent } from 'react';
import type { VaultFile, VaultFolder, VaultUsage } from '@agent-room/shared';
import {
  formatVaultBytes,
  vaultExtension,
  vaultMatchSnippet,
  vaultPreviewKind,
  vaultVersionLabel,
} from '@agent-room/shared';
import {
  createVaultFolder,
  deleteVaultFile,
  deleteVaultFolder,
  fetchVaultText,
  listVault,
  updateVaultFile,
  uploadVaultFile,
  uploadVaultVersion,
  VaultError,
  type VaultKind,
  type VaultRow,
} from '../lib/vaultApi.js';
import { LanguageToggle } from './LanguageToggle.js';
import { t as translate, useI18n } from '../i18n/index.js';
import { errorText } from '../i18n/errors.js';

interface Props {
  code: string;
  me: { name: string };
  isHost: boolean;
  ended: boolean;
  /** Show one task's files only (opened from the board). */
  taskFilter?: string;
  onClearTaskFilter?: () => void;
  /** Drops a line into the room composer so a person can ask an agent about a file. */
  onMention?: (text: string) => void;
}

const EMPTY_USAGE: VaultUsage = {
  code: '',
  bytes: 0,
  limitBytes: 1,
  materials: { files: 0, bytes: 0 },
  deliverables: { files: 0, bytes: 0 },
};

const CATEGORY_ICON: Record<string, string> = {
  document: '📄', spreadsheet: '📊', presentation: '📽', pdf: '📕', image: '🖼', video: '🎬',
  audio: '🎵', code: '🧩', archive: '🗜', data: '🧾', text: '📝', other: '📎',
};

/** "3분 전" / "3m ago" — the shelf's own relative clock. */
function relativeTime(at: number): string {
  const diff = Date.now() - at;
  const minute = 60_000;
  if (!Number.isFinite(diff) || diff < minute) return translate('time.justNow');
  const minutes = Math.round(diff / minute);
  if (minutes < 60) return translate('time.minutesAgo', { count: minutes });
  const hours = Math.round(minutes / 60);
  if (hours < 24) return translate('time.hoursAgo', { count: hours });
  return translate('time.daysAgo', { count: Math.round(hours / 24) });
}

export function VaultPanel({ code, me, isHost, ended, taskFilter, onClearTaskFilter, onMention }: Props) {
  const { t } = useI18n();
  const [kind, setKind] = useState<VaultKind>('material');
  const [files, setFiles] = useState<VaultRow[]>([]);
  const [folders, setFolders] = useState<VaultFolder[]>([]);
  const [usage, setUsage] = useState<VaultUsage>(EMPTY_USAGE);
  const [folderId, setFolderId] = useState<string | null>(null);
  const [query, setQuery] = useState('');
  const [searching, setSearching] = useState(false);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [dragActive, setDragActive] = useState(false);
  const [creatingFolder, setCreatingFolder] = useState(false);
  const [folderName, setFolderName] = useState('');
  const [preview, setPreview] = useState<VaultRow | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const versionInputRef = useRef<HTMLInputElement>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const result = await listVault(code, kind, {
        ...(taskFilter ? { taskId: taskFilter } : {}),
        ...(folderId ? { folderId } : {}),
        ...(query.trim() ? { query: query.trim() } : {}),
      });
      setFiles(result.files ?? []);
      setFolders(result.folders ?? []);
      setUsage(result.usage ?? EMPTY_USAGE);
      setError(null);
    } catch (e) {
      setError(e);
    } finally {
      setLoading(false);
    }
  }, [code, kind, folderId, query, taskFilter]);

  useEffect(() => { void load(); }, [load]);

  // Search is a server round trip; wait for the typing to settle.
  useEffect(() => {
    if (!query.trim()) return;
    setSearching(true);
    const timer = setTimeout(() => setSearching(false), 400);
    return () => clearTimeout(timer);
  }, [query]);

  const tabFiles = files;
  const usedPercent = usage.limitBytes > 0 ? Math.min(100, Math.round((usage.bytes / usage.limitBytes) * 100)) : 0;
  const errorMessage = errorText(error);

  async function handleUpload(list: FileList | File[]) {
    if (ended) return;
    const incoming = Array.from(list);
    if (incoming.length === 0) return;
    setBusy(t('vault.uploading', { count: incoming.length }));
    setError(null);
    const failures: string[] = [];
    for (const file of incoming) {
      try {
        const saved = await uploadVaultFile(code, kind, file, {
          ...(folderId ? { folderId } : {}),
          ...(taskFilter ? { taskId: taskFilter } : {}),
          producer: kind === 'deliverable' ? me.name : undefined,
        });
        setFiles(previous => [saved, ...previous]);
      } catch (e) {
        failures.push(e instanceof VaultError ? errorText(e) ?? e.message : t('vault.uploadFailed', { name: file.name }));
      }
    }
    if (failures.length > 0) setError(failures.join(' · '));
    setBusy(null);
    void load();
  }

  async function handleNewVersion(file: VaultRow, chosen: File) {
    setBusy(t('vault.uploadingVersion', { label: vaultVersionLabel(file.version + 1) }));
    try {
      const revised = await uploadVaultVersion(code, file.id, chosen);
      setFiles(previous => previous.map(item => (item.id === revised.id ? revised : item)));
      setPreview(revised);
    } catch (e) {
      setError(e);
    } finally {
      setBusy(null);
    }
  }

  async function handleDelete(file: VaultRow) {
    if (!window.confirm(t('vault.deleteConfirm', { name: file.name }))) return;
    setBusy(t('vault.deleting', { name: file.name }));
    try {
      await deleteVaultFile(code, file.id);
      setFiles(previous => previous.filter(item => item.id !== file.id));
      if (preview?.id === file.id) setPreview(null);
      void load();
    } catch (e) {
      setError(e);
    } finally {
      setBusy(null);
    }
  }

  async function handleCreateFolder() {
    const name = folderName.trim();
    if (!name) { setCreatingFolder(false); return; }
    try {
      const { folder } = await createVaultFolder(code, name);
      setFolders(previous => [...previous, folder].sort((a, b) => a.name.localeCompare(b.name)));
      setFolderId(folder.id);
      setFolderName('');
      setCreatingFolder(false);
    } catch (e) {
      setError(e);
    }
  }

  async function handleDeleteFolder(folder: VaultFolder) {
    if (!window.confirm(t('vault.folder.removeConfirm', { name: folder.name }))) return;
    try {
      await deleteVaultFolder(code, folder.id);
      setFolders(previous => previous.filter(item => item.id !== folder.id));
      if (folderId === folder.id) setFolderId(null);
      void load();
    } catch (e) {
      setError(e);
    }
  }

  const onDrop = (event: DragEvent<HTMLDivElement>) => {
    event.preventDefault();
    setDragActive(false);
    if (event.dataTransfer?.files?.length) void handleUpload(event.dataTransfer.files);
  };

  return (
    <div
      className={`relative flex min-h-0 min-w-0 flex-1 flex-col ${dragActive ? 'ring-2 ring-inset ring-accent' : ''}`}
      onDragEnter={event => { event.preventDefault(); if (!ended) setDragActive(true); }}
      onDragOver={event => { event.preventDefault(); }}
      onDragLeave={event => { if (event.currentTarget === event.target) setDragActive(false); }}
      onDrop={onDrop}
    >
      {dragActive && (
        <div className="pointer-events-none absolute inset-2 z-20 flex items-center justify-center rounded-lg border-2 border-dashed border-accent bg-surface/90 text-sm font-semibold text-accent">
          {t('vault.drop', { kind: kind === 'material' ? t('vault.tab.material') : t('vault.tab.deliverable') })}
        </div>
      )}

      <div className="shrink-0 border-b border-border-faint bg-surface p-3 sm:p-4">
        <div className="flex items-center justify-between gap-2">
          <div className="min-w-0">
            <div className="text-sm font-semibold text-ink">{t('vault.title')}</div>
            <div className="text-[10px] text-ink-soft">
              {kind === 'material' ? t('vault.materialHint') : t('vault.deliverableHint')}
            </div>
          </div>
          <LanguageToggle />
          <button
            type="button"
            onClick={() => fileInputRef.current?.click()}
            disabled={ended || busy !== null}
            className="min-h-9 rounded-lg bg-accent px-3 text-[12px] font-semibold text-white shadow-sm transition active:scale-[0.98] disabled:opacity-50"
          >
            {t('vault.upload')}
          </button>
          <input
            ref={fileInputRef}
            type="file"
            multiple
            className="hidden"
            onChange={event => { if (event.target.files) void handleUpload(event.target.files); event.target.value = ''; }}
          />
        </div>

        <div className="mt-2.5 grid grid-cols-2 gap-1 rounded-lg bg-surface-softer p-1" role="tablist" aria-label={t('vault.tabs.aria')}>
          {([['material', 'vault.tab.material', usage.materials.files], ['deliverable', 'vault.tab.deliverable', usage.deliverables.files]] as const).map(([key, labelKey, count]) => (
            <button
              key={key}
              type="button"
              role="tab"
              aria-selected={kind === key}
              onClick={() => { setKind(key); setFolderId(null); }}
              className={`min-h-8 rounded-md text-[12px] font-semibold transition ${kind === key ? 'bg-surface text-ink shadow-sm' : 'text-ink-muted hover:text-ink'}`}
            >
              {t(labelKey)}
              <span className={`ml-1.5 rounded-full px-1.5 py-0.5 text-[10px] ${kind === key ? 'bg-accent-tint text-accent' : 'bg-surface-sunken text-ink-faint'}`}>{count}</span>
            </button>
          ))}
        </div>

        <div className="mt-2.5 flex items-center gap-2">
          <input
            value={query}
            onChange={event => setQuery(event.target.value)}
            placeholder={t('vault.search')}
            className="min-h-8 w-full rounded-lg border border-border bg-white px-2.5 text-[12px] text-ink outline-none focus:border-accent focus:ring-2 focus:ring-accent-tint"
          />
          {query && (
            <button type="button" onClick={() => setQuery('')} className="text-[11px] font-semibold text-ink-soft">{t('vault.clear')}</button>
          )}
        </div>

        <div className="mt-2">
          <div className="flex items-center justify-between text-[10px] text-ink-soft">
            <span>
              {busy ?? (searching ? t('vault.searching') : t('vault.fileCount', { count: tabFiles.length }))}
            </span>
            <span>{t('vault.of', { used: formatVaultBytes(usage.bytes), limit: formatVaultBytes(usage.limitBytes) })}</span>
          </div>
          <div className="mt-1 h-1 overflow-hidden rounded-full bg-surface-sunken">
            <div className={`h-full rounded-full ${usedPercent > 90 ? 'bg-rose-500' : 'bg-accent'}`} style={{ width: `${usedPercent}%` }} />
          </div>
        </div>

        {taskFilter && (
          <div className="mt-2 flex items-center justify-between rounded-md border border-accent-tint-border bg-accent-tint px-2 py-1 text-[11px] font-semibold text-accent">
            <span>{t('vault.taskFilter', { id: taskFilter })}</span>
            <button type="button" onClick={onClearTaskFilter} className="underline">{t('vault.showAll')}</button>
          </div>
        )}

        <div className="mt-2 flex flex-wrap items-center gap-1.5">
          <button
            type="button"
            onClick={() => setFolderId(null)}
            className={`rounded-full px-2.5 py-1 text-[11px] font-semibold ${folderId === null ? 'bg-accent-tint text-accent' : 'bg-surface-softer text-ink-muted'}`}
          >
            {t('vault.folder.all')}
          </button>
          {folders.map(folder => (
            <span key={folder.id} className="group inline-flex items-center">
              <button
                type="button"
                onClick={() => setFolderId(folder.id)}
                className={`rounded-l-full px-2.5 py-1 text-[11px] font-semibold ${folderId === folder.id ? 'bg-accent-tint text-accent' : 'bg-surface-softer text-ink-muted'}`}
              >
                {folder.name}
              </button>
              {isHost && !ended && (
                <button
                  type="button"
                  title={t('vault.folder.remove', { name: folder.name })}
                  onClick={() => void handleDeleteFolder(folder)}
                  className="rounded-r-full bg-surface-softer px-1.5 py-1 text-[10px] text-ink-faint hover:text-rose-600"
                >
                  ×
                </button>
              )}
            </span>
          ))}
          {!ended && (creatingFolder ? (
            <input
              autoFocus
              value={folderName}
              onChange={event => setFolderName(event.target.value)}
              onBlur={() => void handleCreateFolder()}
              onKeyDown={event => {
                if (event.key === 'Enter') void handleCreateFolder();
                if (event.key === 'Escape') { setCreatingFolder(false); setFolderName(''); }
              }}
              placeholder={t('vault.folder.name')}
              className="w-28 rounded-full border border-border px-2.5 py-1 text-[11px] outline-none focus:border-accent"
            />
          ) : (
            <button
              type="button"
              onClick={() => setCreatingFolder(true)}
              className="rounded-full border border-dashed border-border px-2.5 py-1 text-[11px] font-semibold text-ink-soft hover:border-accent hover:text-accent"
            >
              {t('vault.folder.new')}
            </button>
          ))}
        </div>
      </div>

      {errorMessage && (
        <div className="shrink-0 border-b border-rose-200 bg-rose-50 px-3 py-2 text-[11px] font-semibold text-rose-800">
          {errorMessage}
        </div>
      )}

      <div className="min-h-0 flex-1 overflow-y-auto p-2.5 sm:p-3">
        {loading && tabFiles.length === 0 ? (
          <div className="p-6 text-center text-[12px] text-ink-soft">{t('vault.loading')}</div>
        ) : tabFiles.length === 0 ? (
          <div className="m-auto max-w-[16rem] px-2 py-8 text-center">
            <div className="text-2xl">{kind === 'material' ? '📎' : '🗂'}</div>
            <div className="mt-2 text-[13px] font-semibold text-ink">
              {query
                ? t('vault.empty.matched')
                : kind === 'material' ? t('vault.empty.none') : t('vault.empty.noneDeliverable')}
            </div>
            <p className="mt-1.5 text-[11px] leading-relaxed text-ink-soft">
              {query
                ? t('vault.empty.searchHint')
                : kind === 'material'
                  ? t('vault.empty.materialHint')
                  : t('vault.empty.deliverableHint')}
            </p>
            {!query && !ended && (
              <button
                type="button"
                onClick={() => fileInputRef.current?.click()}
                className="mt-3 min-h-9 rounded-lg bg-accent px-3 text-[12px] font-semibold text-white"
              >
                {t('vault.uploadFile')}
              </button>
            )}
          </div>
        ) : (
          <ul className="space-y-1.5">
            {tabFiles.map(file => (
              <li key={file.id}>
                <button
                  type="button"
                  onClick={() => setPreview(file)}
                  className="w-full rounded-lg border border-border-faint bg-surface px-2.5 py-2 text-left transition hover:border-accent/40 hover:bg-accent-tint/30"
                >
                  <div className="flex items-start gap-2">
                    <span className="mt-0.5 text-base leading-none">{CATEGORY_ICON[file.category] ?? '📎'}</span>
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-1.5">
                        <span className="truncate text-[12.5px] font-semibold text-ink">{file.name}</span>
                        <span className="shrink-0 rounded bg-surface-sunken px-1 py-0.5 text-[9px] font-bold text-ink-muted">{vaultVersionLabel(file.version)}</span>
                      </div>
                      <div className="mt-0.5 flex flex-wrap items-center gap-x-1.5 gap-y-0.5 text-[10px] text-ink-soft">
                        <span>{formatVaultBytes(file.size)}</span>
                        <span>·</span>
                        <span>{file.kind === 'deliverable' ? (file.producer ?? file.uploadedBy) : file.uploadedBy}</span>
                        <span>· {relativeTime(file.updatedAt)}</span>
                        {file.taskId && <span className="rounded bg-accent-tint px-1 font-semibold text-accent">{file.taskId}</span>}
                      </div>
                      {file.description && <div className="mt-0.5 truncate text-[10.5px] text-ink-muted">{file.description}</div>}
                      {query && vaultMatchSnippet({ ...file, extractedText: undefined } as VaultFile, query) && (
                        <div className="mt-0.5 truncate text-[10.5px] italic text-ink-faint">{vaultMatchSnippet({ ...file, extractedText: undefined } as VaultFile, query)}</div>
                      )}
                      {file.tags.length > 0 && (
                        <div className="mt-1 flex flex-wrap gap-1">
                          {file.tags.map(tag => (
                            <span key={tag} className="rounded-full bg-surface-softer px-1.5 py-0.5 text-[9.5px] font-semibold text-ink-muted">{tag}</span>
                          ))}
                        </div>
                      )}
                    </div>
                  </div>
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>

      {preview && (
        <VaultPreview
          key={preview.id}
          file={preview}
          code={code}
          me={me}
          isHost={isHost}
          ended={ended}
          folders={folders}
          onClose={() => setPreview(null)}
          onDelete={() => void handleDelete(preview)}
          onNewVersion={file => versionInputRef.current?.click()}
          onSaved={updated => {
            setPreview(updated);
            setFiles(previous => previous.map(item => (item.id === updated.id ? updated : item)));
          }}
          onMention={onMention}
          versionInputRef={versionInputRef}
          onVersionChosen={file => void handleNewVersion(preview, file)}
        />
      )}
    </div>
  );
}

// ─── Preview ─────────────────────────────────────────────────────────────

interface PreviewProps {
  file: VaultRow;
  code: string;
  me: { name: string };
  isHost: boolean;
  ended: boolean;
  folders: VaultFolder[];
  onClose: () => void;
  onDelete: () => void;
  onNewVersion: (file: VaultRow) => void;
  onSaved: (file: VaultRow) => void;
  onMention?: (text: string) => void;
  versionInputRef: React.RefObject<HTMLInputElement>;
  onVersionChosen: (file: File) => void;
}

/**
 * One file, opened.
 *
 * Rendering happens through the same signed URL the download uses, with
 * `inline`, so an image or a PDF is shown by the browser's own viewer instead of
 * being re-implemented here. Text is fetched and displayed as text — that is the
 * only way a person can check what an agent will read.
 */
function VaultPreview({
  file, me, isHost, ended, folders, onClose, onDelete, onNewVersion, onSaved, onMention,
  versionInputRef, onVersionChosen,
}: PreviewProps) {
  const { t } = useI18n();
  const kind = vaultPreviewKind(file.mime, file.name);
  const [text, setText] = useState<string | null>(null);
  const [textError, setTextError] = useState<string | null>(null);
  const [description, setDescription] = useState(file.description ?? '');
  const [tags, setTags] = useState(file.tags.join(', '));
  const [folderId, setFolderId] = useState(file.folderId ?? '');
  const [saving, setSaving] = useState(false);
  const canEdit = !ended && (isHost || file.uploadedBy === me.name || file.producer === me.name);

  useEffect(() => {
    let cancelled = false;
    setText(null);
    setTextError(null);
    if (kind === 'text' || kind === 'code' || kind === 'markdown') {
      fetchVaultText(file.previewUrl)
        .then(value => { if (!cancelled) setText(value); })
        .catch((e: unknown) => { if (!cancelled) setTextError(errorText(e) ?? translate('vault.preview.textFailed')); });
    }
    return () => { cancelled = true; };
  }, [file.id, file.previewUrl, kind]);

  async function saveMeta() {
    setSaving(true);
    try {
      const { file: updated } = await updateVaultFile(file.code, file.id, {
        description,
        tags: tags.split(',').map(tag => tag.trim()).filter(Boolean),
        folderId: folderId || null,
      });
      if (updated) onSaved(updated);
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="absolute inset-0 z-30 flex flex-col bg-ink/40 p-2 sm:p-3" role="dialog" aria-modal="true" aria-label={file.name}>
      <div className="flex min-h-0 flex-1 flex-col overflow-hidden rounded-xl bg-surface shadow-card">
        <div className="flex shrink-0 items-start justify-between gap-2 border-b border-border-faint p-3">
          <div className="min-w-0">
            <div className="flex items-center gap-1.5">
              <span>{CATEGORY_ICON[file.category] ?? '📎'}</span>
              <h3 className="truncate text-[13px] font-semibold text-ink">{file.name}</h3>
              <span className="rounded bg-surface-sunken px-1 py-0.5 text-[9px] font-bold text-ink-muted">{vaultVersionLabel(file.version)}</span>
            </div>
            <div className="mt-0.5 text-[10px] text-ink-soft">
              {formatVaultBytes(file.size)} · {file.kind === 'deliverable' ? (file.producer ?? file.uploadedBy) : file.uploadedBy}
              {file.taskId ? ` · ${file.taskId}` : ''} · {vaultExtension(file.name).toUpperCase() || file.mime}
            </div>
          </div>
          <button type="button" onClick={onClose} className="rounded-lg px-2 py-1 text-[12px] font-semibold text-ink-soft hover:bg-surface-softer">{t('vault.preview.close')}</button>
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto p-3">
          {kind === 'image' && file.previewUrl && (
            <img src={file.previewUrl} alt={file.name} className="mx-auto max-h-[46vh] rounded-lg object-contain" />
          )}
          {kind === 'pdf' && file.previewUrl && (
            <iframe title={file.name} src={file.previewUrl} className="h-[52vh] w-full rounded-lg border border-border-faint" />
          )}
          {kind === 'video' && file.previewUrl && (
            <video controls src={file.previewUrl} className="mx-auto max-h-[46vh] w-full rounded-lg" />
          )}
          {kind === 'audio' && file.previewUrl && (
            <audio controls src={file.previewUrl} className="w-full" />
          )}
          {(kind === 'text' || kind === 'code' || kind === 'markdown') && (
            <div className="rounded-lg border border-border-faint bg-surface-softer">
              {textError ? (
                <div className="p-3 text-[11px] text-rose-700">{textError}</div>
              ) : text === null ? (
                <div className="p-3 text-[11px] text-ink-soft">{t('vault.preview.reading')}</div>
              ) : (
                <pre className={`max-h-[46vh] overflow-auto p-3 text-[11px] leading-relaxed text-ink ${kind === 'code' ? 'font-mono' : 'whitespace-pre-wrap'}`}>{text}</pre>
              )}
            </div>
          )}
          {kind === 'none' && (
            <div className="rounded-lg border dashed border-border-faint bg-surface-softer p-4 text-center text-[11px] text-ink-soft">
              {t('vault.preview.noPreview', { category: file.category })}
            </div>
          )}

          <div className="mt-3 flex flex-wrap items-center gap-2">
            {file.url && (
              <a
                href={file.url}
                className="rounded-lg bg-accent px-3 py-1.5 text-[11px] font-semibold text-white"
                download={file.name}
              >
                {t('vault.preview.download')}
              </a>
            )}
            {!ended && file.kind === 'deliverable' && (
              <button
                type="button"
                onClick={() => onNewVersion(file)}
                className="rounded-lg border border-border px-3 py-1.5 text-[11px] font-semibold text-ink-muted hover:border-accent/40 hover:text-accent"
              >
                {t('vault.preview.newVersion', { label: vaultVersionLabel(file.version + 1) })}
              </button>
            )}
            {onMention && (
              <button
                type="button"
                onClick={() => onMention(t('vault.preview.askTemplate', { name: file.name, label: vaultVersionLabel(file.version) }))}
                className="rounded-lg border border-border px-3 py-1.5 text-[11px] font-semibold text-ink-muted hover:border-accent/40 hover:text-accent"
              >
                {t('vault.preview.askAgent')}
              </button>
            )}
            {canEdit && (
              <button
                type="button"
                onClick={onDelete}
                className="ml-auto rounded-lg border border-rose-200 px-3 py-1.5 text-[11px] font-semibold text-rose-600 hover:bg-rose-50"
              >
                {t('vault.preview.delete')}
              </button>
            )}
          </div>

          {canEdit && (
            <div className="mt-3 space-y-2 rounded-lg border border-border-faint bg-surface-softer p-2.5">
              <label className="block text-[10px] font-semibold text-ink-muted">
                {t('vault.preview.note')}
                <input
                  value={description}
                  onChange={event => setDescription(event.target.value)}
                  placeholder={t('vault.preview.notePlaceholder')}
                  className="mt-1 min-h-8 w-full rounded-md border border-border bg-white px-2 text-[11px] outline-none focus:border-accent"
                />
              </label>
              <div className="grid grid-cols-2 gap-2">
                <label className="block text-[10px] font-semibold text-ink-muted">
                  {t('vault.preview.tags')}
                  <input
                    value={tags}
                    onChange={event => setTags(event.target.value)}
                    placeholder={t('vault.preview.tagsPlaceholder')}
                    className="mt-1 min-h-8 w-full rounded-md border border-border bg-white px-2 text-[11px] outline-none focus:border-accent"
                  />
                </label>
                <label className="block text-[10px] font-semibold text-ink-muted">
                  {t('vault.preview.folder')}
                  <select
                    value={folderId}
                    onChange={event => setFolderId(event.target.value)}
                    className="mt-1 min-h-8 w-full rounded-md border border-border bg-white px-2 text-[11px] outline-none focus:border-accent"
                  >
                    <option value="">{t('vault.preview.noFolder')}</option>
                    {folders.map(folder => <option key={folder.id} value={folder.id}>{folder.name}</option>)}
                  </select>
                </label>
              </div>
              <button
                type="button"
                onClick={() => void saveMeta()}
                disabled={saving}
                className="min-h-8 rounded-md border border-border bg-surface px-3 text-[11px] font-semibold text-ink-muted hover:border-accent/40 hover:text-accent disabled:opacity-50"
              >
                {saving ? t('vault.preview.saving') : t('vault.preview.saveDetails')}
              </button>
            </div>
          )}

          <div className="mt-3">
            <div className="text-[10px] font-semibold uppercase tracking-wide text-ink-faint">{t('vault.preview.history')}</div>
            <ul className="mt-1 space-y-1">
              {[...file.versions].reverse().map(version => (
                <li key={`${version.version}-${version.createdAt}`} className="flex items-center justify-between rounded-md bg-surface-softer px-2 py-1 text-[10.5px] text-ink-muted">
                  <span className="font-semibold text-ink">{vaultVersionLabel(version.version)}</span>
                  <span className="truncate px-2 text-ink-soft">{version.note ?? version.name}</span>
                  <span>{formatVaultBytes(version.size)} · {version.createdBy} · {relativeTime(version.createdAt)}</span>
                </li>
              ))}
            </ul>
          </div>
        </div>

        <input
          ref={versionInputRef}
          type="file"
          className="hidden"
          onChange={event => {
            const chosen = event.target.files?.[0];
            if (chosen) onVersionChosen(chosen);
            event.target.value = '';
          }}
        />
      </div>
    </div>
  );
}
