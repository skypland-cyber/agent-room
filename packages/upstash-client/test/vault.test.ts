// The vault's metadata store, against the in-memory Redis stand-in.
//
// What these tests protect: a record round-trips with its history, indexes stay
// correct after a move/retag/delete (a stale task link is how a board shows a
// file that is not there), and nothing a material writes outlives the room by
// accident — while deliverables must never be given a TTL.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { VaultFile } from '@agent-room/shared';
import { installFakeRedis, type FakeRedis } from './fakeRedis.js';
import { createClient } from '../src/client.js';
import { createRoom } from '../src/rooms.js';
import { createTask, setTaskFiles } from '../src/tasks.js';
import {
  addVaultVersion,
  assertVaultCapacity,
  attachVaultFileToTask,
  createVaultFolder,
  deleteVaultFile,
  deleteVaultFolder,
  getVaultFile,
  listVaultFiles,
  listVaultFolders,
  newVaultFileId,
  putVaultFile,
  searchVaultFiles,
  updateVaultFile,
  vaultFilesForTask,
  vaultIdsKey,
  vaultUsage,
  VaultLimitError,
} from '../src/vault.js';

let fake: FakeRedis;
const client = () => createClient({ url: 'https://example.upstash.io', token: 't' });

beforeEach(() => {
  fake = installFakeRedis();
});
afterEach(() => {
  vi.unstubAllGlobals();
});

function record(overrides: Partial<VaultFile> = {}): VaultFile {
  return {
    id: 'vf_0000000000000001',
    kind: 'material',
    code: 'ABC-DEF-GHJ',
    name: 'quote.xlsx',
    size: 1024,
    mime: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    category: 'spreadsheet',
    storageKey: 'vault/material/ABC-DEF-GHJ/vf_0000000000000001/v1/quote.xlsx',
    tags: ['quote'],
    createdAt: 1,
    updatedAt: 1,
    uploadedBy: 'Host',
    uploadedByClient: 'web',
    version: 1,
    versions: [{
      version: 1, storageKey: 'vault/material/ABC-DEF-GHJ/vf_0000000000000001/v1/quote.xlsx',
      name: 'quote.xlsx', size: 1024, mime: 'application/octet-stream', createdAt: 1,
      createdBy: 'Host', createdByClient: 'web',
    }],
    ...overrides,
  };
}

/** Every command the store sent, so we can assert on TTL behaviour. */
const commandsFor = (key: string) => fake.log.filter(cmd => cmd.some(arg => String(arg) === key));

