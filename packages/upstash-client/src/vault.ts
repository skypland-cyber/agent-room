// The vault's metadata store: what file exists, where its bytes are, which
// folder and tags it carries, which task it belongs to, and what its history
// is. No bytes ever land here — the object store holds those, and Redis holds
// only what the list, the search and the permission check need.
//
// Key layout (per room):
//
//   vault:materials:{code}:ids          SET  every material file id
//   vault:materials:{code}:file:{id}    STR   one record (JSON)
//   vault:deliverables:{code}:ids       SET  every deliverable file id
//   vault:deliverables:{code}:file:{id} STR   one record (JSON)
//   vault:{code}:folders                SET  folder ids
//   vault:{code}:folder:{id}            STR   one folder (JSON)
//   vault:{code}:task:{taskId}          SET  "kind:id" entries linked to a task
//
// Why one key per record instead of one JSON array per room: a write must not
// be able to lose a concurrent write. SADD/SREM and SET-per-id are each atomic,
// so two agents uploading at the same time both land; a shared array would be a
// read-modify-write race the way the room document (casRoom) already is.
//
// LIFETIME. Materials follow the meeting: they carry a TTL and are cleaned up
// with it. Deliverables carry NO TTL — that is the whole point of the
// deliverables vault, and it is why the room document's expiry (which the
// old attachments inherited) must not be reused here. Their storage keys also
// sit under a different prefix than room attachments, so ending a meeting
// (api/delete-room-blobs, prefix `rooms/{code}/`) cannot delete them.

import type { VaultFile, VaultFileKind, VaultFolder, VaultUsage, VaultVersion } from '@agent-room/shared';
import { VAULT_MAX_FILES_PER_KIND, VAULT_MAX_FOLDERS, VAULT_MAX_ROOM_BYTES, VAULT_MAX_VERSIONS, vaultFileMatches } from '@agent-room/shared';
import type { UpstashClient } from './client.js';
import { sha256Hex } from './sha256.js';

/** Materials are room-scoped working files, not an archive. */
export const VAULT_MATERIAL_TTL_SECONDS = 30 * 24 * 60 * 60;

export function vaultIdsKey(kind: VaultFileKind, code: string): string {
  return `vault:${kind}:${code}:ids`;
}
export function vaultFileKey(kind: VaultFileKind, code: string, id: string): string {
  return `vault:${kind}:${code}:file:${id}`;
}
export function vaultTaskKey(code: string, taskId: string): string {
  return `vault:${code}:task:${taskId}`;
}
export function vaultFoldersKey(code: string): string {
  return `vault:${code}:folders`;
}
export function vaultFolderKey(code: string, id: string): string {
  return `vault:${code}:folder:${id}`;
}

export class VaultLimitError extends Error {
  constructor(message: string, readonly reason: 'files' | 'bytes' | 'folders') {
    super(message);
    this.name = 'VaultLimitError';
  }
}

/** A fresh, unguessable file id. 64 bits is plenty next to a 9-char room code. */
export async function newVaultFileId(): Promise<string> {
  const bytes = new Uint8Array(8);
  const cryptoObj = (globalThis as unknown as { crypto?: Crypto }).crypto;
  if (cryptoObj?.getRandomValues) cryptoObj.getRandomValues(bytes);
  else for (let i = 0; i < bytes.length; i++) bytes[i] = Math.floor(Math.random() * 256);
  return `vf_${Array.from(bytes, b => b.toString(16).padStart(2, '0')).join('')}`;
}

/** Folder ids are readable slugs plus a suffix; the slug is never the identity. */
export async function newVaultFolderId(name: string): Promise<string> {
  const slug = String(name || 'folder').toLowerCase().replace(/[^a-z0-9가-힣]+/g, '-').replace(/^-|-$/g, '').slice(0, 24) || 'folder';
  const salt = `${name}:${Date.now()}:${Math.random()}`;
  return `fd_${slug}_${(await sha256Hex(salt)).slice(0, 8)}`;
}

const str = (value: string | null | undefined): string | null => (typeof value === 'string' && value ? value : null);

function parseFile(raw: unknown): VaultFile | null {
  if (typeof raw !== 'string' || !raw) return null;
  try {
    const parsed = JSON.parse(raw) as VaultFile;
    return parsed && typeof parsed.id === 'string' && typeof parsed.kind === 'string' ? parsed : null;
  } catch {
    return null;
  }
}

function parseFolder(raw: unknown): VaultFolder | null {
  if (typeof raw !== 'string' || !raw) return null;
  try {
    const parsed = JSON.parse(raw) as VaultFolder;
    return parsed && typeof parsed.id === 'string' ? parsed : null;
  } catch {
    return null;
  }
}

