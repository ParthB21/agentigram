import { z } from 'zod';
import { payload } from './payloads-observed.js';

// Verification
export const SpecMergeResult = payload('SPEC_MERGE_RESULT', {
  baseCommit: z.string(),
  sessions: z.array(z.string()),
  typeErrors: z.array(
    z.object({
      file: z.string(),
      line: z.number().int().positive().optional(),
      code: z.string().optional(),
      message: z.string(),
    }),
  ),
  failingTests: z.array(z.string()),
  /** Tests skipped because the run hit its wall-time cap. Reported honestly, never hidden. */
  notRun: z.array(z.string()),
});
export const CiResult = payload('CI_RESULT', {
  commit: z.string(),
  status: z.enum(['pass', 'fail']),
  runId: z.string().optional(),
  sessionId: z.string().optional(),
});
export const ReviewResult = payload('REVIEW_RESULT', {
  pr: z.number().int().positive(),
  state: z.enum(['approved', 'changes_requested', 'commented']),
  commit: z.string().optional(),
});
export const ContractResult = payload('CONTRACT_RESULT', {
  contractId: z.string(),
  status: z.enum(['pass', 'fail']),
  detail: z.string().optional(),
});
export const RunVerified = payload('RUN_VERIFIED', {
  runId: z.string(),
  sessionId: z.string(),
  durationMs: z.number().nonnegative().optional(),
});

// Session
export const SessionStarted = payload('SESSION_STARTED', {
  sessionId: z.string(),
  host: z.string(),
  model: z.string(),
  provider: z.string().optional(),
  branch: z.string(),
  role: z.string().optional(),
  task: z.string().optional(),
});
export const SessionEnded = payload('SESSION_ENDED', {
  sessionId: z.string(),
  reason: z.string().optional(),
});
export const Heartbeat = payload('HEARTBEAT', { sessionId: z.string() });
export const TaskCreated = payload('TASK_CREATED', {
  taskId: z.string(),
  title: z.string(),
  category: z.string().optional(),
  difficulty: z.enum(['LOW', 'MEDIUM', 'HIGH']).optional(),
});
export const DuelStarted = payload('DUEL_STARTED', {
  duelId: z.string(),
  taskId: z.string(),
  sessions: z.tuple([z.string(), z.string()]),
});
export const DuelResult = payload('DUEL_RESULT', {
  duelId: z.string(),
  winnerSession: z.string().nullable(),
  reason: z.string(),
});

// Dashboard-only
export const MARKET_KINDS = ['binary', 'categorical', 'range'] as const;
export const MarketKindSchema = z.enum(MARKET_KINDS);
export const MarketOpened = payload('MARKET_OPENED', {
  marketId: z.string(),
  kind: MarketKindSchema,
  question: z.string(),
  outcomes: z.array(z.string()).min(2),
  b: z.number().positive(),
  closesAt: z.string(),
  subjectSession: z.string().optional(),
});
export const Trade = payload('TRADE', {
  marketId: z.string(),
  memberId: z.string(),
  outcome: z.string(),
  shares: z.number(),
});
export const MarketClosed = payload('MARKET_CLOSED', { marketId: z.string() });
export const MarketResolved = payload('MARKET_RESOLVED', {
  marketId: z.string(),
  outcome: z.string(),
  resolutionSeq: z.number().int().nonnegative(),
});
export const MarketVoided = payload('MARKET_VOIDED', { marketId: z.string(), reason: z.string() });
export const PersonaLines = payload('PERSONA_LINES', {
  lines: z.array(
    z.object({ speaker: z.string(), text: z.string(), seq: z.number().int().nonnegative() }),
  ),
});
