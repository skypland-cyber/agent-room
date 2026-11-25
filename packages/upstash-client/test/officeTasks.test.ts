// Office control over the task board: the boss's approval gate, pause, abort,
// peer QA and the bounded retry. These all live behind the same board CAS, so
// the assertions here are about the board actually refusing things — a claim
// before approval, a producer QA-ing itself, a retry beyond the ceiling.
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  abortTask,
  claimTask,
  createTask,
  decideTaskApproval,
  getTaskBoard,
  pauseTask,
  recordTaskQa,
  requireTaskApproval,
  retryTask,
  submitTask,
  unpauseTask,
  verifyTask,
} from '../src/index.js';
import { createClient } from '../src/client.js';
import type { UpstashClient } from '../src/client.js';
import { installFakeRedis, type FakeRedis } from './fakeRedis.js';

const CODE = 'OFF-CSE-234';
const OWNER = { name: 'Qwen', client: 'cc' as const };
const VERIFIER = { name: 'GPT', client: 'cc' as const };
const BOSS = { name: 'Owner', client: 'web' as const };
const QA = { name: 'Pixel', client: 'cc' as const };

let fake: FakeRedis;
let client: UpstashClient;
const now = 1_800_000_000_000;

beforeEach(() => {
  fake = installFakeRedis();
  client = createClient({ url: 'https://example.upstash.io', token: 't' });
  fake.store.set(`room:${CODE}`, JSON.stringify({
    code: CODE, status: 'active', createdBy: 'Owner', createdAt: now,
    participants: [
      { name: 'Owner', client: 'web', joinedAt: now },
      { name: 'Qwen', client: 'cc', joinedAt: now },
      { name: 'GPT', client: 'cc', joinedAt: now },
      { name: 'Pixel', client: 'cc', joinedAt: now },
    ],
  }));
});

async function board() {
  return (await getTaskBoard(client, CODE))!;
}

async function makeRejectedTask() {
  await createTask(client, CODE, {
    title: 'Draft the quote', owner: OWNER.name, ownerClient: 'cc',
    verifier: VERIFIER.name, verifierClient: 'cc', dod: 'Quote totals match', createdBy: 'Owner',
  });
  await claimTask(client, CODE, 'T-01', OWNER, now);
  await submitTask(client, CODE, 'T-01', OWNER, {
    fileListing: 'quote.csv', fileExcerpt: 'item,qty', checks: 'totals checked',
  }, now);
  await verifyTask(client, CODE, 'T-01', VERIFIER, 'rejected', 'Unit price is wrong', now);
}

describe('approval gate', () => {
  it('starts important work in pending_approval and refuses a claim until the boss approves', async () => {
    const created = await createTask(client, CODE, {
      title: 'Send the contract', owner: OWNER.name, ownerClient: 'cc',
      verifier: VERIFIER.name, verifierClient: 'cc', createdBy: 'Owner', requiresApproval: true,
    });
    expect(created.task).toMatchObject({
      state: 'pending_approval',
      approval: { required: true, status: 'pending', requestedBy: 'Owner' },
    });
    await expect(claimTask(client, CODE, 'T-01', OWNER, now)).rejects.toThrow(/approval/i);

    const approved = await decideTaskApproval(client, CODE, 'T-01', 'approved', BOSS, 'Go ahead', now + 1000);
    expect(approved.task.state).toBe('todo');
    expect(approved.task.approval).toMatchObject({ status: 'approved', decidedBy: 'Owner', note: 'Go ahead' });
    const claimed = await claimTask(client, CODE, 'T-01', OWNER, now + 2000);
    expect(claimed.task.state).toBe('in_progress');
  });

  it('rejects into the archive with the note, not into a verifier verdict', async () => {
    await createTask(client, CODE, {
      title: 'Send the contract', createdBy: 'Owner', requiresApproval: true, owner: OWNER.name, ownerClient: 'cc',
    });
    const rejected = await decideTaskApproval(client, CODE, 'T-01', 'rejected', BOSS, 'Wrong customer', now);
    expect(rejected.task.state).toBe('cancelled');
    expect(rejected.task.cancellation?.reason).toContain('Wrong customer');
    expect(rejected.task.verdict).toBeUndefined();
  });

  it('refuses a second ruling and a ruling on work that was never waiting', async () => {
    await createTask(client, CODE, { title: 'x', createdBy: 'Owner' });
    await expect(decideTaskApproval(client, CODE, 'T-01', 'approved', BOSS, undefined, now)).rejects.toThrow(/not waiting for approval/i);
    await createTask(client, CODE, { title: 'y', createdBy: 'Owner', requiresApproval: true });
    await decideTaskApproval(client, CODE, 'T-02', 'approved', BOSS, undefined, now);
    await expect(decideTaskApproval(client, CODE, 'T-02', 'rejected', BOSS, undefined, now)).rejects.toThrow(/not waiting/i);
  });

  it('can put an unstarted task behind the gate later, but not one already running', async () => {
    await createTask(client, CODE, { title: 'x', createdBy: 'Owner', owner: OWNER.name, ownerClient: 'cc' });
    const gated = await requireTaskApproval(client, CODE, 'T-01', OWNER, 'Needs sign-off', now);
    expect(gated.task).toMatchObject({ state: 'pending_approval', approval: { status: 'pending', note: 'Needs sign-off' } });
    await decideTaskApproval(client, CODE, 'T-01', 'approved', BOSS, undefined, now);
    await claimTask(client, CODE, 'T-01', OWNER, now);
    await expect(requireTaskApproval(client, CODE, 'T-01', OWNER, undefined, now)).rejects.toThrow(/unstarted/i);
  });
});

