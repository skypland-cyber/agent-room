// Vault: the room's files, separated into what came IN and what went OUT.
//
//   material    — files a human (or an agent) brought to the room: the
//                 spreadsheet to analyze, the reference PDF, the brand assets.
//   deliverable — files the room produced: the program, the document, the
//                 image, the source tree. These outlive the meeting.
//
// The two share one record shape because they share every operation (folders,
// tags, versions, search, download). What differs is lifetime and authorship,
// and those are expressed by the store (deliverables get no TTL) and by the
// fields a producer fills in — not by two parallel implementations.
//
// Everything here is pure: types, MIME classification, name hygiene, clamps.
// The Redis metadata store lives in @agent-room/upstash-client/vault and the
// bytes live in object storage; this module is what both agree on.

import type { ClientKind } from './types.js';

export type VaultFileKind = 'material' | 'deliverable';

/**
 * What the file IS, for icons, filters and "can I preview this" decisions.
 * Derived from MIME + extension at upload time and stored, so a search result
 * does not have to re-derive it from a filename a user may have renamed.
 */
export type VaultCategory =
  | 'document'
  | 'spreadsheet'
  | 'presentation'
  | 'pdf'
  | 'image'
  | 'video'
  | 'audio'
  | 'code'
  | 'archive'
  | 'data'
  | 'text'
  | 'other';

/** How the browser should render a file in the preview pane. */
export type VaultPreviewKind = 'image' | 'pdf' | 'video' | 'audio' | 'markdown' | 'text' | 'code' | 'none';

/**
 * Per-file caps.
 *
 * Two numbers, because a request that carries the bytes has a different limit
 * from one that only points at them. `inlineBytes` is the server-mediated
 * upload path (a Vercel function request body is capped at 4.5 MB by the
 * platform); `maxBytes` is what the vault accepts at all, reachable through a
 * presigned direct-to-storage upload on backends that support it.
 */
export const VAULT_MAX_FILE_BYTES = 25 * 1024 * 1024;
export const VAULT_INLINE_MAX_BYTES = 3.5 * 1024 * 1024;
/** Base64 inside an MCP tool argument is ~4/3 the size plus JSON overhead. */
export const VAULT_MCP_INLINE_MAX_BYTES = 1.5 * 1024 * 1024;

/** Room-wide budget, counted over both vaults. */
export const VAULT_MAX_ROOM_BYTES = 1024 * 1024 * 1024;
export const VAULT_MAX_FILES_PER_KIND = 500;
export const VAULT_MAX_FOLDERS = 50;
export const VAULT_MAX_TAGS_PER_FILE = 8;
export const VAULT_MAX_TAG_LENGTH = 24;
/** Newest N kept; older versions are dropped from the record and storage. */
export const VAULT_MAX_VERSIONS = 20;
/** Text kept in the record so an agent can read a document without a fetch. */
export const VAULT_EXTRACT_LIMIT = 120_000;
/** Default slice returned by room_file_read. */
export const VAULT_READ_DEFAULT_CHARS = 20_000;
export const VAULT_READ_MAX_CHARS = 60_000;

export const VAULT_FILE_ID_RE = /^vf_[a-f0-9]{16}$/;

/**
 * One stored revision.
 *
 * Versions are kept in the file record rather than behind their own keys: the
 * history of a deliverable is short (v1..v20), always read together with the
 * file it belongs to, and a separate key per version would triple the round
 * trips of the one screen that shows it.
 */
export interface VaultVersion {
  version: number;
  storageKey: string;
  name: string;
  size: number;
  mime: string;
  createdAt: number;
  createdBy: string;
  createdByClient: ClientKind;
  /** What changed in this revision — the producer's own words. */
  note?: string;
}

/**
 * The vault record. This is metadata only; the bytes live at `storageKey` in
 * the deployment's object store and never pass through Redis.
 */
