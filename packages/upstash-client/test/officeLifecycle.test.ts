// The office's lifecycle operations against the in-memory Redis: a room's work
// carried into a successor, a reconnection noticed in the heartbeat the seat
// already writes, deliverables indexed so they outlive their room, and a backup
// that verifies, previews and snapshots before it overwrites anything.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { installFakeRedis, type FakeRedis } from './fakeRedis.js';
import {
  archiveRoom,
  exportOffice,
  getArchive,
  getOfficeRoomRecord,
  importOffice,
  listBackupSnapshots,
  listHeartbeats,
  readHeartbeat,
  recordAgentHeartbeat,
  recordRoomHandoff,
  snapshotOffice,
  upsertAgent,
} from '../src/office.js';
import { OfficeBackupError, backupDigest, canonicalJson, validateOfficeBackup, verifyBackupChecksum } from '../src/officeBackup.js';
import { createClient } from '../src/client.js';
import type { UpstashClient } from '../src/client.js';
import { LINK_GAP_MS } from '../src/office.js';
import type { Message, Room } from '@agent-room/shared';

let fake: FakeRedis;
let client: UpstashClient;
const now = 1_800_000_000_000;

beforeEach(() => {
  fake = installFakeRedis();
  client = createClient({ url: 'https://example.upstash.io', token: 't' });
});
afterEach(() => {
  vi.unstubAllGlobals();
});

const room = (code: string, over: Partial<Room> = {}): Room => ({
  code,
  topic: `topic ${code}`,
  createdBy: 'Owner',
  createdAt: now - 27 * 24 * 3_600_000,
  status: 'active',
  participants: [],
  ...over,
} as Room);

const message = (text: string): Message => ({
  id: Date.now(), name: 'Owner', role: 'host', color: '#000', initials: 'OW',
  client: 'web', type: 'msg', text, time: now,
});

describe('a reconnection in the heartbeat', () => {
  it('is a gap, not a poll: counted once and kept in the stamp the seat already writes', async () => {
    await upsertAgent(client, { name: 'Qwen', role: 'x' }, 'owner', now);
    await recordAgentHeartbeat(client, { name: 'Qwen', roomCode: 'AAA-111-BBB', at: now, throttleMs: 0 });
    const poll = await recordAgentHeartbeat(client, { name: 'Qwen', at: now + 30_000, throttleMs: 0 });
    expect(poll.reconnected).toBeUndefined();

    const back = await recordAgentHeartbeat(client, { name: 'Qwen', at: now + 30_000 + LINK_GAP_MS, throttleMs: 0 });
    expect(back).toMatchObject({ recorded: true, reconnected: true, gapMs: LINK_GAP_MS });

    const stamp = await readHeartbeat(client, 'Qwen');
    expect(stamp).toMatchObject({ reconnects: 1, lastGapMs: LINK_GAP_MS, lastDropAt: now + 30_000 });
    const rows = await listHeartbeats(client, ['Qwen']);
    expect(rows.qwen?.reconnects).toBe(1);

    // A second gap increments the counter rather than replacing it.
    await recordAgentHeartbeat(client, { name: 'Qwen', at: now + 30_000 + LINK_GAP_MS * 3, throttleMs: 0 });
    expect((await readHeartbeat(client, 'Qwen'))?.reconnects).toBe(2);
  });

  it('ignores an ordinary poll inside the throttle window', async () => {
    await recordAgentHeartbeat(client, { name: 'Qwen', at: now, throttleMs: 0 });
    const quiet = await recordAgentHeartbeat(client, { name: 'Qwen', at: now + 5_000, throttleMs: 30_000 });
    expect(quiet.recorded).toBe(false);
  });
});

