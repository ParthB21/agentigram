import { NotImplementedError } from '@clankergram/protocol';

export type BetaPosterior = { alpha: number; beta: number };
export type DuelOutcome = { winner: string; loser: string };
export type RouterCandidate = { model: string; posterior: BetaPosterior; cost: number };
export type ThompsonOptions = {
  /** Team-set cost sensitivity λ. */
  lambda: number;
  budget: number;
  /** Injected so the pick is reproducible in tests. */
  rng: () => number;
};

export function betaPosterior(
  _successes: number,
  _failures: number,
  _prior?: BetaPosterior,
): BetaPosterior {
  throw new NotImplementedError('stats.betaPosterior (Part 4)');
}

/** Bradley–Terry strengths per model from duel outcomes. */
export function bradleyTerry(_duels: DuelOutcome[]): Record<string, number> {
  throw new NotImplementedError('stats.bradleyTerry (Part 4)');
}

/** score(m) = p̃(m, c) − λ · cost(m, c) / budget, with p̃ sampled from the posterior. */
export function thompsonPick(_candidates: RouterCandidate[], _options: ThompsonOptions): string {
  throw new NotImplementedError('stats.thompsonPick (Part 4)');
}