describe('vault records', () => {
  it('round-trips a record and finds it by id', async () => {
    const file = record();
    await putVaultFile(client(), file);
    const loaded = await getVaultFile(client(), 'material', file.code, file.id);
    expect(loaded).toMatchObject({ id: file.id, name: 'quote.xlsx', version: 1 });
    expect(loaded?.versions).toHaveLength(1);
  });

  it('gives materials a TTL and deliverables none', async () => {
    const material = record();
    const deliverable = record({ id: 'vf_0000000000000002', kind: 'deliverable', code: 'ABC-DEF-GHJ' });
    await putVaultFile(client(), material);
    await putVaultFile(client(), deliverable);
    const materialSet = commandsFor(`vault:material:${material.code}:file:${material.id}`)[0]!;
    expect(materialSet).toContain('EX');
    const deliverableSet = commandsFor(`vault:deliverable:${deliverable.code}:file:${deliverable.id}`)[0]!;
    expect(deliverableSet).not.toContain('EX');
    // The record lives under the vault prefix, never under the room-attachment
    // prefix that ending a meeting deletes.
    expect(deliverable.storageKey.startsWith('vault/')).toBe(true);
    expect(deliverable.storageKey.startsWith('rooms/')).toBe(false);
  });

  it('sorts newest first and filters by folder, tag, task and query', async () => {
    const older = record({ id: 'vf_0000000000000011', createdAt: 10, updatedAt: 10, tags: ['acme'] });
    const newer = record({ id: 'vf_0000000000000012', createdAt: 20, updatedAt: 20, folderId: 'fd_a', tags: ['acme', 'draft'], taskId: 'T-01', extractedText: '합계 1,200,000원' });
    await putVaultFile(client(), older);
    await putVaultFile(client(), newer);

    const all = await listVaultFiles(client(), 'material', 'ABC-DEF-GHJ');
    expect(all.map(f => f.id)).toEqual(['vf_0000000000000012', 'vf_0000000000000011']);
    expect((await listVaultFiles(client(), 'material', 'ABC-DEF-GHJ', { folderId: 'fd_a' })).map(f => f.id)).toEqual(['vf_0000000000000012']);
    expect((await listVaultFiles(client(), 'material', 'ABC-DEF-GHJ', { folderId: null })).map(f => f.id)).toEqual(['vf_0000000000000011']);
    expect((await listVaultFiles(client(), 'material', 'ABC-DEF-GHJ', { tag: 'draft' })).map(f => f.id)).toEqual(['vf_0000000000000012']);
    expect((await listVaultFiles(client(), 'material', 'ABC-DEF-GHJ', { taskId: 'T-01' })).map(f => f.id)).toEqual(['vf_0000000000000012']);
    expect((await listVaultFiles(client(), 'material', 'ABC-DEF-GHJ', { query: '1,200,000' })).map(f => f.id)).toEqual(['vf_0000000000000012']);
    expect((await listVaultFiles(client(), 'material', 'ABC-DEF-GHJ', { limit: 1 }))).toHaveLength(1);
  });

  it('searches both vaults at once', async () => {
    await putVaultFile(client(), record({ id: 'vf_0000000000000021', name: '견적서.xlsx' }));
    await putVaultFile(client(), record({ id: 'vf_0000000000000022', kind: 'deliverable', name: '견적서 요약.md', storageKey: 'vault/deliverable/ABC-DEF-GHJ/vf_0000000000000022/v1/x.md' }));
    const hits = await searchVaultFiles(client(), 'ABC-DEF-GHJ', '견적서');
    expect(hits.map(f => f.kind).sort()).toEqual(['deliverable', 'material']);
  });

  it('keeps tag and task indexes in step with an update', async () => {
    const file = record({ taskId: 'T-01' });
    await putVaultFile(client(), file);
    const updated = await updateVaultFile(client(), 'material', file.code, file.id, current => ({ ...current, tags: ['acme'], taskId: 'T-02' }));
    expect(updated?.tags).toEqual(['acme']);

    expect(await vaultFilesForTask(client(), file.code, 'T-01')).toHaveLength(0);
    expect((await vaultFilesForTask(client(), file.code, 'T-02')).map(f => f.id)).toEqual([file.id]);
    expect((await listVaultFiles(client(), 'material', file.code, { tag: 'quote' }))).toHaveLength(0);
    expect((await listVaultFiles(client(), 'material', file.code, { tag: 'acme' }))).toHaveLength(1);
  });

  it('drops the task link when a file is deleted', async () => {
    const file = record();
    await putVaultFile(client(), file);
    await attachVaultFileToTask(client(), 'material', file.code, file.id, 'T-01');
    expect(await vaultFilesForTask(client(), file.code, 'T-01')).toHaveLength(1);
    await deleteVaultFile(client(), 'material', file.code, file.id);
    expect(await getVaultFile(client(), 'material', file.code, file.id)).toBeNull();
    expect(await vaultFilesForTask(client(), file.code, 'T-01')).toHaveLength(0);
    expect((fake.store.get(vaultIdsKey('material', file.code)) as Set<string>)?.size ?? 0).toBe(0);
  });

  it('prunes versions past the window and reports the keys to delete', async () => {
    const file = record();
    await putVaultFile(client(), file);
    let pruned: string[] = [];
    for (let version = 2; version <= 22; version++) {
      const result = await addVaultVersion(client(), 'material', file.code, file.id, {
        version, storageKey: `vault/material/${file.code}/${file.id}/v${version}/quote.xlsx`,
        name: 'quote.xlsx', size: 2048, mime: 'application/octet-stream', createdAt: version,
        createdBy: 'Alpha', createdByClient: 'cc',
      });
      pruned = pruned.concat(result?.prunedKeys ?? []);
    }
    const loaded = await getVaultFile(client(), 'material', file.code, file.id);
    expect(loaded?.version).toBe(22);
    expect(loaded?.versions).toHaveLength(20);
    expect(loaded?.versions.at(-1)?.version).toBe(22);
    expect(pruned[0]).toContain('/v1/');
  });

  it('counts usage across both vaults', async () => {
    await putVaultFile(client(), record({ id: 'vf_0000000000000031', size: 1000 }));
    await putVaultFile(client(), record({ id: 'vf_0000000000000032', kind: 'deliverable', size: 3000, storageKey: 'vault/deliverable/ABC-DEF-GHJ/x/v1/y' }));
    const usage = await vaultUsage(client(), 'ABC-DEF-GHJ');
    expect(usage).toMatchObject({ bytes: 4000, materials: { files: 1, bytes: 1000 }, deliverables: { files: 1, bytes: 3000 } });
  });

  it('refuses a room that is over its budget before the bytes are stored', async () => {
    await putVaultFile(client(), record({ size: 5 * 1024 * 1024 }));
    await expect(assertVaultCapacity(client(), 'ABC-DEF-GHJ', 'material', 6 * 1024 * 1024, 10 * 1024 * 1024))
      .rejects.toBeInstanceOf(VaultLimitError);
    await expect(assertVaultCapacity(client(), 'ABC-DEF-GHJ', 'material', 1024, 10 * 1024 * 1024)).resolves.toBeUndefined();
  });

  it('mints ids that satisfy the id format the paths expect', async () => {
    const id = await newVaultFileId();
    expect(id).toMatch(/^vf_[a-f0-9]{16}$/);
    expect(await newVaultFileId()).not.toBe(id);
  });
});