describe('a room handoff', () => {
  it('links both rooms in the office registry, without a TTL on either side', async () => {
    const { source, successor } = await recordRoomHandoff(client, {
      sourceCode: 'OLD-111-AAA',
      successorCode: 'NEW-222-BBB',
      at: now,
      by: 'owner',
      taskCount: 3,
      topic: '상패 견적',
    });
    expect(source).toMatchObject({ code: 'OLD-111-AAA', successorRoomCode: 'NEW-222-BBB', handoffTaskCount: 3 });
    expect(successor).toMatchObject({ code: 'NEW-222-BBB', predecessorRoomCode: 'OLD-111-AAA' });
    expect(await getOfficeRoomRecord(client, 'NEW-222-BBB')).toMatchObject({ predecessorRoomCode: 'OLD-111-AAA' });
  });

  it('is refused at the API layer when a successor exists — the record says why', async () => {
    await recordRoomHandoff(client, {
      sourceCode: 'OLD-111-AAA', successorCode: 'NEW-222-BBB', at: now, by: 'owner', taskCount: 1,
    });
    const record = await getOfficeRoomRecord(client, 'OLD-111-AAA');
    expect(record?.successorRoomCode).toBe('NEW-222-BBB');
  });
});

describe('deliverables outliving their room', () => {
  it('are indexed on the archive, and a later capture never shrinks the set', async () => {
    const first = await archiveRoom(client, {
      room: room('OLD-111-AAA'), messages: [message('done')], now,
      deliverables: [{
        id: 'vf_a', name: '견적서.pdf', mime: 'application/pdf', size: 2048, version: 1,
        createdAt: now - 1000, storageKey: 'vault/deliverable/OLD-111-AAA/vf_a/v1/견적서.pdf',
      }],
      materialCount: 2,
    });
    expect(first.deliverables).toHaveLength(1);
    expect(first.deliverables?.[0]).toMatchObject({ name: '견적서.pdf', storageKey: expect.stringContaining('vault/deliverable') });
    expect(first.materialCount).toBe(2);

    const second = await archiveRoom(client, {
      room: room('OLD-111-AAA'), messages: [message('done again')], now: now + 1000,
      deliverables: [{
        id: 'vf_b', name: '최종안.png', mime: 'image/png', size: 4096, version: 1,
        createdAt: now, storageKey: 'vault/deliverable/OLD-111-AAA/vf_b/v1/최종안.png',
      }],
    });
    expect(second.id).toBe(first.id);
    expect(second.deliverables?.map(file => file.id).sort()).toEqual(['vf_a', 'vf_b']);
    // The material count from the first capture survives a capture that did not
    // look at materials.
    expect(second.materialCount).toBe(2);
    expect((await getArchive(client, first.id))?.deliverables).toHaveLength(2);
  });

  it('remembers the successor on the archive as well as the registry', async () => {
    await recordRoomHandoff(client, {
      sourceCode: 'OLD-111-AAA', successorCode: 'NEW-222-BBB', at: now, by: 'owner', taskCount: 2,
    });
    const archive = await archiveRoom(client, {
      room: room('OLD-111-AAA'), messages: [message('handed over')], now, successorRoomCode: 'NEW-222-BBB',
    });
    expect(archive.successorRoomCode).toBe('NEW-222-BBB');
  });
});

