// The outbox, on its own: a queue of rows, not of attempts.
//
// These tests never touch Notion. `drainOutbox` takes the function that runs one
// event, so the behaviour that matters can be stated exactly — dedupe by row,
// oldest first, one attempt per drain, five strikes and out, a list that cannot
// grow past 500, and an item that expires underneath its own id.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { UpstashClient } from '@agent-room/upstash-client';
import type { OfficeArchive } from '@agent-room/shared';
import { installFakeRedis, type FakeRedis } from '../packages/upstash-client/test/fakeRedis.js';
import {
  OUTBOX_ITEM_PREFIX,
  OUTBOX_ITEM_TTL_SECONDS,
  OUTBOX_LIST_KEY,
  OUTBOX_MAX_ATTEMPTS,
  OUTBOX_MAX_ITEMS,
  drainOutbox,
  enqueueOutbox,
  eventSourceId,
  listOutbox,
  outboxDepth,
  outboxItemId,
  readOutboxItem,
} from './_notion/outbox.js';
import type { SyncEvent } from './_notion/sync.js';
import { officeStore } from './_office.js';

let fake: FakeRedis;
let store: UpstashClient;

beforeEach(() => {
  process.env.UPSTASH_REDIS_REST_URL = 'https://example.upstash.io';
  process.env.UPSTASH_REDIS_REST_TOKEN = 't';
  fake = installFakeRedis();
  store = officeStore();
});

afterEach(() => {
  delete process.env.UPSTASH_REDIS_REST_URL;
  delete process.env.UPSTASH_REDIS_REST_TOKEN;
});

function archive(id: string): OfficeArchive {
  return {
    id,
    roomCode: `ROOM-${id}`,
    topic: `회의 ${id}`,
    createdBy: 'owner',
    roomCreatedAt: 1,
    archivedAt: 2,
    participants: [],
    messageCount: 3,
    summary: 's',
    minutes: 'm',
    messages: [],
    tasks: [],
    tags: [],
  };
}

function meeting(id: string): SyncEvent {
  return { kind: 'meeting.archived', archive: archive(id) };
}

describe('outbox queue', () => {
  it('names an item after the row it is about, and stores it as JSON with a 7 day life', async () => {
    const event = meeting('arc_1');
    const queued = await enqueueOutbox(store, event, new Error('down'));
    expect(queued.created).toBe(true);
    expect(queued.id).toBe('meeting.archived:arc_1');
    expect(eventSourceId(event)).toBe('arc_1');
    expect(outboxItemId(event)).toBe('meeting.archived:arc_1');

    const item = await readOutboxItem(store, queued.id);
    expect(item?.attempts).toBe(1);
    expect(item?.lastError).toBe('down');
    expect((item?.event as { archive: OfficeArchive }).archive.id).toBe('arc_1');
    const write = fake.log.find(cmd => String(cmd[0]).toUpperCase() === 'SET'
      && String(cmd[1]).startsWith(OUTBOX_ITEM_PREFIX)) as unknown[];
    expect(Number(write[4])).toBe(OUTBOX_ITEM_TTL_SECONDS);
  });

  it('keeps one item per row: repeated failures bump attempts instead of stacking', async () => {
    await enqueueOutbox(store, meeting('arc_1'));
    const second = await enqueueOutbox(store, meeting('arc_1'));
    expect(second.created).toBe(false);
    expect(second.attempts).toBe(2);
    expect((await outboxDepth(store)).pending).toBe(1);
    expect(await listOutbox(store)).toEqual(['meeting.archived:arc_1']);
  });

  it('caps the list at 500 ids', async () => {
    for (let index = 0; index < OUTBOX_MAX_ITEMS + 5; index += 1) {
      await enqueueOutbox(store, meeting(`arc_${index}`));
    }
    const ids = await listOutbox(store, OUTBOX_MAX_ITEMS + 10);
    expect(ids.length).toBe(OUTBOX_MAX_ITEMS);
  });
});

