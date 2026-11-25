// The vault's operations, in one place, because two front doors call them:
// the browser (/api/files) and agents (/api/mcp → room_files / room_deliverable).
// A file uploaded from the UI must be exactly as readable by an agent as one
// an agent uploaded, so the rules live here and not in either handler.

import type { ClientKind, Message, VaultFile, VaultFileKind } from '@agent-room/shared';
import {
  VAULT_MAX_FILE_BYTES,
  VAULT_MAX_VERSIONS,
  normalizeVaultTags,
  sanitizeVaultFileName,
  vaultCategoryFor,
  vaultVersionLabel,
} from '@agent-room/shared';
import type { UpstashClient } from '@agent-room/upstash-client';
import {
  addVaultVersion,
  assertVaultCapacity,
  attachVaultFileToTask,
  deleteVaultFile,
  newVaultFileId,
  putVaultFile,
  vaultStorageKeys,
} from '@agent-room/upstash-client';
import type { BlobStore } from './_blobStore.js';
import { vaultStorageKey } from './_blobStore.js';
import { extractText } from './_textExtract.js';
import { siteUrl } from './_siteUrl.js';
import { signVaultToken } from './_fileAccess.js';
import type { VaultPrincipal } from './_fileAccess.js';

export interface VaultDeps {
  store: UpstashClient;
  blob: BlobStore;
}

export class VaultRequestError extends Error {
  constructor(message: string, readonly status: number, readonly code: string) {
    super(message);
    this.name = 'VaultRequestError';
  }
}

/** Public base URL of this deployment, for links an agent will open. */
export function deploymentOrigin(): string {
  // One resolver for every link the server hands out (api/_siteUrl.ts).
  return siteUrl();
}

export interface VaultUploadItem {
  name: string;
  mime: string;
  bytes: Uint8Array;
  /** Per-file overrides; folder/tags/task fall back to the batch defaults. */
  folderId?: string;
  tags?: string[];
  description?: string;
  taskId?: string;
  /**
   * Set when the bytes are ALREADY in storage — the browser uploaded them
   * straight to R2 with a presigned PUT, which is how a file above the inline
   * cap gets in. The server verifies the object before recording it.
   */
  preassignedId?: string;
  preassignedKey?: string;
  alreadyStored?: boolean;
}

export interface VaultUploadOptions {
  code: string;
  kind: VaultFileKind;
  principal: VaultPrincipal;
  items: VaultUploadItem[];
  folderId?: string;
  tags?: string[];
  taskId?: string;
  description?: string;
  projectId?: string;
  /** Deliverables: who produced it, when that is not the uploader. */
  producer?: string;
  producerClient?: ClientKind;
  /** Largest single object this path can carry (inline vs presigned). */
  maxBytes?: number;
  /** Post a system line into the room for each stored file. */
  announce?: boolean;
}

export interface VaultUploadFailure {
  name: string;
  error: string;
  message: string;
}

export interface VaultUploadResult {
  files: VaultFile[];
  failures: VaultUploadFailure[];
}

/**
 * Store one batch, refusing the whole batch before anything is written when
 * the room is full.
 *
 * Per-file failures are collected rather than thrown: a drag-and-drop of nine
 * files where one is 40 MB should leave eight usable files and one clear
 * sentence, not an empty vault and a 413.
 */
