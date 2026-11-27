import { describe, expect, it } from 'vitest';
import {
  LINK_FRESH_MS,
  LINK_GRACE_MS,
  LINK_STALE_MS,
  backoffDelayMs,
  linkHoldsWork,
  linkRecoveryNote,
  linkRecoverySentence,
  linkStateFor,
  resumePlanFor,
} from './linkRecovery.js';

const NOW = 1_800_000_000_000;

describe('linkStateFor', () => {
  it('says nothing useful about a seat that never reported', () => {
    const link = linkStateFor({ now: NOW });
    expect(link.state).toBe('unknown');
    expect(link.lastHealthyAt).toBeUndefined();
    expect(linkHoldsWork(link)).toBe(false);
  });

  it('walks live → grace → recovering → offline as the silence grows', () => {
    const at = (age: number) => linkStateFor({ lastHealthyAt: NOW - age, now: NOW }).state;
    expect(at(0)).toBe('live');
    expect(at(LINK_FRESH_MS)).toBe('live');
    expect(at(LINK_FRESH_MS + 1)).toBe('grace');
    expect(at(LINK_GRACE_MS)).toBe('grace');
    expect(at(LINK_GRACE_MS + 1)).toBe('recovering');
    expect(at(LINK_STALE_MS)).toBe('recovering');
    expect(at(LINK_STALE_MS + 1)).toBe('offline');
  });

  it('keeps the last healthy time and how long it has been quiet', () => {
    const lastHealthyAt = NOW - 5 * 60_000;
    const link = linkStateFor({ lastHealthyAt, now: NOW, reconnects: 2, lastResumeAt: NOW - 60_000 });
    expect(link).toMatchObject({
      state: 'recovering',
      lastHealthyAt,
      downForMs: 5 * 60_000,
      graceEndsAt: lastHealthyAt + LINK_GRACE_MS,
      reconnects: 2,
      lastResumeAt: NOW - 60_000,
    });
    expect(linkHoldsWork(link)).toBe(true);
  });

  it('is live work-free: a connected seat holds nothing back', () => {
    expect(linkHoldsWork(linkStateFor({ lastHealthyAt: NOW - 1_000, now: NOW }))).toBe(false);
  });
});

describe('backoffDelayMs', () => {
  it('grows, stays under the ceiling, and never returns zero', () => {
    const delays = Array.from({ length: 12 }, (_, attempt) => backoffDelayMs(attempt, { baseMs: 400, maxMs: 5_000 }));
    expect(delays[0]).toBeGreaterThan(0);
    expect(Math.max(...delays)).toBeLessThanOrEqual(5_000);
    // Jitter is deliberately not monotonic (that would be a fixed schedule),
    // but it never inverts the trend: each delay stays within 80% of the one
    // before it while the exponent is still doubling.
    for (let index = 1; index < delays.length; index += 1) {
      expect(delays[index]!).toBeGreaterThanOrEqual(delays[index - 1]! * 0.8);
    }
    // The last few are pinned at the ceiling once doubling passes it.
    expect(delays.at(-1)).toBeGreaterThan(2_500);
  });

  it('is deterministic per attempt (two seats must not stampede in lockstep, tests must predict)', () => {
    expect(backoffDelayMs(3, { baseMs: 500 })).toBe(backoffDelayMs(3, { baseMs: 500 }));
    expect(backoffDelayMs(0, { jitter: 0 })).toBe(500);
    expect(backoffDelayMs(2, { jitter: 0 })).toBe(2_000);
    expect(backoffDelayMs(2, { jitter: 0, maxMs: 1_500 })).toBe(1_500);
  });
});

describe('resumePlanFor', () => {
  const tasks = [
    { id: 'T-01', title: 'Draft', state: 'in_progress' as const, owner: 'Qwen', verifier: 'Pixel' },
    { id: 'T-02', title: 'Review', state: 'awaiting_review' as const, owner: 'Qwen', verifier: 'Pixel' },
    { id: 'T-03', title: 'Queued', state: 'todo' as const, owner: 'Qwen' },
    { id: 'T-04', title: 'Done', state: 'done' as const, owner: 'Qwen' },
    { id: 'T-05', title: 'Leased', state: 'in_progress' as const, owner: 'Qwen' },
    { id: 'T-06', title: 'Someone else', state: 'in_progress' as const, owner: 'Pixel' },
  ];
  const lease = { status: 'active' as const, holderName: 'Pixel', expiresAt: NOW + 60_000 };

  it('names owned work to resume and verifier work to rule on', () => {
    const plan = resumePlanFor([...tasks], 'Qwen', NOW);
    expect(plan.execute.map(task => task.id)).toEqual(['T-01', 'T-05']);
    expect(plan.queued.map(task => task.id)).toEqual(['T-03']);
    expect(plan.verify.map(task => task.id)).toEqual([]);
    expect(plan.hint).toContain('T-01');
    expect(plan.hint).toContain('were being executed');

    const verifier = resumePlanFor([...tasks], 'Pixel', NOW);
    // Pixel owns T-06 and owes a verdict on T-02; the verdict comes first.
    expect(verifier.verify.map(task => task.id)).toEqual(['T-02']);
    expect(verifier.execute.map(task => task.id)).toEqual(['T-06']);
    expect(verifier.hint.indexOf('T-02')).toBeLessThan(verifier.hint.indexOf('T-06'));
  });

  it('does not start work another live member is holding', () => {
    const withLease = tasks.map(task => (task.id === 'T-05' ? { ...task, lease } : task));
    const plan = resumePlanFor(withLease, 'Qwen', NOW);
    expect(plan.heldByOthers.map(task => task.id)).toEqual(['T-05']);
    expect(plan.execute.map(task => task.id)).toEqual(['T-01']);
    expect(plan.hint).toContain('do not start them twice');
  });

  it('returns nothing for a nameless seat', () => {
    expect(resumePlanFor([...tasks], '  ', NOW).hint).toBe('');
  });
});

describe('linkRecoveryNote', () => {
  it('describes a recovery in seconds and retries', () => {
    const note = linkRecoveryNote(6_400, 3);
    expect(note).toEqual({ state: 'recovered', downMs: 6_400, retries: 3 });
    const sentence = linkRecoverySentence(note);
    expect(sentence).toContain('6s');
    expect(sentence).toContain('3 retries');
    expect(sentence).toContain('nothing was lost');
  });

  it('uses the singular for one retry', () => {
    expect(linkRecoverySentence(linkRecoveryNote(1_000, 1))).toContain('1 retry');
  });
});