describe('pause and abort', () => {
  it('pauses an in-progress task without losing it, and resumes to where it was', async () => {
    await createTask(client, CODE, { title: 'x', createdBy: 'Owner', owner: OWNER.name, ownerClient: 'cc' });
    await claimTask(client, CODE, 'T-01', OWNER, now);
    const paused = await pauseTask(client, CODE, 'T-01', BOSS, 'Waiting for the client', now + 1000);
    expect(paused.task).toMatchObject({ state: 'paused', pause: { resumeState: 'in_progress', reason: 'Waiting for the client' } });
    await expect(claimTask(client, CODE, 'T-01', OWNER, now)).rejects.toThrow(/paused/i);
    const resumed = await unpauseTask(client, CODE, 'T-01', BOSS, now + 2000);
    expect(resumed.task.state).toBe('in_progress');
    expect(resumed.task.pause).toMatchObject({ resumedBy: 'Owner', resumedAt: now + 2000 });
  });

  it('refuses to pause a task in review and to resume one that is not paused', async () => {
    await createTask(client, CODE, { title: 'x', createdBy: 'Owner', owner: OWNER.name, ownerClient: 'cc', verifier: VERIFIER.name, verifierClient: 'cc' });
    await claimTask(client, CODE, 'T-01', OWNER, now);
    await submitTask(client, CODE, 'T-01', OWNER, { fileListing: 'a', fileExcerpt: 'b', checks: 'c' }, now);
    await expect(pauseTask(client, CODE, 'T-01', BOSS, undefined, now)).rejects.toThrow(/awaiting_review/);
    await expect(unpauseTask(client, CODE, 'T-01', BOSS, now)).rejects.toThrow(/not paused/i);
  });

  it('aborts for good and keeps the reason', async () => {
    await createTask(client, CODE, { title: 'x', createdBy: 'Owner', owner: OWNER.name, ownerClient: 'cc' });
    await claimTask(client, CODE, 'T-01', OWNER, now);
    const aborted = await abortTask(client, CODE, 'T-01', BOSS, 'Customer cancelled', now + 1000);
    expect(aborted.task).toMatchObject({ state: 'aborted', abort: { reason: 'Customer cancelled', by: 'Owner' } });
    await expect(claimTask(client, CODE, 'T-01', OWNER, now)).rejects.toThrow(/aborted/i);
    // Aborting twice is idempotent rather than an error: a boss pressing the
    // button twice should not see a failure.
    const again = await abortTask(client, CODE, 'T-01', BOSS, undefined, now + 2000);
    expect(again.task.state).toBe('aborted');
    expect((await board()).tasks[0]!.abort?.reason).toBe('Customer cancelled');
  });

  it('will not abort completed work', async () => {
    await createTask(client, CODE, { title: 'x', createdBy: 'Owner', owner: OWNER.name, ownerClient: 'cc', verifier: VERIFIER.name, verifierClient: 'cc' });
    await claimTask(client, CODE, 'T-01', OWNER, now);
    await submitTask(client, CODE, 'T-01', OWNER, { fileListing: 'a', fileExcerpt: 'b', checks: 'c' }, now);
    await verifyTask(client, CODE, 'T-01', VERIFIER, 'done', 'Looks right', now);
    await expect(abortTask(client, CODE, 'T-01', BOSS, undefined, now)).rejects.toThrow(/done/i);
  });
});