/** Redis SET command with the lifetime the kind demands. */
function writeRecord(kind: VaultFileKind, key: string, value: string): (string | number)[] {
  if (kind === 'deliverable') return ['SET', key, value];
  return ['SET', key, value, 'EX', VAULT_MATERIAL_TTL_SECONDS];
}

/**
 * Store (or replace) a record and repair every index that points at it.
 *
 * The caller owns the record's contents; this function owns the indexes, so a
 * rename/move/retag never leaves a stale task link behind.
 */
export async function putVaultFile(
  client: UpstashClient,
  file: VaultFile,
  previous?: Pick<VaultFile, 'tags' | 'taskId'>,
): Promise<VaultFile> {
  const key = vaultFileKey(file.kind, file.code, file.id);
  const commands: Array<Array<string | number>> = [
    writeRecord(file.kind, key, JSON.stringify(file)),
    ['SADD', vaultIdsKey(file.kind, file.code), file.id],
  ];
  if (file.kind === 'material') commands.push(['EXPIRE', vaultIdsKey(file.kind, file.code), VAULT_MATERIAL_TTL_SECONDS]);
  if (file.taskId) commands.push(['SADD', vaultTaskKey(file.code, file.taskId), `${file.kind}:${file.id}`]);
  const previousLink = previous?.taskId && previous.taskId !== file.taskId ? previous.taskId : undefined;
  if (previousLink) commands.push(['SREM', vaultTaskKey(file.code, previousLink), `${file.kind}:${file.id}`]);
  await client.pipeline(commands);
  return file;
}

export async function getVaultFile(
  client: UpstashClient,
  kind: VaultFileKind,
  code: string,
  id: string,
): Promise<VaultFile | null> {
  const raw = await client.command<string | null>(['GET', vaultFileKey(kind, code, id)]);
  return parseFile(raw);
}

async function readMany(client: UpstashClient, kind: VaultFileKind, code: string, ids: string[]): Promise<VaultFile[]> {
  if (ids.length === 0) return [];
  const rows = await client.pipeline<string | null>(ids.map(id => ['GET', vaultFileKey(kind, code, id)]));
  const files: VaultFile[] = [];
  rows.forEach((raw, index) => {
    const file = parseFile(raw);
    if (file) files.push(file);
    // A dangling id (record expired before the set did) is cleaned up lazily:
    // the alternative is a sweep job for a case that only happens at TTL edge.
    else void client.command(['SREM', vaultIdsKey(kind, code), ids[index]!]).catch(() => undefined);
  });
  return files;
}

export interface VaultListFilter {
  folderId?: string | null;
  tag?: string;
  taskId?: string;
  projectId?: string;
  category?: string;
  query?: string;
  starred?: boolean;
  limit?: number;
}

function matchesFilter(file: VaultFile, filter: VaultListFilter): boolean {
  if (filter.folderId !== undefined) {
    const wanted = filter.folderId === null ? undefined : filter.folderId;
    if ((file.folderId ?? undefined) !== wanted) return false;
  }
  if (filter.tag && !file.tags.includes(filter.tag.toLowerCase())) return false;
  if (filter.taskId && file.taskId !== filter.taskId) return false;
  if (filter.projectId && file.projectId !== filter.projectId) return false;
  if (filter.category && file.category !== filter.category) return false;
  if (filter.starred === true && !file.starred) return false;
  if (filter.query && !vaultFileMatches(file, filter.query)) return false;
  return true;
}

/** Newest first: updated (a new version) beats created (a fresh upload). */
const byRecency = (a: VaultFile, b: VaultFile): number => (b.updatedAt || b.createdAt) - (a.updatedAt || a.createdAt);

export async function listVaultFiles(
  client: UpstashClient,
  kind: VaultFileKind,
  code: string,
  filter: VaultListFilter = {},
): Promise<VaultFile[]> {
  const ids = (await client.command<string[]>(['SMEMBERS', vaultIdsKey(kind, code)])) ?? [];
  const files = (await readMany(client, kind, code, ids))
    .filter(file => matchesFilter(file, filter))
    .sort(byRecency);
  return filter.limit && filter.limit > 0 ? files.slice(0, filter.limit) : files;
}