export async function uploadVaultFiles(deps: VaultDeps, options: VaultUploadOptions): Promise<VaultUploadResult> {
  const { store, blob } = deps;
  const maxBytes = Math.min(options.maxBytes ?? VAULT_MAX_FILE_BYTES, VAULT_MAX_FILE_BYTES);
  const files: VaultFile[] = [];
  const failures: VaultUploadFailure[] = [];

  const accepted: VaultUploadItem[] = [];
  for (const item of options.items) {
    const safeName = sanitizeVaultFileName(item.name);
    if (!item.bytes || item.bytes.length === 0) {
      failures.push({ name: safeName, error: 'empty_file', message: 'The file is empty.' });
      continue;
    }
    if (item.bytes.length > maxBytes) {
      failures.push({
        name: safeName,
        error: 'file_too_large',
        message: `${safeName} is ${(item.bytes.length / 1024 / 1024).toFixed(1)} MB; this upload path accepts up to ${(maxBytes / 1024 / 1024).toFixed(1)} MB per file.`,
      });
      continue;
    }
    accepted.push({ ...item, name: safeName });
  }
  if (accepted.length === 0) return { files, failures };

  const totalBytes = accepted.reduce((sum, item) => sum + item.bytes.length, 0);
  try {
    await assertVaultCapacity(store, options.code, options.kind, totalBytes);
  } catch (error) {
    throw new VaultRequestError((error as Error).message, 507, 'vault_full');
  }

  for (const item of accepted) {
    const id = item.preassignedId && /^vf_[a-f0-9]{16}$/.test(item.preassignedId) ? item.preassignedId : await newVaultFileId();
    const now = Date.now();
    const mime = normalizeMime(item.mime, item.name);
    const storageKey = item.alreadyStored && item.preassignedKey
      ? item.preassignedKey
      : vaultStorageKey(options.kind, options.code, id, 1, item.name);
    let bytes = item.bytes;
    try {
      if (item.alreadyStored) {
        // The object arrived out of band; read it back so the record carries
        // the size and text the server observed, not what the client claimed.
        const stored = await blob.get(storageKey);
        if (!stored) {
          failures.push({ name: item.name, error: 'upload_not_found', message: `No uploaded object found for ${item.name}.` });
          continue;
        }
        bytes = stored.bytes;
      } else {
        await blob.put(storageKey, bytes, mime);
      }
    } catch (error) {
      failures.push({
        name: item.name,
        error: 'storage_failed',
        message: `Could not store ${item.name}: ${error instanceof Error ? error.message : 'object storage error'}`,
      });
      continue;
    }
    const extracted = safeExtract(bytes, mime, item.name);
    const file: VaultFile = {
      id,
      kind: options.kind,
      code: options.code,
      name: item.name,
      size: bytes.length,
      mime,
      category: vaultCategoryFor(mime, item.name),
      storageKey,
      ...(item.folderId || options.folderId ? { folderId: item.folderId ?? options.folderId } : {}),
      tags: normalizeVaultTags(item.tags ?? options.tags ?? []),
      ...(item.taskId || options.taskId ? { taskId: item.taskId ?? options.taskId } : {}),
      ...(item.description || options.description ? { description: (item.description ?? options.description)!.slice(0, 2000) } : {}),
      ...(options.projectId ?? options.principal.projectId ? { projectId: options.projectId ?? options.principal.projectId } : {}),
      createdAt: now,
      updatedAt: now,
      uploadedBy: options.principal.name || 'agent',
      uploadedByClient: options.principal.client,
      ...(options.kind === 'deliverable'
        ? {
          producer: options.producer ?? (options.principal.name || 'agent'),
          producerClient: options.producerClient ?? options.principal.client,
        }
        : {}),
      version: 1,
      versions: [{
        version: 1,
        storageKey,
        name: item.name,
        size: bytes.length,
        mime,
        createdAt: now,
        createdBy: options.principal.name || 'agent',
        createdByClient: options.principal.client,
      }],
      ...(extracted ? { extractedText: extracted.text, extraction: { kind: extracted.kind, approximate: extracted.approximate, chars: extracted.text.length } } : {}),
    };
    await putVaultFile(store, file);
    files.push(file);
    if (options.announce !== false) await announceVaultFile(store, file, 'uploaded');
  }
  return { files, failures };
}

export interface VaultReviseOptions {
  code: string;
  principal: VaultPrincipal;
  fileId: string;
  name?: string;
  mime?: string;
  bytes: Uint8Array;
  note?: string;
  description?: string;
  taskId?: string;
  tags?: string[];
  maxBytes?: number;
  announce?: boolean;
}

/**
 * Register a new revision of an existing file.
 *
 * The id stays, so every link a person or a task already holds keeps working
 * and now shows the newest bytes — and the previous revision stays downloadable
 * from the history until it falls out of the window.
 */
