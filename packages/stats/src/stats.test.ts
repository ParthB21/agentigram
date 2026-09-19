import { describe, expect, it } from 'vitest';
import {
  betaPosterior,
  bootstrapMedian,
  bradleyTerry,
  declareWinner,
  deriveTaskOutcomes,
  posteriorSummary,
  seededRandom,
  thompsonRecommendation,
} from './index.js';

describe('@clankergram/stats', () => {
  it('updates beta-binomial evidence', () => {
    expect(betaPosterior(8, 2)).toEqual({ alpha: 9, beta: 3 });
  });

  it('reports posterior and bootstrap 80% intervals', () => {
    const posterior = posteriorSummary(betaPosterior(8, 2), 10, seededRandom(1));
    expect(posterior.lower).toBeLessThan(posterior.median);
    expect(posterior.upper).toBeGreaterThan(posterior.median);
    expect(bootstrapMedian([5, 6, 7, 8, 30], seededRandom(2)).median).toBe(7);
  });

  it('ranks the repeated duel winner higher', () => {
    const ratings = bradleyTerry([
      { winner: 'A', loser: 'B' },
      { winner: 'A', loser: 'B' },
      { winner: 'A', loser: 'C' },
      { winner: 'B', loser: 'C' },
    ]);
    expect(ratings.A ?? 0).toBeGreaterThan(ratings.B ?? 0);
    expect(ratings.B ?? 0).toBeGreaterThan(ratings.C ?? 0);
  });

  it('only declares a winner with enough evidence', () => {
    const strong = { model: 'A', posterior: betaPosterior(20, 1), cost: 1, sampleSize: 21 };
    const weak = { model: 'B', posterior: betaPosterior(1, 20), cost: 1, sampleSize: 21 };
    expect(declareWinner(strong, weak, seededRandom(3))).toBe('A');
    expect(declareWinner({ ...strong, sampleSize: 2 }, weak, seededRandom(3))).toBeUndefined();
  });

  it('routes with sampled quality and a cost penalty', () => {
    const result = thompsonRecommendation(
      [
        { model: 'A', posterior: { alpha: 80, beta: 20 }, cost: 10, sampleSize: 100 },
        { model: 'B', posterior: { alpha: 20, beta: 80 }, cost: 1, sampleSize: 100 },
      ],
      { lambda: 0.1, budget: 100, rng: seededRandom(4) },
    );
    expect(result.model).toBe('A');
    expect(result.reason).toContain('100 tasks');
  });

  it('derives verified outcomes and excludes lease-blocked time', () => {
    const base = {
      id: 'e',
      roomId: 'r',
      actor: { engineerId: 'sam', sessionId: 'payments', kind: 'agent' as const },
      source: 'system' as const,
    };
    const outcomes = deriveTaskOutcomes([
      {
        ...base,
        id: '1',
        seq: 1,
        ts: '2026-01-01T00:00:00Z',
        payload: {
          type: 'SESSION_STARTED',
          sessionId: 'payments',
          host: 'codex',
          model: 'gpt',
          branch: 'b',
          task: 'Fix checkout bug',
        },
      },
      {
        ...base,
        id: '2',
        seq: 2,
        ts: '2026-01-01T00:01:00Z',
        payload: { type: 'LEASE_DENIED', symbols: [], heldBy: 'backend', reason: 'busy' },
      },
      {
        ...base,
        id: '3',
        seq: 3,
        ts: '2026-01-01T00:03:00Z',
        payload: {
          type: 'LEASE_GRANTED',
          leaseId: 'l',
          symbols: [],
          fencingToken: 3,
          expiresAt: 'x',
        },
      },
      {
        ...base,
        id: '4',
        seq: 4,
        ts: '2026-01-01T00:05:00Z',
        payload: { type: 'CI_RESULT', commit: 'c', status: 'pass', sessionId: 'payments' },
      },
      {
        ...base,
        id: '5',
        seq: 5,
        ts: '2026-01-01T00:10:00Z',
        payload: { type: 'RUN_VERIFIED', runId: 'run', sessionId: 'payments' },
      },
    ]);
    expect(outcomes[0]).toMatchObject({
      verifiedSuccess: true,
      firstPassCi: true,
      category: 'BUG_FIX',
      leaseBlockedMs: 120_000,
      durationMs: 480_000,
    });
  });
});