describe('outbox drain', () => {
  it('processes the oldest items first and deletes what it wrote', async () => {
    for (const id of ['arc_old', 'arc_mid', 'arc_new']) await enqueueOutbox(store, meeting(id));
    const seen: string[] = [];
    const results = await drainOutbox(store, {
      limit: 2,
      run: async event => {
        seen.push((event as { archive: OfficeArchive }).archive.id);
        return { ok: true, action: 'created', pageId: 'page_1' };
      },
    });
    expect(seen).toEqual(['arc_old', 'arc_mid']);
    expect(results.every(result => result.ok)).toBe(true);
    expect((await outboxDepth(store)).pending).toBe(1);
    expect(await readOutboxItem(store, 'meeting.archived:arc_old')).toBeNull();
  });

  it('keeps a failure at the back of the queue and counts the attempt', async () => {
    await enqueueOutbox(store, meeting('arc_a'));
    await enqueueOutbox(store, meeting('arc_b'));
    const results = await drainOutbox(store, {
      limit: 2,
      run: async event => {
        const id = (event as { archive: OfficeArchive }).archive.id;
        return id === 'arc_a' ? { ok: false, reason: 'boom' } : { ok: true, action: 'created' };
      },
    });
    expect(results.find(result => result.id.includes('arc_a'))?.ok).toBe(false);
    const item = await readOutboxItem(store, 'meeting.archived:arc_a');
    expect(item?.attempts).toBe(2);
    expect(await listOutbox(store)).toEqual(['meeting.archived:arc_a']);
  });

  it(`buries an item after ${OUTBOX_MAX_ATTEMPTS} attempts`, async () => {
    await enqueueOutbox(store, meeting('arc_dead'));
    const fail = async () => ({ ok: false, reason: 'still down' });
    // The first failure was the enqueue itself, so four drains reach the limit.
    for (let attempt = 0; attempt < OUTBOX_MAX_ATTEMPTS - 1; attempt += 1) {
      await drainOutbox(store, { limit: 1, run: fail });
    }
    let depth = await outboxDepth(store);
    expect(depth.pending).toBe(1);
    expect(depth.dead).toBe(0);

    const last = await drainOutbox(store, { limit: 1, run: fail });
    expect(last[0]?.dead).toBe(true);
    depth = await outboxDepth(store);
    expect(depth.pending).toBe(0);
    expect(depth.dead).toBe(1);
    // The payload is kept for a week so a person can see what was dropped.
    expect(await readOutboxItem(store, 'meeting.archived:arc_dead')).toBeTruthy();
  });

  it('skips an id whose payload has expired instead of failing the drain', async () => {
    await enqueueOutbox(store, meeting('arc_gone'));
    fake.store.delete(`${OUTBOX_ITEM_PREFIX}meeting.archived:arc_gone`);
    const results = await drainOutbox(store, { limit: 5, run: async () => ({ ok: true }) });
    expect(results).toHaveLength(1);
    expect(results[0]?.action).toBe('skipped');
    expect((await outboxDepth(store)).pending).toBe(0);
  });

  it('lets only one of two overlapping drains take an item', async () => {
    await enqueueOutbox(store, meeting('arc_once'));
    let ran = 0;
    const run = async () => { ran += 1; return { ok: true, action: 'created' as const }; };
    const [first, second] = await Promise.all([
      drainOutbox(store, { limit: 1, run }),
      drainOutbox(store, { limit: 1, run }),
    ]);
    expect(ran).toBe(1);
    expect(first.length + second.length).toBe(1);
    expect(fake.store.has(OUTBOX_LIST_KEY) ? (fake.store.get(OUTBOX_LIST_KEY) as string[]).length : 0).toBe(0);
  });

  it('reports each outcome to the caller so it can be audited', async () => {
    await enqueueOutbox(store, meeting('arc_audit'));
    const seen: string[] = [];
    await drainOutbox(store, {
      limit: 1,
      run: async () => ({ ok: true, action: 'updated', pageId: 'page_9' }),
      onResult: async result => { seen.push(`${result.id}:${result.action}:${result.pageId}`); },
    });
    expect(seen).toEqual(['meeting.archived:arc_audit:updated:page_9']);
  });
});