export interface VaultFile {
  id: string;
  kind: VaultFileKind;
  /** Room the file belongs to. Empty for files carried across rooms by id. */
  code: string;
  name: string;
  size: number;
  mime: string;
  category: VaultCategory;
  /** Object-store key of the CURRENT version. */
  storageKey: string;
  folderId?: string;
  tags: string[];
  /** Grouping above folders; defaults to the room's project when it has one. */
  projectId?: string;
  /** Task this file belongs to (T-01 …), so the board can show its paper trail. */
  taskId?: string;
  description?: string;
  createdAt: number;
  updatedAt: number;
  uploadedBy: string;
  uploadedByClient: ClientKind;
  /** Deliverables: the AI (or person) that produced it. */
  producer?: string;
  producerClient?: ClientKind;
  version: number;
  versions: VaultVersion[];
  /** Capped plain text of the current version, when it is text-like. */
  extractedText?: string;
  /** How faithful `extractedText` is; absent when there is none. */
  extraction?: { kind: 'text' | 'docx' | 'xlsx' | 'pdf'; approximate: boolean; chars: number };
  /** Set when the file is pinned to the top of the vault. */
  starred?: boolean;
}

export interface VaultFolder {
  id: string;
  name: string;
  parentId?: string;
  createdAt: number;
  createdBy: string;
  color?: string;
}

export interface VaultUsage {
  code: string;
  bytes: number;
  limitBytes: number;
  materials: { files: number; bytes: number };
  deliverables: { files: number; bytes: number };
}

/** What a listing row carries. Enough to render a row; no text blob. */
export interface VaultFileSummary {
  id: string;
  kind: VaultFileKind;
  name: string;
  size: number;
  mime: string;
  category: VaultCategory;
  folderId?: string;
  tags: string[];
  taskId?: string;
  description?: string;
  producer?: string;
  version: number;
  createdAt: number;
  updatedAt: number;
  uploadedBy: string;
  hasText: boolean;
  starred?: boolean;
}

