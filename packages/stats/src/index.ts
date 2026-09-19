import type { Event } from '@agentigram/protocol';

const DEFAULT_PRIOR = { alpha: 1, beta: 1 };
const DEFAULT_ITERATIONS = 4_000;
const MIN_WINNER_SAMPLES = 5;
const WINNER_PROBABILITY = 0.9;

export type BetaPosterior = { alpha: number; beta: number };
export type PosteriorSummary = { median: number; lower: number; upper: number; sampleSize: number };
export type DuelOutcome = { winner: string; loser: string };
export type RouterCandidate = {
  model: string;
  posterior: BetaPosterior;
  cost: number;
  sampleSize?: number;
};
export type ThompsonOptions = {
  lambda: number;
  budget: number;
  rng: () => number;
};
export type RouterRecommendation = { model: string; score: number; reason: string };
export type TaskCategory =
  | 'FEATURE'
  | 'BUG_FIX'
  | 'REFACTOR'
  | 'TESTING'
  | 'FRONTEND'
  | 'BACKEND'
  | 'DATABASE'
  | 'SECURITY'
  | 'DOCUMENTATION'
  | 'DEVOPS';
export type TaskOutcome = {
  sessionId: string;
  model?: string;
  task?: string;
  category: TaskCategory;
  difficulty: 'LOW' | 'MEDIUM' | 'HIGH';
  verifiedSuccess: boolean;
  firstPassCi: boolean | null;
  humanInterventions: number;
  rework: number;
  collisionsIntroduced: number;
  collisionsResolved: number;
  durationMs?: number;
  leaseBlockedMs: number;
  inputTokens?: number;
  outputTokens?: number;
  costUsd?: number;
};

export class StatisticsError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'StatisticsError';
  }
}

export function betaPosterior(
  successes: number,
  failures: number,
  prior: BetaPosterior = DEFAULT_PRIOR,
): BetaPosterior {
  if (![successes, failures, prior.alpha, prior.beta].every(Number.isFinite)) {
    throw new StatisticsError('Posterior inputs must be finite');
  }
  if (successes < 0 || failures < 0 || prior.alpha <= 0 || prior.beta <= 0) {
    throw new StatisticsError('Counts must be non-negative and prior parameters must be positive');
  }
  return { alpha: prior.alpha + successes, beta: prior.beta + failures };
}

export function pooledPrior(groups: Array<{ successes: number; failures: number }>): BetaPosterior {
  const completed = groups.filter((group) => group.successes + group.failures > 0);
  if (completed.length === 0) return DEFAULT_PRIOR;
  const rates = completed.map((group) => group.successes / (group.successes + group.failures));
  const mean = rates.reduce((sum, value) => sum + value, 0) / rates.length;
  const variance =
    rates.reduce((sum, value) => sum + (value - mean) ** 2, 0) / Math.max(1, rates.length - 1);
  const concentration = variance > 0 ? Math.max(2, (mean * (1 - mean)) / variance - 1) : 8;
  return {
    alpha: Math.max(0.5, mean * concentration),
    beta: Math.max(0.5, (1 - mean) * concentration),
  };
}

export function posteriorSummary(
  posterior: BetaPosterior,
  sampleSize: number,
  rng: () => number,
  iterations = DEFAULT_ITERATIONS,
): PosteriorSummary {
  const samples = Array.from({ length: iterations }, () => sampleBeta(posterior, rng)).sort(
    (a, b) => a - b,
  );
  return {
    median: quantile(samples, 0.5),
    lower: quantile(samples, 0.1),
    upper: quantile(samples, 0.9),
    sampleSize,
  };
}

export function bootstrapMedian(
  values: number[],
  rng: () => number,
  iterations = 2_000,
): { median: number; lower: number; upper: number; sampleSize: number } {
  if (values.length === 0 || values.some((value) => !Number.isFinite(value))) {
    throw new StatisticsError('Bootstrap requires at least one finite value');
  }
  const estimates = Array.from({ length: iterations }, () => {
    const sample = Array.from({ length: values.length }, () => {
      const index = Math.min(values.length - 1, Math.floor(unit(rng) * values.length));
      return valueAt(values, index);
    });
    return median(sample);
  }).sort((a, b) => a - b);
  return {
    median: median(values),
    lower: quantile(estimates, 0.1),
    upper: quantile(estimates, 0.9),
    sampleSize: values.length,
  };
}

export function probabilityGreater(
  left: BetaPosterior,
  right: BetaPosterior,
  rng: () => number,
  iterations = DEFAULT_ITERATIONS,
): number {
  let wins = 0;
  for (let index = 0; index < iterations; index += 1) {
    if (sampleBeta(left, rng) > sampleBeta(right, rng)) wins += 1;
  }
  return wins / iterations;
}

