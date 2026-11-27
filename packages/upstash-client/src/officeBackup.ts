// Integrity for the office backup file.
//
// The backup is the one artefact the boss is expected to keep outside the
// system: a JSON file on a disk, in a mail attachment, in a cloud drive. It
// comes back through a textarea months later. Two failures matter there and
// neither is visible to the person restoring:
//
//   1. the file was truncated or edited on the way, so half the office is
//      restored and the other half silently is not;
//   2. the file is not an office backup at all (an old export shape, a board
//      dump, a different service's JSON) and the restore writes nonsense.
//
// So every export carries a digest over a canonical rendering of its contents,
// and every restore checks the shape before it writes anything. This module is
// the pure half of that: canonical JSON, the digest, and a schema check. It
// reads no storage and imports nothing from the store, so the API, the store
// and the tests share one definition.
import type {
  OfficeAgent,
  OfficeArchive,
  OfficeAuditEntry,
  OfficeProject,
  OfficeSettings,
  OfficeTemplate,
} from '@agent-room/shared';
import type { TaskBoard } from '@agent-room/shared';
import { sha256HexSync } from './sha256.js';

export const OFFICE_BACKUP_FORMAT = 'agent-room-office-backup';
export const OFFICE_BACKUP_VERSION = 1;

export interface OfficeBackupIntegrity {
  algorithm: 'sha256';
  digest: string;
  at: number;
}

export interface OfficeBackup {
  format: typeof OFFICE_BACKUP_FORMAT;
  version: number;
  exportedAt: number;
  exportedBy: string;
  settings: OfficeSettings;
  agents: OfficeAgent[];
  projects: OfficeProject[];
  templates: OfficeTemplate[];
  archives: OfficeArchive[];
  audit: OfficeAuditEntry[];
  /** Present when the export asked for room snapshots too (read-only record). */
  boards?: Record<string, TaskBoard>;
  /** Digest over everything above; never covered by its own digest. */
  integrity?: OfficeBackupIntegrity;
}

/**
 * JSON with object keys in a fixed order.
 *
 * `JSON.stringify` follows insertion order, so the same office exported twice
 * (or re-serialised by a person's editor) produces different bytes and the
 * digest would fail for a file nobody touched. Sorting keys makes the digest a
 * statement about content, which is the only useful kind.
 */