export async function reviseVaultFile(
  deps: VaultDeps,
  options: VaultReviseOptions,
): Promise<{ file: VaultFile; prunedKeys: string[] }> {
  const { store, blob } = deps;
  const current = await findVaultFile(store, options.code, options.fileId);
  if (!current) throw new VaultRequestError('No such file in this room vault.', 404, 'file_not_found');
  const maxBytes = Math.min(options.maxBytes ?? VAULT_MAX_FILE_BYTES, VAULT_MAX_FILE_BYTES);
  if (!options.bytes || options.bytes.length === 0) throw new VaultRequestError('The new version is empty.', 400, 'empty_file');
  if (options.bytes.length > maxBytes) {
    throw new VaultRequestError(
      `${(options.bytes.length / 1024 / 1024).toFixed(1)} MB exceeds the ${(maxBytes / 1024 / 1024).toFixed(1)} MB limit for this upload path.`,
      413,
      'file_too_large',
    );
  }
  const growth = Math.max(0, options.bytes.length - current.size);
  if (growth > 0) {
    try {
      await assertVaultCapacity(store, options.code, current.kind, growth);
    } catch (error) {
      throw new VaultRequestError((error as Error).message, 507, 'vault_full');
    }
  }
  const version = Math.min(VAULT_MAX_VERSIONS + 1000, (current.version || 1) + 1);
  const name = sanitizeVaultFileName(options.name ?? current.name);
  const mime = normalizeMime(options.mime ?? current.mime, name);
  const storageKey = vaultStorageKey(current.kind, options.code, current.id, version, name);
  await blob.put(storageKey, options.bytes, mime);
  const extracted = safeExtract(options.bytes, mime, name);
  const result = await addVaultVersion(store, current.kind, options.code, current.id, {
    version,
    storageKey,
    name,
    size: options.bytes.length,
    mime,
    createdAt: Date.now(),
    createdBy: options.principal.name || 'agent',
    createdByClient: options.principal.client,
    ...(options.note ? { note: options.note.slice(0, 2000) } : {}),
  }, {
    name,
    size: options.bytes.length,
    mime,
    category: vaultCategoryFor(mime, name),
    ...(extracted ? { extractedText: extracted.text, extraction: { kind: extracted.kind, approximate: extracted.approximate, chars: extracted.text.length } } : {}),
    ...(options.description ? { description: options.description.slice(0, 2000) } : {}),
  });
  if (!result) throw new VaultRequestError('No such file in this room vault.', 404, 'file_not_found');
  let file = result.file;
  if (options.taskId && options.taskId !== current.taskId) {
    file = (await attachVaultFileToTask(store, current.kind, options.code, current.id, options.taskId)) ?? file;
  }
  if (options.tags && options.tags.length > 0) {
    const tags = normalizeVaultTags([...file.tags, ...options.tags]);
    file = { ...file, tags };
    await putVaultFile(store, file, { tags: current.tags, taskId: file.taskId });
  }
  // A version falling out of the window is bytes nobody can reach; remove them.
  if (result.prunedKeys.length > 0) await blob.delete(result.prunedKeys).catch(() => 0);
  if (options.announce !== false) await announceVaultFile(store, file, 'revised', options.note);
  return { file, prunedKeys: result.prunedKeys };
}

export async function deleteVaultFileWithObjects(
  deps: VaultDeps,
  code: string,
  kind: VaultFileKind,
  id: string,
): Promise<VaultFile | null> {
  const removed = await deleteVaultFile(deps.store, kind, code, id);
  if (!removed) return null;
  await deps.blob.delete(vaultStorageKeys(removed)).catch(() => 0);
  return removed;
}

/** Look a file up by id without knowing which vault it is in. */
export async function findVaultFile(store: UpstashClient, code: string, id: string): Promise<VaultFile | null> {
  const { getVaultFile } = await import('@agent-room/upstash-client');
  for (const kind of ['deliverable', 'material'] as const) {
    const file = await getVaultFile(store, kind, code, id);
    if (file) return file;
  }
  return null;
}

export interface VaultTextSlice {
  text: string;
  offset: number;
  total: number;
  nextOffset: number | null;
  approximate: boolean;
  kind: string;
}

/**
 * A window into the file's text.
 *
 * Agents read in slices on purpose: a 120k-character spreadsheet in one tool
 * result costs more than the question is worth, and a sliced read lets the
 * agent ask for the part it needs. `total` is what makes that possible.
 */
export function readVaultFileSlice(file: VaultFile, offset = 0, limit = 20_000): VaultTextSlice | null {
  const text = file.extractedText;
  if (typeof text !== 'string' || text.length === 0) return null;
  const start = Math.max(0, Math.min(Math.floor(offset) || 0, Math.max(0, text.length - 1)));
  const take = Math.max(1, Math.min(Math.floor(limit) || 0, 60_000));
  const slice = text.slice(start, start + take);
  const end = start + slice.length;
  return {
    text: slice,
    offset: start,
    total: text.length,
    nextOffset: end < text.length ? end : null,
    approximate: file.extraction?.approximate === true,
    kind: file.extraction?.kind ?? 'text',
  };
}

/**
 * A download grant for one file.
 *
 * Returns null when no signing secret is configured — the caller then hands out
 * the authenticated API path instead of a URL that would 503. Either way the
 * file never becomes publicly reachable.
 */
export function vaultDownloadUrl(file: VaultFile, ttlMs = 15 * 60_000): string | null {
  const token = signVaultToken({ c: file.code, k: file.kind, f: file.id, ttlMs });
  if (!token) return null;
  return `${deploymentOrigin()}/api/files?token=${encodeURIComponent(token)}`;
}

/** The same grant, relative, for a browser that is already on the origin. */
export function vaultDownloadPath(file: VaultFile, ttlMs = 30 * 60_000): string | null {
  const token = signVaultToken({ c: file.code, k: file.kind, f: file.id, ttlMs });
  return token ? `/api/files?token=${encodeURIComponent(token)}&name=${encodeURIComponent(file.name)}` : null;
}