describe('vault folders', () => {
  it('creates, lists and deletes a folder, detaching its files', async () => {
    const folder = await createVaultFolder(client(), 'ABC-DEF-GHJ', { name: '견적 자료', createdBy: 'Host' });
    expect(folder.name).toBe('견적 자료');
    expect((await listVaultFolders(client(), 'ABC-DEF-GHJ')).map(f => f.id)).toEqual([folder.id]);

    await putVaultFile(client(), record({ folderId: folder.id }));
    const result = await deleteVaultFolder(client(), 'ABC-DEF-GHJ', folder.id);
    expect(result).toEqual({ deleted: true, detached: 1 });
    expect((await listVaultFolders(client(), 'ABC-DEF-GHJ'))).toHaveLength(0);
    const files = await listVaultFiles(client(), 'material', 'ABC-DEF-GHJ');
    expect(files[0]?.folderId).toBeUndefined();
    expect((await deleteVaultFolder(client(), 'ABC-DEF-GHJ', folder.id)).deleted).toBe(false);
  });
});

describe('task links on the board', () => {
  it('appends vault ids to the task without growing on a repeat', async () => {
    await createRoom(client(), { code: 'ABC-DEF-GHJ', topic: 'Files', createdBy: 'Host' });
    await createTask(client(), 'ABC-DEF-GHJ', { title: 'Make the deck', createdBy: 'Host' });

    const first = await setTaskFiles(client(), 'ABC-DEF-GHJ', 'T-01', { deliverables: ['vf_0000000000000001'] });
    expect(first.task.files).toEqual({ deliverables: ['vf_0000000000000001'] });

    const second = await setTaskFiles(client(), 'ABC-DEF-GHJ', 'T-01', {
      deliverables: ['vf_0000000000000001', 'vf_0000000000000002'],
      inputs: ['vf_0000000000000003'],
    });
    expect(second.task.files).toEqual({ deliverables: ['vf_0000000000000001', 'vf_0000000000000002'], inputs: ['vf_0000000000000003'] });

    const noop = await setTaskFiles(client(), 'ABC-DEF-GHJ', 'T-01', { deliverables: [] });
    expect(noop.board.version).toBe(second.board.version);
  });
});