export function declareWinner(
  left: RouterCandidate,
  right: RouterCandidate,
  rng: () => number,
): string | undefined {
  if ((left.sampleSize ?? 0) < MIN_WINNER_SAMPLES || (right.sampleSize ?? 0) < MIN_WINNER_SAMPLES) {
    return undefined;
  }
  const probability = probabilityGreater(left.posterior, right.posterior, rng);
  if (probability >= WINNER_PROBABILITY) return left.model;
  if (probability <= 1 - WINNER_PROBABILITY) return right.model;
  return undefined;
}

export function bradleyTerry(duels: DuelOutcome[]): Record<string, number> {
  const models = [...new Set(duels.flatMap((duel) => [duel.winner, duel.loser]))].sort();
  if (models.length === 0) return {};
  let strengths = Object.fromEntries(models.map((model) => [model, 1]));
  const games = new Map<string, number>();
  const wins = Object.fromEntries(models.map((model) => [model, 0.5]));
  for (const duel of duels) {
    wins[duel.winner] = (wins[duel.winner] ?? 0.5) + 1;
    const pair = [duel.winner, duel.loser].sort().join('\0');
    games.set(pair, (games.get(pair) ?? 0) + 1);
  }
  for (let iteration = 0; iteration < 200; iteration += 1) {
    const next: Record<string, number> = {};
    for (const model of models) {
      let denominator = 0.5;
      for (const opponent of models) {
        if (opponent === model) continue;
        const count = games.get([model, opponent].sort().join('\0')) ?? 0;
        denominator += count / ((strengths[model] ?? 1) + (strengths[opponent] ?? 1));
      }
      next[model] = (wins[model] ?? 0.5) / denominator;
    }
    const geometricMean = Math.exp(
      Object.values(next).reduce((sum, value) => sum + Math.log(value), 0) / models.length,
    );
    strengths = Object.fromEntries(
      models.map((model) => [model, (next[model] ?? 1) / geometricMean]),
    );
  }
  return strengths;
}

export function thompsonRecommendation(
  candidates: RouterCandidate[],
  options: ThompsonOptions,
): RouterRecommendation {
  if (candidates.length === 0 || !(options.budget > 0)) {
    throw new StatisticsError('Routing requires candidates and a positive budget');
  }
  const scored = candidates.map((candidate) => ({
    ...candidate,
    sampled: sampleBeta(candidate.posterior, options.rng),
  }));
  const winner = scored.reduce((best, candidate) => {
    const score = candidate.sampled - (options.lambda * candidate.cost) / options.budget;
    const bestScore = best.sampled - (options.lambda * best.cost) / options.budget;
    return score > bestScore ? candidate : best;
  });
  const score = winner.sampled - (options.lambda * winner.cost) / options.budget;
  const expected = winner.posterior.alpha / (winner.posterior.alpha + winner.posterior.beta);
  return {
    model: winner.model,
    score,
    reason: `${winner.sampleSize ?? 0} tasks, ${Math.round(expected * 100)}% posterior success, ${winner.cost.toFixed(2)} estimated cost`,
  };
}

export function thompsonPick(candidates: RouterCandidate[], options: ThompsonOptions): string {
  return thompsonRecommendation(candidates, options).model;
}

/** Derive auditable model outcomes from the authoritative event log only. */
export function deriveTaskOutcomes(events: Event[]): TaskOutcome[] {
  const ordered = [...events].sort((a, b) => a.seq - b.seq);
  const sessions = new Map<
    string,
    TaskOutcome & { startedAt?: number; blockedAt?: number; firstCiSeen: boolean }
  >();
  const get = (sessionId: string) => {
    let value = sessions.get(sessionId);
    if (!value) {
      value = {
        sessionId,
        category: 'FEATURE',
        difficulty: 'MEDIUM',
        verifiedSuccess: false,
        firstPassCi: null,
        humanInterventions: 0,
        rework: 0,
        collisionsIntroduced: 0,
        collisionsResolved: 0,
        leaseBlockedMs: 0,
        firstCiSeen: false,
      };
      sessions.set(sessionId, value);
    }
    return value;
  };
  for (const event of ordered) {
    const actorSession = event.actor.sessionId;
    const at = Date.parse(event.ts);
    if (event.payload.type === 'SESSION_STARTED') {
      const outcome = get(event.payload.sessionId);
      outcome.model = event.payload.model;
      outcome.task = event.payload.task;
      outcome.category = categorizeTask(event.payload.task ?? '');
      outcome.difficulty = difficultyFor(event.payload.task ?? '');
      if (Number.isFinite(at)) outcome.startedAt = at;
    } else if (event.payload.type === 'CI_RESULT' && event.payload.sessionId) {
      const outcome = get(event.payload.sessionId);
      if (!outcome.firstCiSeen) {
        outcome.firstPassCi = event.payload.status === 'pass';
        outcome.firstCiSeen = true;
      } else if (event.payload.status === 'fail') outcome.rework += 1;
    } else if (event.payload.type === 'RUN_VERIFIED') {
      const outcome = get(event.payload.sessionId);
      outcome.verifiedSuccess = true;
      if (event.payload.durationMs !== undefined)
        outcome.durationMs = Math.max(0, event.payload.durationMs - outcome.leaseBlockedMs);
      else if (outcome.startedAt !== undefined && Number.isFinite(at))
        outcome.durationMs = Math.max(0, at - outcome.startedAt - outcome.leaseBlockedMs);
    } else if (event.payload.type === 'COLLISION') {
      get(event.payload.writerSession).collisionsIntroduced += 1;
    } else if (event.payload.type === 'CONTRACT_RESULT' && event.payload.status === 'pass') {
      if (actorSession) get(actorSession).collisionsResolved += 1;
    } else if (event.payload.type === 'LEASE_DENIED' && actorSession && Number.isFinite(at)) {
      get(actorSession).blockedAt ??= at;
    } else if (
      (event.payload.type === 'LEASE_GRANTED' || event.payload.type === 'LEASE_RELEASED') &&
      actorSession
    ) {
      const outcome = get(actorSession);
      if (outcome.blockedAt !== undefined && Number.isFinite(at)) {
        outcome.leaseBlockedMs += Math.max(0, at - outcome.blockedAt);
        outcome.blockedAt = undefined;
      }
    } else if (event.payload.type === 'USAGE' && actorSession) {
      const outcome = get(actorSession);
      outcome.inputTokens = (outcome.inputTokens ?? 0) + (event.payload.inputTokens ?? 0);
      outcome.outputTokens = (outcome.outputTokens ?? 0) + (event.payload.outputTokens ?? 0);
      outcome.costUsd = (outcome.costUsd ?? 0) + (event.payload.costUsd ?? 0);
    }
    if (event.actor.kind === 'human' && actorSession) get(actorSession).humanInterventions += 1;
  }
  return [...sessions.values()]
    .map(
      ({ startedAt: _startedAt, blockedAt: _blockedAt, firstCiSeen: _firstCiSeen, ...outcome }) =>
        outcome,
    )
    .sort((a, b) => a.sessionId.localeCompare(b.sessionId));
}