/** Search across BOTH vaults — users think "where is that file", not "which vault". */
export async function searchVaultFiles(
  client: UpstashClient,
  code: string,
  query: string,
  filter: VaultListFilter = {},
): Promise<VaultFile[]> {
  const [materials, deliverables] = await Promise.all([
    listVaultFiles(client, 'material', code, { ...filter, query }),
    listVaultFiles(client, 'deliverable', code, { ...filter, query }),
  ]);
  return [...materials, ...deliverables].sort(byRecency).slice(0, filter.limit && filter.limit > 0 ? filter.limit : 100);
}

export async function updateVaultFile(
  client: UpstashClient,
  kind: VaultFileKind,
  code: string,
  id: string,
  mutate: (current: VaultFile) => VaultFile,
): Promise<VaultFile | null> {
  const current = await getVaultFile(client, kind, code, id);
  if (!current) return null;
  const next = mutate(current);
  next.updatedAt = Date.now();
  await putVaultFile(client, next, { tags: current.tags, taskId: current.taskId });
  return next;
}

/** Every storage key a record owns, including the ones its history points at. */
export function vaultStorageKeys(file: VaultFile): string[] {
  const keys = new Set<string>([file.storageKey, ...file.versions.map(v => v.storageKey)]);
  return [...keys].filter(Boolean);
}

export async function deleteVaultFile(
  client: UpstashClient,
  kind: VaultFileKind,
  code: string,
  id: string,
): Promise<VaultFile | null> {
  const file = await getVaultFile(client, kind, code, id);
  if (!file) return null;
  const commands: Array<Array<string | number>> = [
    ['DEL', vaultFileKey(kind, code, id)],
    ['SREM', vaultIdsKey(kind, code), id],
  ];
  if (file.taskId) commands.push(['SREM', vaultTaskKey(code, file.taskId), `${kind}:${id}`]);
  await client.pipeline(commands);
  return file;
}

/**
 * Append a revision.
 *
 * Returns the storage keys that fell out of the window so the caller can delete
 * those objects: keeping the record small matters less than not paying for
 * storage nobody can reach any more.
 */
export async function addVaultVersion(
  client: UpstashClient,
  kind: VaultFileKind,
  code: string,
  id: string,
  version: VaultVersion,
  patch: Partial<Pick<VaultFile, 'name' | 'size' | 'mime' | 'category' | 'extractedText' | 'extraction' | 'description'>> = {},
): Promise<{ file: VaultFile; prunedKeys: string[] } | null> {
  const current = await getVaultFile(client, kind, code, id);
  if (!current) return null;
  const versions = [...current.versions, version];
  const dropped = versions.slice(0, Math.max(0, versions.length - VAULT_MAX_VERSIONS));
  const kept = versions.slice(-VAULT_MAX_VERSIONS);
  const storedVersions = kept.map(item => (item.version === version.version ? version : item));
  const next: VaultFile = {
    ...current,
    ...patch,
    version: version.version,
    storageKey: version.storageKey,
    versions: storedVersions,
    updatedAt: Date.now(),
  };
  await putVaultFile(client, next, { tags: current.tags, taskId: current.taskId });
  return { file: next, prunedKeys: dropped.map(item => item.storageKey).filter(Boolean) };
}

export async function vaultUsage(client: UpstashClient, code: string): Promise<VaultUsage> {
  const [materials, deliverables] = await Promise.all([
    listVaultFiles(client, 'material', code),
    listVaultFiles(client, 'deliverable', code),
  ]);
  const sum = (files: VaultFile[]) => files.reduce((total, file) => total + (Number(file.size) || 0), 0);
  const materialBytes = sum(materials);
  const deliverableBytes = sum(deliverables);
  return {
    code,
    bytes: materialBytes + deliverableBytes,
    limitBytes: VAULT_MAX_ROOM_BYTES,
    materials: { files: materials.length, bytes: materialBytes },
    deliverables: { files: deliverables.length, bytes: deliverableBytes },
  };
}

/** Refuse before the bytes are stored, not after. Called by the upload path. */
export async function assertVaultCapacity(
  client: UpstashClient,
  code: string,
  kind: VaultFileKind,
  incomingBytes: number,
  limitBytes: number = VAULT_MAX_ROOM_BYTES,
): Promise<void> {
  const usage = await vaultUsage(client, code);
  const bucket = kind === 'material' ? usage.materials : usage.deliverables;
  if (bucket.files >= VAULT_MAX_FILES_PER_KIND) {
    throw new VaultLimitError(
      `This room's ${kind} vault already holds ${bucket.files} files (limit ${VAULT_MAX_FILES_PER_KIND}). Delete some before uploading more.`,
      'files',
    );
  }
  if (usage.bytes + incomingBytes > limitBytes) {
    const remaining = Math.max(0, limitBytes - usage.bytes);
    throw new VaultLimitError(
      `The room vault is full: ${Math.round(usage.bytes / 1024 / 1024)} MB used of ${Math.round(limitBytes / 1024 / 1024)} MB, ${Math.round(remaining / 1024 / 1024)} MB left.`,
      'bytes',
    );
  }
}

