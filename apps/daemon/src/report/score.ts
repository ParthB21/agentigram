import {
  type BetaPosterior,
  betaPosterior,
  bradleyTerry,
  declareWinner,
  pooledPrior,
  posteriorSummary,
  probabilityGreater,
  seededRandom,
  type TaskCategory,
} from '@agentigram/stats';
import type {
  AgentSummary,
  CategoryScore,
  ConflictRecord,
  HeadToHead,
  ModelScore,
  PosteriorCell,
} from './types.js';

/** Fixed seeds: the same log must always produce the same numbers, or the score can be gamed by re-rolling. */
const SEED = 20_260_920;

type Counts = { successes: number; failures: number };

const counts = (agents: AgentSummary[]): Counts => ({
  successes: agents.filter((a) => a.outcome === 'pass').length,
  failures: agents.filter((a) => a.outcome === 'fail').length,
});

const sum = (agents: AgentSummary[], pick: (a: AgentSummary) => number): number =>
  agents.reduce((total, agent) => total + pick(agent), 0);

const median = (values: number[]): number | null => {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  const lo = sorted[mid - 1] ?? 0;
  const hi = sorted[mid] ?? 0;
  return sorted.length % 2 === 0 ? (lo + hi) / 2 : hi;
};

function cell(posterior: BetaPosterior, n: number): PosteriorCell {
  const { median: m, lower, upper } = posteriorSummary(posterior, n, seededRandom(SEED));
  return { median: m, lower, upper };
}

/**
 * A model's posterior in one category, partially pooled: the prior is fitted to
 * that model's own record across categories, so two debugging tasks borrow
 * strength from its overall record (spec: Statistics).
 */
function posteriorFor(
  modelAgents: AgentSummary[],
  category?: TaskCategory,
): { posterior: BetaPosterior; n: number } | null {
  const perCategory = new Map<TaskCategory, AgentSummary[]>();
  for (const agent of modelAgents) {
    perCategory.set(agent.category, [...(perCategory.get(agent.category) ?? []), agent]);
  }
  const scope = category ? (perCategory.get(category) ?? []) : modelAgents;
  const { successes, failures } = counts(scope);
  if (successes + failures === 0) return null;
  const prior = pooledPrior([...perCategory.values()].map(counts));
  return { posterior: betaPosterior(successes, failures, prior), n: successes + failures };
}

function categoryScores(modelAgents: AgentSummary[]): CategoryScore[] {
  const categories = [...new Set(modelAgents.map((a) => a.category))].sort();
  return categories.map((category) => {
    const scope = modelAgents.filter((a) => a.category === category);
    const { successes, failures } = counts(scope);
    const posterior = posteriorFor(modelAgents, category);
    return {
      category,
      sessions: scope.length,
      scored: successes + failures,
      passes: successes,
      fails: failures,
      unverified: scope.length - successes - failures,
      successRate: posterior ? cell(posterior.posterior, posterior.n) : null,
      medianDurationMs: median(
        scope
          .filter((a) => a.outcome === 'pass' && a.activeMs !== undefined)
          .map((a) => a.activeMs ?? 0),
      ),
    };
  });
}

export function scoreModels(agents: AgentSummary[], conflicts: ConflictRecord[]): ModelScore[] {
  const modelOf = new Map(agents.map((a) => [a.sessionId, a.model]));
  const models = [...new Set(agents.map((a) => a.model))].sort();
  return models.map((model) => {
    const own = agents.filter((a) => a.model === model);
    const { successes, failures } = counts(own);
    const caused = conflicts.filter((c) => modelOf.get(c.writer) === model);
    const posterior = posteriorFor(own);
    return {
      model,
      sessions: own.length,
      scored: successes + failures,
      passes: successes,
      fails: failures,
      unverified: own.length - successes - failures,
      successRate: posterior ? cell(posterior.posterior, posterior.n) : null,
      conflictsCaused: caused.length,
      conflictsAffected: conflicts.filter((c) =>
        c.affected.some((session) => modelOf.get(session) === model),
      ).length,
      conflictsVerified: caused.filter((c) => c.resolution === 'verified').length,
      conflictsEscalated: caused.filter((c) => c.resolution === 'escalated').length,
      leaseDenials: sum(own, (a) => a.leaseDenials),
      leaseBlockedMs: sum(own, (a) => a.leaseBlockedMs),
      proposals: sum(own, (a) => a.proposals),
      accepts: sum(own, (a) => a.accepts),
      escalations: sum(own, (a) => a.escalations),
      contractPass: sum(own, (a) => a.contracts.pass),
      contractFail: sum(own, (a) => a.contracts.fail),
      filesWritten: sum(own, (a) => a.filesWritten.length),
      inputTokens: sum(own, (a) => a.inputTokens),
      outputTokens: sum(own, (a) => a.outputTokens),
      costUsd: sum(own, (a) => a.costUsd),
      byCategory: categoryScores(own),
    };
  });
}

/** Every model pair, overall and per category, with a winner only where the spec's evidence bar is met. */
export function headToHead(agents: AgentSummary[]): HeadToHead[] {
  const models = [...new Set(agents.map((a) => a.model))].sort();
  const categories = [...new Set(agents.map((a) => a.category))].sort();
  const rows: HeadToHead[] = [];
  for (let i = 0; i < models.length; i += 1) {
    for (let j = i + 1; j < models.length; j += 1) {
      const a = models[i] as string;
      const b = models[j] as string;
      const left = agents.filter((x) => x.model === a);
      const right = agents.filter((x) => x.model === b);
      for (const category of ['ALL', ...categories] as const) {
        const scope = category === 'ALL' ? undefined : category;
        const pa = posteriorFor(left, scope);
        const pb = posteriorFor(right, scope);
        const row: HeadToHead = {
          category,
          a,
          b,
          nA: pa?.n ?? 0,
          nB: pb?.n ?? 0,
          probabilityAOverB: null,
          winner: null,
        };
        if (pa && pb) {
          row.probabilityAOverB = probabilityGreater(
            pa.posterior,
            pb.posterior,
            seededRandom(SEED),
          );
          row.winner =
            declareWinner(
              { model: a, posterior: pa.posterior, cost: 0, sampleSize: pa.n },
              { model: b, posterior: pb.posterior, cost: 0, sampleSize: pb.n },
              seededRandom(SEED),
            ) ?? null;
        }
        if (row.nA > 0 || row.nB > 0) rows.push(row);
      }
    }
  }
  return rows;
}

/** Ratings from paired duels only: both models faced the same task, so difficulty cancels out. */
export function duelRatings(
  agents: AgentSummary[],
  duels: { winner: string; loser: string }[],
): Record<string, number> {
  const modelOf = new Map(agents.map((a) => [a.sessionId, a.model]));
  const outcomes = duels.flatMap(({ winner, loser }) => {
    const w = modelOf.get(winner);
    const l = modelOf.get(loser);
    return w && l && w !== l ? [{ winner: w, loser: l }] : [];
  });
  return bradleyTerry(outcomes);
}