export function categorizeTask(text: string): TaskCategory {
  const value = text.toLowerCase();
  if (/security|auth|permission|vulnerab/.test(value)) return 'SECURITY';
  if (/test|coverage|spec\b/.test(value)) return 'TESTING';
  if (/ui|frontend|css|react|component/.test(value)) return 'FRONTEND';
  if (/database|schema|sql|migration/.test(value)) return 'DATABASE';
  if (/deploy|ci|pipeline|docker|infra/.test(value)) return 'DEVOPS';
  if (/doc|readme/.test(value)) return 'DOCUMENTATION';
  if (/bug|fix|repair|regression/.test(value)) return 'BUG_FIX';
  if (/refactor|cleanup|rename/.test(value)) return 'REFACTOR';
  if (/api|backend|server|service/.test(value)) return 'BACKEND';
  return 'FEATURE';
}

export function difficultyFor(text: string): 'LOW' | 'MEDIUM' | 'HIGH' {
  const words = text.trim().split(/\s+/).filter(Boolean).length;
  if (/architecture|migration|distributed|security|rewrite/i.test(text) || words > 24)
    return 'HIGH';
  if (words <= 5) return 'LOW';
  return 'MEDIUM';
}

export function seededRandom(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state * 1_664_525 + 1_013_904_223) >>> 0;
    return state / 4_294_967_296;
  };
}

function sampleBeta(posterior: BetaPosterior, rng: () => number): number {
  const left = sampleGamma(posterior.alpha, rng);
  const right = sampleGamma(posterior.beta, rng);
  return left / (left + right);
}

function sampleGamma(shape: number, rng: () => number): number {
  if (shape < 1) {
    return sampleGamma(shape + 1, rng) * unit(rng) ** (1 / shape);
  }
  const d = shape - 1 / 3;
  const c = 1 / Math.sqrt(9 * d);
  while (true) {
    const normal = Math.sqrt(-2 * Math.log(unit(rng))) * Math.cos(2 * Math.PI * unit(rng));
    const factor = 1 + c * normal;
    if (factor <= 0) continue;
    const cube = factor ** 3;
    const draw = unit(rng);
    if (draw < 1 - 0.0331 * normal ** 4) return d * cube;
    if (Math.log(draw) < 0.5 * normal ** 2 + d * (1 - cube + Math.log(cube))) return d * cube;
  }
}

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? (valueAt(sorted, middle - 1) + valueAt(sorted, middle)) / 2
    : valueAt(sorted, middle);
}

function quantile(sorted: number[], probability: number): number {
  const index = (sorted.length - 1) * probability;
  const lower = Math.floor(index);
  const fraction = index - lower;
  const lowerValue = valueAt(sorted, lower);
  const upperValue = valueAt(sorted, Math.min(lower + 1, sorted.length - 1));
  return lowerValue + (upperValue - lowerValue) * fraction;
}

function unit(rng: () => number): number {
  return Math.min(1 - Number.EPSILON, Math.max(Number.EPSILON, rng()));
}

function valueAt(values: number[], index: number): number {
  const value = values[index];
  if (value === undefined) throw new StatisticsError('Statistic index is out of bounds');
  return value;
}