describe('peer QA', () => {
  it('records a QA pass by a non-owner on submitted work', async () => {
    await makeRejectedTask();
    await retryTask(client, CODE, 'T-01', OWNER, { reason: 'Fixed the unit price' }, now + 1000);
    await submitTask(client, CODE, 'T-01', OWNER, { fileListing: 'a', fileExcerpt: 'b', checks: 'c' }, now + 2000);
    const result = await recordTaskQa(client, CODE, 'T-01', QA, 'passed', 'Prices checked against the supplier sheet', now + 3000);
    expect(result.task.qa).toMatchObject({ reviewer: 'Pixel', reviewerClient: 'cc', status: 'passed' });
    expect(result.task.qa?.notes).toContain('supplier sheet');
  });

  it('refuses QA by the producer and on work that was never submitted', async () => {
    await makeRejectedTask();
    await expect(recordTaskQa(client, CODE, 'T-01', OWNER, 'passed', undefined, now)).rejects.toThrow(/cannot run QA/i);
    await createTask(client, CODE, { title: 'new', createdBy: 'Owner', owner: OWNER.name, ownerClient: 'cc' });
    await expect(recordTaskQa(client, CODE, 'T-02', QA, 'passed', undefined, now)).rejects.toThrow(/QA runs on submitted/i);
  });
});

describe('retry and hand-off', () => {
  it('returns a rejected task to in_progress and counts the attempt', async () => {
    await makeRejectedTask();
    const retried = await retryTask(client, CODE, 'T-01', OWNER, { reason: 'Fixed the unit price' }, now + 1000);
    expect(retried.task).toMatchObject({ state: 'in_progress', retryCount: 1, owner: 'Qwen' });
    expect(retried.task.retries?.[0]).toMatchObject({ reason: 'Fixed the unit price', attempt: 1 });
  });

  it('hands the work to another agent and records who it came from', async () => {
    await makeRejectedTask();
    const handed = await retryTask(client, CODE, 'T-01', OWNER, { reason: 'Needs a pricing specialist', to: 'Pixel' }, now + 1000);
    expect(handed.task).toMatchObject({ state: 'in_progress', owner: 'Pixel', retryCount: 1 });
    expect(handed.task.retries?.[0]).toMatchObject({ from: 'Qwen', to: 'Pixel' });
  });

  it('refuses a hand-off to the verifier, to a stranger, or past the ceiling', async () => {
    await makeRejectedTask();
    await expect(retryTask(client, CODE, 'T-01', OWNER, { to: 'GPT' }, now)).rejects.toThrow(/verifier/i);
    await expect(retryTask(client, CODE, 'T-01', OWNER, { to: 'Nobody' }, now)).rejects.toThrow(/not in this room/i);
    const once = await retryTask(client, CODE, 'T-01', OWNER, { reason: 'again' }, now, );
    expect(once.task.retryCount).toBe(1);
    await submitTask(client, CODE, 'T-01', OWNER, { fileListing: 'a', fileExcerpt: 'b', checks: 'c' }, now);
    await verifyTask(client, CODE, 'T-01', VERIFIER, 'rejected', 'Still wrong', now);
    await expect(retryTask(client, CODE, 'T-01', OWNER, { maxRetries: 1 }, now)).rejects.toThrow(/1 retries/i);
  });

  it('refuses to retry anything that is not rejected', async () => {
    await createTask(client, CODE, { title: 'x', createdBy: 'Owner' });
    await expect(retryTask(client, CODE, 'T-01', OWNER, {}, now)).rejects.toThrow(/only a rejected task/i);
  });
});

describe('state machine compatibility', () => {
  it('keeps the legacy path untouched for tasks without office controls', async () => {
    await createTask(client, CODE, { title: 'legacy', createdBy: 'Owner', owner: OWNER.name, ownerClient: 'cc', verifier: VERIFIER.name, verifierClient: 'cc' });
    expect((await board()).tasks[0]!.state).toBe('todo');
    await claimTask(client, CODE, 'T-01', OWNER, now);
    await submitTask(client, CODE, 'T-01', OWNER, { fileListing: 'a', fileExcerpt: 'b', checks: 'c' }, now);
    const done = await verifyTask(client, CODE, 'T-01', VERIFIER, 'done', 'ok', now);
    expect(done.task.state).toBe('done');
    expect(done.task.approval).toBeUndefined();
  });
});