/**
 * Say it in the room.
 *
 * A file that appears silently is a file nobody opens: the vault tab is not the
 * conversation. One system line per stored file, carrying the ids, is what lets
 * a reader click through from the transcript — and what the task board's
 * "deliverables" line is built from. Never fatal: the file is already stored.
 */
export async function announceVaultFile(
  store: UpstashClient,
  file: VaultFile,
  action: 'uploaded' | 'revised' | 'linked',
  note?: string,
): Promise<void> {
  const label = file.kind === 'deliverable' ? 'Deliverable' : 'Material';
  const verb = action === 'revised' ? 'revised' : 'added';
  const who = file.kind === 'deliverable' && file.producer ? file.producer : file.uploadedBy;
  const parts = [
    `${file.kind === 'deliverable' ? '🗂' : '📎'} ${label} ${verb}: "${file.name}" ${vaultVersionLabel(file.version)}`,
    `${(file.size / 1024).toFixed(0)} KB`,
    `by ${who}`,
    ...(file.taskId ? [`· task ${file.taskId}`] : []),
    ...(file.tags.length > 0 ? [`· tags ${file.tags.join(', ')}`] : []),
    ...(note ? [`· ${note.slice(0, 200)}`] : []),
  ];
  const message: Message = {
    id: Date.now(),
    type: 'sys',
    name: 'system',
    client: 'cc',
    initials: file.kind === 'deliverable' ? '🗂' : '📎',
    color: '#0EA5E9',
    role: '',
    time: Date.now(),
    text: parts.join(' '),
    metadata: { eventType: 'file_update', ...(file.taskId ? { taskId: file.taskId } : {}) },
  };
  try {
    const { appendSystemMessage } = await import('@agent-room/upstash-client');
    await appendSystemMessage(store, file.code, message);
  } catch {
    // Room expired or not writable: the vault record is the durable record.
  }
}

/**
 * The board's own line about a task's paper trail.
 *
 * Posted when a task is submitted or ruled done, so the transcript says what
 * the work actually IS — a task marked done with no deliverable attached is
 * exactly the phantom delivery the board exists to prevent, and this is the
 * line that makes its absence visible to a reader of the minutes.
 */
export async function announceTaskFiles(
  store: UpstashClient,
  code: string,
  task: { id: string; title: string; state: string },
  files: VaultFile[],
  phase: 'submitted' | 'done',
): Promise<void> {
  const deliverables = files.filter(file => file.kind === 'deliverable');
  const materials = files.filter(file => file.kind === 'material');
  if (deliverables.length === 0 && materials.length === 0) return;
  const list = (items: VaultFile[]) => items
    .map(file => `"${file.name}" ${vaultVersionLabel(file.version)}`)
    .slice(0, 6)
    .join(', ');
  const head = phase === 'done' ? `✅ ${task.id} done` : `📤 ${task.id} submitted`;
  const body = [
    deliverables.length > 0 ? `deliverables: ${list(deliverables)}` : '',
    materials.length > 0 ? `inputs: ${list(materials)}` : '',
  ].filter(Boolean).join(' · ');
  const message: Message = {
    id: Date.now(),
    type: 'sys',
    name: 'system',
    client: 'cc',
    initials: phase === 'done' ? '✅' : '📤',
    color: '#6366F1',
    role: '',
    time: Date.now(),
    text: `${head} — "${task.title}" · ${body}`,
    metadata: { eventType: 'file_update', taskId: task.id },
  };
  try {
    const { appendSystemMessage } = await import('@agent-room/upstash-client');
    await appendSystemMessage(store, code, message);
  } catch {
    // Best effort: the task and the files are the durable record.
  }
}

function normalizeMime(mime: string, name: string): string {
  const clean = String(mime || '').split(';')[0]!.trim().toLowerCase();
  if (/^[a-z0-9.+-]+\/[a-z0-9.+-]+$/.test(clean)) return clean;
  const ext = name.toLowerCase().split('.').pop() ?? '';
  const guessed: Record<string, string> = {
    txt: 'text/plain', md: 'text/markdown', csv: 'text/csv', json: 'application/json', pdf: 'application/pdf',
    png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', svg: 'image/svg+xml',
    zip: 'application/zip', docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  };
  return guessed[ext] ?? 'application/octet-stream';
}

function safeExtract(bytes: Uint8Array, mime: string, name: string) {
  try {
    return extractText(bytes, mime, name);
  } catch {
    // Extraction is a convenience; a parser bug must never fail an upload.
    return null;
  }
}