const MIME_CATEGORY: Array<[RegExp, VaultCategory]> = [
  [/^image\//, 'image'],
  [/^video\//, 'video'],
  [/^audio\//, 'audio'],
  [/^application\/pdf$/, 'pdf'],
  [/wordprocessingml|msword|^text\/rtf$|hwp|owpml/, 'document'],
  [/spreadsheet|ms-excel|^text\/csv$|^text\/tab-separated-values$/, 'spreadsheet'],
  [/presentation|ms-powerpoint/, 'presentation'],
  [/zip|compressed|tar|gzip|x-7z|x-rar/, 'archive'],
  [/^application\/json$|^application\/xml$|^text\/xml$|ndjson/, 'data'],
  [/^application\/(x-)?javascript$|^application\/typescript$|^application\/x-sh$|^text\/x-/, 'code'],
  [/^text\/plain$/, 'text'],
  [/^text\/markdown$/, 'document'],
];

const EXT_CATEGORY: Record<string, VaultCategory> = {
  pdf: 'pdf',
  doc: 'document', docx: 'document', rtf: 'document', odt: 'document', hwp: 'document', hwpx: 'document', pages: 'document', md: 'document',
  xls: 'spreadsheet', xlsx: 'spreadsheet', csv: 'spreadsheet', tsv: 'spreadsheet', ods: 'spreadsheet', numbers: 'spreadsheet',
  ppt: 'presentation', pptx: 'presentation', odp: 'presentation', key: 'presentation',
  png: 'image', jpg: 'image', jpeg: 'image', gif: 'image', webp: 'image', svg: 'image', bmp: 'image', heic: 'image', avif: 'image',
  mp4: 'video', mov: 'video', webm: 'video', m4v: 'video', avi: 'video', mkv: 'video',
  mp3: 'audio', wav: 'audio', m4a: 'audio', ogg: 'audio', flac: 'audio', aac: 'audio',
  zip: 'archive', tar: 'archive', gz: 'archive', '7z': 'archive', rar: 'archive',
  json: 'data', xml: 'data', yaml: 'data', yml: 'data', toml: 'data', ndjson: 'data',
  js: 'code', mjs: 'code', cjs: 'code', ts: 'code', tsx: 'code', jsx: 'code', py: 'code', rb: 'code', go: 'code',
  rs: 'code', java: 'code', kt: 'code', c: 'code', h: 'code', cpp: 'code', cs: 'code', php: 'code', swift: 'code',
  sh: 'code', bash: 'code', zsh: 'code', sql: 'code', css: 'code', scss: 'code', html: 'code', vue: 'code', svelte: 'code',
  txt: 'text', log: 'text',
};

const TEXT_MIMES = new Set([
  'text/plain', 'text/markdown', 'text/csv', 'text/tab-separated-values', 'text/html', 'text/xml',
  'text/css', 'text/javascript', 'text/x-python', 'text/x-sh', 'text/rtf',
  'application/json', 'application/xml', 'application/ndjson', 'application/javascript',
  'application/typescript', 'application/x-sh', 'application/yaml', 'application/x-yaml',
  'application/sql', 'application/toml',
]);

/** Lower-case extension of a filename, without the dot. */
export function vaultExtension(name: string): string {
  const base = String(name || '').split(/[?#]/)[0]!;
  const dot = base.lastIndexOf('.');
  if (dot <= 0 || dot === base.length - 1) return '';
  return base.slice(dot + 1).toLowerCase().slice(0, 12);
}

/** Category for a file, preferring the MIME the client sent, then the name. */
export function vaultCategoryFor(mime: string, name = ''): VaultCategory {
  const clean = String(mime || '').toLowerCase().split(';')[0]!.trim();
  for (const [pattern, category] of MIME_CATEGORY) if (pattern.test(clean)) return category;
  const ext = vaultExtension(name);
  if (ext && EXT_CATEGORY[ext]) return EXT_CATEGORY[ext]!;
  if (clean.startsWith('text/')) return 'text';
  return 'other';
}

/** True when we can store the file as readable text (no parser needed). */
export function isVaultTextMime(mime: string, name = ''): boolean {
  const clean = String(mime || '').toLowerCase().split(';')[0]!.trim();
  if (TEXT_MIMES.has(clean)) return true;
  if (clean.startsWith('text/')) return true;
  const ext = vaultExtension(name);
  return Boolean(ext && EXT_CATEGORY[ext] && ['code', 'data', 'text', 'document'].includes(EXT_CATEGORY[ext]!)
    && ['md', 'markdown', 'csv', 'tsv', 'json', 'xml', 'yaml', 'yml', 'toml', 'txt', 'log', 'rtf'].includes(ext));
}

/** Container formats we can pull text out of without a native dependency. */
export function vaultOfficeFamily(mime: string, name = ''): 'docx' | 'xlsx' | null {
  const clean = String(mime || '').toLowerCase();
  const ext = vaultExtension(name);
  if (ext === 'docx' || clean.includes('wordprocessingml.document')) return 'docx';
  if (ext === 'xlsx' || clean.includes('spreadsheetml.sheet')) return 'xlsx';
  return null;
}

/** How the web client should preview the file, if at all. */
export function vaultPreviewKind(mime: string, name = ''): VaultPreviewKind {
  const clean = String(mime || '').toLowerCase().split(';')[0]!.trim();
  if (clean.startsWith('image/') && clean !== 'image/heic' && clean !== 'image/heif') return 'image';
  if (clean === 'application/pdf' || vaultExtension(name) === 'pdf') return 'pdf';
  if (clean.startsWith('video/')) return 'video';
  if (clean.startsWith('audio/')) return 'audio';
  const category = vaultCategoryFor(clean, name);
  if (category === 'code') return 'code';
  const ext = vaultExtension(name);
  if (clean === 'text/markdown' || clean === 'text/x-markdown' || ext === 'md' || ext === 'markdown') return 'markdown';
  if (category === 'text' || category === 'data' || isVaultTextMime(clean, name)) return 'text';
  return 'none';
}

/**
 * A filename safe to show and to put in a storage key.
 *
 * Keeps one human-readable name (it is what the user sees in the list and what
 * the download is called) while stripping the characters that would let a name
 * escape its prefix, forge a header, or hide behind a bidi override.
 */
export function sanitizeVaultFileName(input: unknown): string {
  const raw = typeof input === 'string' ? input : '';
  const cleaned = raw
    .replace(/[\u0000-\u001f\u007f]/g, '')       // control characters
    .replace(/[\u202a-\u202e\u2066-\u2069]/g, '') // bidi overrides
    .replace(/[\\/]+/g, '_')                     // path separators
    .replace(/^\.+/, '')                          // leading dots: no hidden files
    .trim();
  // A name made only of separators or dots is not a name; say "file".
  const base = /[\p{L}\p{N}]/u.test(cleaned) ? cleaned : 'file';
  if (base.length <= 160) return base;
  const ext = vaultExtension(base);
  if (!ext) return base.slice(0, 160);
  return `${base.slice(0, 160 - ext.length - 1)}.${ext}`;
}

/** Trim extracted text to the stored budget without cutting mid-surrogate. */
export function clampVaultText(text: string, limit = VAULT_EXTRACT_LIMIT): string {
  const value = String(text ?? '').replace(/\u0000/g, '');
  if (value.length <= limit) return value;
  const sliced = value.slice(0, limit);
  const last = sliced.charCodeAt(sliced.length - 1);
  return last >= 0xd800 && last <= 0xdbff ? sliced.slice(0, -1) : sliced;
}

/** `v1`, `v2` … — the label the vault UI and MCP listings show. */
export function vaultVersionLabel(version: number): string {
  return `v${Number.isFinite(version) && version > 0 ? Math.floor(version) : 1}`;
}

/** Bytes as the room shows them. Kept here so server and client never differ. */
export function formatVaultBytes(bytes: number): string {
  const n = Number.isFinite(bytes) && bytes > 0 ? bytes : 0;
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / (1024 * 1024)).toFixed(1)} MB`;
  return `${(n / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

/** Tags as stored: lower-cased, trimmed, deduped, bounded. */
export function normalizeVaultTags(input: unknown): string[] {
  const list = Array.isArray(input) ? input : typeof input === 'string' ? input.split(',') : [];
  const out: string[] = [];
  for (const item of list) {
    if (typeof item !== 'string') continue;
    const tag = item.trim().replace(/^#/, '').replace(/\s+/g, ' ').slice(0, VAULT_MAX_TAG_LENGTH).toLowerCase();
    if (!tag || out.includes(tag)) continue;
    out.push(tag);
    if (out.length >= VAULT_MAX_TAGS_PER_FILE) break;
  }
  return out;
}

/** Listing row for a record — the shape both the board and MCP return. */
export function vaultFileSummary(file: VaultFile): VaultFileSummary {
  return {
    id: file.id,
    kind: file.kind,
    name: file.name,
    size: file.size,
    mime: file.mime,
    category: file.category,
    ...(file.folderId ? { folderId: file.folderId } : {}),
    tags: [...file.tags],
    ...(file.taskId ? { taskId: file.taskId } : {}),
    ...(file.description ? { description: file.description } : {}),
    ...(file.producer ? { producer: file.producer } : {}),
    version: file.version,
    createdAt: file.createdAt,
    updatedAt: file.updatedAt,
    uploadedBy: file.uploadedBy,
    hasText: Boolean(file.extractedText),
    ...(file.starred ? { starred: true } : {}),
  };
}

/**
 * Does a record match a free-text query?
 *
 * Deliberately substring, not tokenized search: the vault holds tens of files,
 * the query is typed by a person or an agent that can see the list, and
 * substring matching never misses a Korean compound word that a stemmer would
 * split wrong. Filename, tags, description, producer and the extracted text all
 * match, in that order of relevance.
 */
export function vaultFileMatches(file: VaultFile, query: string): boolean {
  const q = String(query || '').trim().toLowerCase();
  if (!q) return true;
  const haystacks = [file.name, file.description ?? '', file.producer ?? '', file.tags.join(' '), file.taskId ?? ''];
  if (haystacks.some(value => value.toLowerCase().includes(q))) return true;
  return (file.extractedText ?? '').toLowerCase().includes(q);
}

/** Where the query hit, for a search result the reader can judge. */
export function vaultMatchSnippet(file: VaultFile, query: string, radius = 60): string | undefined {
  const q = String(query || '').trim();
  if (!q || !file.extractedText) return undefined;
  const at = file.extractedText.toLowerCase().indexOf(q.toLowerCase());
  if (at < 0) return undefined;
  const start = Math.max(0, at - radius);
  const end = Math.min(file.extractedText.length, at + q.length + radius);
  return `${start > 0 ? '…' : ''}${file.extractedText.slice(start, end).replace(/\s+/g, ' ')}${end < file.extractedText.length ? '…' : ''}`;
}