// ─── Folders ─────────────────────────────────────────────────────────────

export async function listVaultFolders(client: UpstashClient, code: string): Promise<VaultFolder[]> {
  const ids = (await client.command<string[]>(['SMEMBERS', vaultFoldersKey(code)])) ?? [];
  if (ids.length === 0) return [];
  const rows = await client.pipeline<string | null>(ids.map(id => ['GET', vaultFolderKey(code, id)]));
  return rows.map(parseFolder).filter((folder): folder is VaultFolder => folder !== null)
    .sort((a, b) => a.name.localeCompare(b.name));
}

export async function createVaultFolder(
  client: UpstashClient,
  code: string,
  input: { name: string; createdBy: string; parentId?: string; color?: string },
): Promise<VaultFolder> {
  const existing = await listVaultFolders(client, code);
  if (existing.length >= VAULT_MAX_FOLDERS) {
    throw new VaultLimitError(`This room already has ${VAULT_MAX_FOLDERS} folders.`, 'folders');
  }
  const folder: VaultFolder = {
    id: await newVaultFolderId(input.name),
    name: input.name,
    ...(input.parentId ? { parentId: input.parentId } : {}),
    ...(input.color ? { color: input.color } : {}),
    createdAt: Date.now(),
    createdBy: input.createdBy,
  };
  await client.pipeline([
    ['SET', vaultFolderKey(code, folder.id), JSON.stringify(folder)],
    ['SADD', vaultFoldersKey(code), folder.id],
    ['EXPIRE', vaultFoldersKey(code), VAULT_MATERIAL_TTL_SECONDS * 2],
  ]);
  return folder;
}

export async function deleteVaultFolder(
  client: UpstashClient,
  code: string,
  folderId: string,
): Promise<{ deleted: boolean; detached: number }> {
  const raw = await client.command<string | null>(['GET', vaultFolderKey(code, folderId)]);
  if (!parseFolder(raw)) return { deleted: false, detached: 0 };
  let detached = 0;
  for (const kind of ['material', 'deliverable'] as const) {
    for (const file of await listVaultFiles(client, kind, code, { folderId })) {
      await updateVaultFile(client, kind, code, file.id, current => {
        const { folderId: _drop, ...rest } = current;
        return rest as VaultFile;
      });
      detached += 1;
    }
  }
  await client.pipeline([
    ['DEL', vaultFolderKey(code, folderId)],
    ['SREM', vaultFoldersKey(code), folderId],
  ]);
  return { deleted: true, detached };
}

// ─── Task links ──────────────────────────────────────────────────────────

/** Link a file to a task. The file's own record carries the task id too. */
export async function attachVaultFileToTask(
  client: UpstashClient,
  kind: VaultFileKind,
  code: string,
  id: string,
  taskId: string | undefined,
): Promise<VaultFile | null> {
  const current = await getVaultFile(client, kind, code, id);
  if (!current) return null;
  const next: VaultFile = { ...current, updatedAt: Date.now() };
  if (taskId) next.taskId = taskId;
  else delete next.taskId;
  await putVaultFile(client, next, { tags: current.tags, taskId: current.taskId });
  return next;
}

/** Every file the board should show for a task, oldest first. */
export async function vaultFilesForTask(
  client: UpstashClient,
  code: string,
  taskId: string,
): Promise<VaultFile[]> {
  const members = (await client.command<string[]>(['SMEMBERS', vaultTaskKey(code, taskId)])) ?? [];
  const materials: string[] = [];
  const deliverables: string[] = [];
  for (const member of members) {
    const [kind, id] = String(member).split(':');
    if (!id) continue;
    if (kind === 'material') materials.push(id);
    else if (kind === 'deliverable') deliverables.push(id);
  }
  const [fromMaterials, fromDeliverables] = await Promise.all([
    readMany(client, 'material', code, materials),
    readMany(client, 'deliverable', code, deliverables),
  ]);
  return [...fromMaterials, ...fromDeliverables].sort((a, b) => (a.createdAt || 0) - (b.createdAt || 0));
}

/** Ids a task already lists, for de-duplicating an announce message. */
export function uniqueIds(values: Array<string | undefined>): string[] {
  return [...new Set(values.filter((value): value is string => typeof value === 'string' && value.length > 0))];
}