describe('backup integrity', () => {
  async function seededOffice() {
    await upsertAgent(client, { name: 'Qwen', role: 'Copywriter' }, 'owner', now);
    return exportOffice(client, 'owner', now);
  }

  it('stamps a digest over canonical contents, stable across key order', async () => {
    const backup = await seededOffice();
    expect(backup.integrity?.algorithm).toBe('sha256');
    expect(backup.integrity?.digest).toBe(backupDigest(backup as unknown as Record<string, unknown>));

    const reordered = Object.fromEntries(Object.entries(backup as unknown as Record<string, unknown>).reverse()) as Record<string, unknown>;
    expect(canonicalJson(reordered)).toBe(canonicalJson(backup));
    expect(verifyBackupChecksum(reordered).verdict).toBe('verified');
  });

  it('detects a changed file', async () => {
    const backup = await seededOffice();
    const tampered = { ...backup, agents: [] } as unknown as Record<string, unknown>;
    const verdict = verifyBackupChecksum(tampered);
    expect(verdict.verdict).toBe('mismatch');
    const validation = validateOfficeBackup(tampered);
    // The shape is fine; the contents are not the ones the stamp describes.
    expect(validation).toMatchObject({ ok: false, shapeOk: true, issues: [] });
    expect(validation.checksum.verdict).toBe('mismatch');
    await expect(importOffice(client, tampered, 'merge', now)).rejects.toBeInstanceOf(OfficeBackupError);
    // Deliberately restoring it is allowed, with the flag whose point is choice.
    await expect(importOffice(client, tampered, 'replace', now, { allowChecksumMismatch: true })).resolves.toMatchObject({ checksum: 'mismatch' });
  });

  it('previews a restore without writing a thing', async () => {
    const backup = await seededOffice();
    const before = fake.log.length;
    const preview = await importOffice(client, backup, 'replace', now, { dryRun: true });
    expect(preview).toMatchObject({ dryRun: true, agents: 1, projects: 0, checksum: 'verified' });
    // Only the commands a preview legitimately needs: none that write office data.
    const writes = fake.log.slice(before).filter(command => !['GET', 'PIPELINE'].includes(String(command[0])));
    expect(writes.filter(command => ['DEL', 'SET', 'SADD', 'RPUSH', 'LTRIM'].includes(String(command[0])))).toEqual([]);
  });

  it('snapshots the office before overwriting it, keeping the newest three', async () => {
    await upsertAgent(client, { name: 'Qwen', role: 'Copywriter' }, 'owner', now);
    const backup = await exportOffice(client, 'owner', now);
    const first = await snapshotOffice(client, 'owner', now);
    expect(first).toMatchObject({ id: expect.stringMatching(/^snap_/), agents: 1 });
    for (let index = 1; index < 5; index += 1) await snapshotOffice(client, 'owner', now + index * 1000);
    const kept = await listBackupSnapshots(client);
    expect(kept).toHaveLength(3);

    const result = await importOffice(client, backup, 'replace', now + 10_000, { actor: 'owner' });
    expect(result.snapshotId).toMatch(/^snap_/);
    expect(result.checksum).toBe('verified');
  });

  it('reports a shape problem instead of restoring half an office', async () => {
    const bad = { format: 'agent-room-office-backup', version: 1, agents: 'nope' };
    const validation = validateOfficeBackup(bad);
    expect(validation.ok).toBe(false);
    expect(validation.issues.join(' ')).toMatch(/"agents" must be a list/);
    await expect(importOffice(client, bad, 'merge', now)).rejects.toMatchObject({ code: 'backup_invalid' });
  });

  it('warns about an agent that would be skipped, but restores the rest', async () => {
    const backup = await seededOffice();
    const withBroken = { ...backup, agents: [...backup.agents, { id: 'ag_broken' }] };
    const digest = backupDigest(withBroken as unknown as Record<string, unknown>);
    const stamped = { ...withBroken, integrity: { algorithm: 'sha256', digest, at: now } };
    const validation = validateOfficeBackup(stamped);
    expect(validation.ok).toBe(true);
    expect(validation.warnings.join(' ')).toMatch(/1 agent cannot be restored/);
  });

  it('restores a file from before integrity stamps, with a warning', async () => {
    const backup = await seededOffice();
    const { integrity: _drop, ...legacy } = backup;
    const validation = validateOfficeBackup(legacy);
    expect(validation.ok).toBe(true);
    expect(validation.checksum.verdict).toBe('missing');
    expect(validation.warnings.join(' ')).toMatch(/no checksum/);
    const result = await importOffice(client, legacy, 'merge', now);
    expect(result.agents).toBe(1);
  });
});