export function canonicalJson(value: unknown): string {
  if (value === null || value === undefined) return 'null';
  if (typeof value === 'number') return Number.isFinite(value) ? JSON.stringify(value) : 'null';
  if (typeof value === 'string' || typeof value === 'boolean') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(item => canonicalJson(item)).join(',')}]`;
  if (typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, item]) => item !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`).join(',')}}`;
  }
  return 'null';
}

/** The payload the digest covers: the whole backup minus its own integrity block. */
export function backupPayload(backup: Record<string, unknown>): Record<string, unknown> {
  const { integrity: _ignored, ...rest } = backup;
  return rest;
}

export function backupDigest(backup: Record<string, unknown>): string {
  return sha256HexSync(canonicalJson(backupPayload(backup)));
}

export async function backupChecksum(backup: Record<string, unknown>): Promise<string> {
  return backupDigest(backup);
}

export type ChecksumVerdict = 'verified' | 'missing' | 'mismatch';

export function verifyBackupChecksum(backup: Record<string, unknown>): { verdict: ChecksumVerdict; stored?: string; computed: string } {
  const computed = backupDigest(backup);
  const integrity = backup.integrity as Partial<OfficeBackupIntegrity> | undefined;
  if (!integrity || typeof integrity.digest !== 'string' || !integrity.digest) {
    return { verdict: 'missing', computed };
  }
  return integrity.digest === computed
    ? { verdict: 'verified', stored: integrity.digest, computed }
    : { verdict: 'mismatch', stored: integrity.digest, computed };
}

export class OfficeBackupError extends Error {
  constructor(message: string, readonly code: string, readonly status = 400) {
    super(message);
    this.name = 'OfficeBackupError';
  }
}

export interface BackupSummary {
  agents: number;
  projects: number;
  templates: number;
  archives: number;
  audit: number;
  /** Deliverables recorded across the archives — the part that must survive. */
  deliverables: number;
  boards: number;
  exportedAt?: number;
  exportedBy?: string;
  settingsBudget?: number;
}

export interface BackupValidation {
  /** Safe to restore as far as this module can tell (shape + checksum). */
  ok: boolean;
  /**
   * Shape and version only, without the checksum verdict.
   *
   * A checksum mismatch is a *decision* (restore anyway, deliberately) rather
   * than a malformed file, so the restore path needs to tell the two apart:
   * a broken shape can never be written, a changed file can be, with the
   * explicit flag whose whole point is that somebody chose it.
   */
  shapeOk: boolean;
  issues: string[];
  warnings: string[];
  summary: BackupSummary;
  checksum: { verdict: ChecksumVerdict; stored?: string; computed: string };
}

const isObject = (value: unknown): value is Record<string, unknown> =>
  Boolean(value) && typeof value === 'object' && !Array.isArray(value);

const countIfArray = (value: unknown) => (Array.isArray(value) ? value.length : 0);

/**
 * Check the shape of a backup before a restore touches anything.
 *
 * Structural only: it does not look at storage, so a dry run costs nothing and
 * the same verdict reaches the browser preview and the server. `issues` block a
 * restore; `warnings` are things the boss should see but that are legitimate
 * (an archive with no messages, an export without boards).
 */
export function validateOfficeBackup(input: unknown): BackupValidation {
  const issues: string[] = [];
  const warnings: string[] = [];
  const summary: BackupSummary = {
    agents: 0, projects: 0, templates: 0, archives: 0, audit: 0, deliverables: 0, boards: 0,
  };
  const computed = isObject(input) ? backupDigest(input) : sha256HexSync('');
  let checksum: BackupValidation['checksum'] = { verdict: 'missing', computed };

  if (!isObject(input)) {
    return { ok: false, shapeOk: false, issues: ['The file is not a JSON object.'], warnings, summary, checksum };
  }
  const backup = input;

  if (backup.format !== OFFICE_BACKUP_FORMAT) {
    issues.push(`This is not an office backup (format must be "${OFFICE_BACKUP_FORMAT}").`);
  }
  if (backup.version !== OFFICE_BACKUP_VERSION) {
    issues.push(`Unsupported backup version ${String(backup.version)}; this server reads version ${OFFICE_BACKUP_VERSION}.`);
  }
  for (const field of ['agents', 'projects', 'templates', 'archives', 'audit'] as const) {
    if (backup[field] !== undefined && !Array.isArray(backup[field])) {
      issues.push(`"${field}" must be a list.`);
    }
  }
  if (backup.settings !== undefined && !isObject(backup.settings)) {
    issues.push('"settings" must be an object.');
  }

  const agents = (Array.isArray(backup.agents) ? backup.agents : []) as Partial<OfficeAgent>[];
  const projects = (Array.isArray(backup.projects) ? backup.projects : []) as Partial<OfficeProject>[];
  const templates = (Array.isArray(backup.templates) ? backup.templates : []) as Partial<OfficeTemplate>[];
  const archives = (Array.isArray(backup.archives) ? backup.archives : []) as Partial<OfficeArchive>[];
  const audit = (Array.isArray(backup.audit) ? backup.audit : []) as Partial<OfficeAuditEntry>[];

  const malformed = (rows: Array<Record<string, unknown>>, label: string, check: (row: Record<string, unknown>) => boolean) => {
    const bad = rows.filter(row => !check(row)).length;
    if (bad > 0) warnings.push(`${bad} ${label}${bad === 1 ? '' : 's'} cannot be restored and will be skipped.`);
  };
  malformed(agents as Array<Record<string, unknown>>, 'agent', row => Boolean(row.id && row.name && row.role));
  malformed(projects as Array<Record<string, unknown>>, 'project', row => Boolean(row.id && row.name));
  malformed(templates as Array<Record<string, unknown>>, 'template', row => Boolean(row.id && row.name && Array.isArray(row.tasks)));
  malformed(archives as Array<Record<string, unknown>>, 'archive', row => Boolean(row.id && row.roomCode));

  const seenAgents = new Set<string>();
  for (const agent of agents) {
    const name = typeof agent.name === 'string' ? agent.name.trim().toLowerCase() : '';
    if (!name) continue;
    if (seenAgents.has(name)) warnings.push(`Two agents are named "${agent.name}"; the second will be skipped by a merge.`);
    seenAgents.add(name);
  }

  const deliverables = archives.reduce((total, archive) => total + countIfArray(archive.deliverables), 0);
  const boards = isObject(backup.boards) ? Object.keys(backup.boards).length : 0;
  if (boards > 0) warnings.push('Room boards in the file are a read-only record; a restore never writes them.');

  summary.agents = agents.length;
  summary.projects = projects.length;
  summary.templates = templates.length;
  summary.archives = archives.length;
  summary.audit = audit.length;
  summary.deliverables = deliverables;
  summary.boards = boards;
  if (typeof backup.exportedAt === 'number') summary.exportedAt = backup.exportedAt;
  if (typeof backup.exportedBy === 'string') summary.exportedBy = backup.exportedBy;
  const settings = isObject(backup.settings) ? backup.settings : undefined;
  if (settings && Number.isFinite(Number(settings.dailyRequestBudget))) summary.settingsBudget = Number(settings.dailyRequestBudget);

  checksum = verifyBackupChecksum(backup);
  if (checksum.verdict === 'missing') {
    warnings.push('This file has no checksum (exported before integrity stamps); the shape check above is all that protects it.');
  }

  const shapeOk = issues.length === 0;
  return { ok: shapeOk && checksum.verdict !== 'mismatch', shapeOk, issues, warnings, summary, checksum };
}
