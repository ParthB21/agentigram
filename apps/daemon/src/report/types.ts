import type { CollisionTier } from '@agentigram/protocol';
import type { TaskCategory } from '@agentigram/stats';

/** Bump when the meaning of any scored field changes, so old reports are never compared to new ones blindly. */
export const REPORT_METHOD_VERSION = 1;

/**
 * What the room actually observed about a session's work. `unverified` is not a
 * failure: nothing ran that could have passed or failed, so it is excluded from
 * success rates rather than counted against the model.
 */
export type Outcome = 'pass' | 'fail' | 'unverified';

export type AgentSummary = {
  sessionId: string;
  engineerId: string;
  host: string;
  model: string;
  task?: string;
  category: TaskCategory;
  difficulty: 'LOW' | 'MEDIUM' | 'HIGH';
  startedAt?: string;
  endedAt?: string;
  endReason?: string;
  activeMs?: number;
  filesRead: number;
  filesWritten: string[];
  toolCalls: number;
  intents: number;
  collisionsCaused: number;
  collisionsAffected: number;
  leaseDenials: number;
  leaseBlockedMs: number;
  proposals: number;
  counters: number;
  accepts: number;
  escalations: number;
  ci: { pass: number; fail: number };
  contracts: { pass: number; fail: number };
  runVerified: boolean;
  humanInterventions: number;
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
  outcome: Outcome;
};

export type ConflictAction = {
  seq: number;
  at: string;
  by?: string;
  kind: 'PROPOSAL' | 'COUNTER' | 'ACCEPT' | 'ESCALATE' | 'MESSAGE';
  note?: string;
};

export type ConflictResolution = 'verified' | 'accepted' | 'failed' | 'escalated' | 'open';

export type ConflictRecord = {
  collisionId: string;
  tier: CollisionTier;
  symbols: string[];
  writer: string;
  affected: string[];
  openedSeq: number;
  openedAt: string;
  detail: string;
  actions: ConflictAction[];
  contractId?: string;
  contractResult?: 'pass' | 'fail';
  resolution: ConflictResolution;
  resolvedAt?: string;
  timeToResolutionMs?: number;
};

export type TimelineEntry = {
  seq: number;
  ts: string;
  session?: string;
  kind: string;
  text: string;
};

export type PosteriorCell = { median: number; lower: number; upper: number };

export type CategoryScore = {
  category: TaskCategory;
  sessions: number;
  /** Sessions with a pass or fail outcome; the only ones that count towards a rate. */
  scored: number;
  passes: number;
  fails: number;
  unverified: number;
  successRate: PosteriorCell | null;
  medianDurationMs: number | null;
};

export type ModelScore = {
  model: string;
  sessions: number;
  scored: number;
  passes: number;
  fails: number;
  unverified: number;
  successRate: PosteriorCell | null;
  conflictsCaused: number;
  conflictsAffected: number;
  conflictsVerified: number;
  conflictsEscalated: number;
  leaseDenials: number;
  leaseBlockedMs: number;
  proposals: number;
  accepts: number;
  escalations: number;
  contractPass: number;
  contractFail: number;
  filesWritten: number;
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
  byCategory: CategoryScore[];
};

export type HeadToHead = {
  category: TaskCategory | 'ALL';
  a: string;
  b: string;
  nA: number;
  nB: number;
  /** P(a's true success rate > b's), from the two posteriors. */
  probabilityAOverB: number | null;
  /** Set only when both have n >= 5 and the probability clears 0.9, per spec. */
  winner: string | null;
};

export type SessionReport = {
  methodVersion: number;
  roomId: string;
  generatedAt: string;
  window: {
    firstSeq: number;
    lastSeq: number;
    firstTs?: string;
    lastTs?: string;
    durationMs?: number;
  };
  /** SHA-256 over the canonical event lines, so a score can be re-derived and audited from the log. */
  eventsSha256: string;
  eventCount: number;
  agents: AgentSummary[];
  conflicts: ConflictRecord[];
  models: ModelScore[];
  headToHead: HeadToHead[];
  /** Bradley–Terry strengths from DUEL_RESULT events; empty when no paired duels ran. */
  duelRatings: Record<string, number>;
  duels: number;
  timeline: TimelineEntry[];
  caveats: string[];
};
