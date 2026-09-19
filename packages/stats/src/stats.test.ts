import { describe, expect, it } from 'vitest';
import {
  betaPosterior,
  bootstrapMedian,
  bradleyTerry,
  declareWinner,
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
});
