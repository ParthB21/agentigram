import { z } from 'zod';
import { ContractSchema } from './contract.js';
import { CollisionTierSchema } from './payloads-coordination.js';
import { MarketKindSchema } from './payloads-other.js';
import { SymbolKeySchema } from './symbols.js';

export const SessionStatusSchema = z.enum(['active', 'idle', 'blocked', 'ended']);

export const SessionInfoSchema = z.object({
  sessionId: z.string(),
  engineerId: z.string(),
  host: z.string(),
  model: z.string(),
  provider: z.string().optional(),
  branch: z.string(),
  role: z.string().optional(),
  task: z.string().optional(),
  status: SessionStatusSchema,
  intent: z
    .object({ task: z.string(), files: z.array(z.string()), symbols: z.array(SymbolKeySchema) })
    .optional(),
  readFiles: z.array(z.string()).optional(),
  readSymbols: z.array(SymbolKeySchema).optional(),
  writeFiles: z.array(z.string()).optional(),
  startedAt: z.string(),
  lastHeartbeatAt: z.string(),
  endedAt: z.string().optional(),
});
export type SessionInfo = z.infer<typeof SessionInfoSchema>;

export const LeaseSchema = z.object({
  leaseId: z.string(),
  sessionId: z.string(),
  symbols: z.array(SymbolKeySchema),
  fencingToken: z.number().int(),
  expiresAt: z.string(),
  ttlMs: z.number().int().positive().optional(),
});
export type Lease = z.infer<typeof LeaseSchema>;

export const CollisionStateSchema = z.object({
  collisionId: z.string(),
  tier: CollisionTierSchema,
  symbols: z.array(SymbolKeySchema),
  writerSession: z.string(),
  affectedSessions: z.array(z.string()),
  detail: z.string(),
  status: z.enum(['open', 'resolved']),
  openedSeq: z.number().int(),
});
export type CollisionState = z.infer<typeof CollisionStateSchema>;

/** Negotiation state machine (spec → "Negotiation and the contract ledger"). */
export const NEGOTIATION_STATES = [
  'Open',
  'Proposed',
  'Countered',
  'Accepted',
  'Compiled',
  'Verified',
  'Escalated',
] as const;
export const NegotiationStateSchema = z.enum(NEGOTIATION_STATES);
export type NegotiationStateName = z.infer<typeof NegotiationStateSchema>;

export const NegotiationSchema = z.object({
  collisionId: z.string(),
  state: NegotiationStateSchema,
  round: z.number().int().nonnegative(),
  participants: z.array(z.string()),
  accepted: z.array(z.string()),
  contract: ContractSchema.optional(),
  openedSeq: z.number().int(),
  deadlineAt: z.string().optional(),
});
export type Negotiation = z.infer<typeof NegotiationSchema>;

export const LedgerContractSchema = z.object({
  contractId: z.string(),
  collisionId: z.string().optional(),
  contract: ContractSchema,
  version: z.number().int().positive(),
  status: z.enum(['compiled', 'verified', 'superseded']),
  supersededBy: z.string().optional(),
});
export type LedgerContract = z.infer<typeof LedgerContractSchema>;

export const MarketStateSchema = z.object({
  marketId: z.string(),
  kind: MarketKindSchema,
  question: z.string(),
  outcomes: z.array(z.string()),
  b: z.number(),
  closesAt: z.string(),
  subjectSession: z.string().optional(),
  status: z.enum(['open', 'closed', 'resolved', 'void']),
  /** Outstanding shares per outcome (LMSR `q`). */
  shares: z.record(z.string(), z.number()),
  resolvedOutcome: z.string().optional(),
});
export type MarketState = z.infer<typeof MarketStateSchema>;

export const TeamSummarySchema = z.object({
  sessions: z.number().int(),
  activeSessions: z.number().int(),
  openCollisions: z.number().int(),
  openNegotiations: z.number().int(),
  activeLeases: z.number().int(),
});
export type TeamSummary = z.infer<typeof TeamSummarySchema>;

export const RoomStateSchema = z.object({
  roomId: z.string(),
  lastSeq: z.number().int().nonnegative(),
  sessions: z.record(z.string(), SessionInfoSchema),
  leases: z.record(z.string(), LeaseSchema),
  collisions: z.record(z.string(), CollisionStateSchema),
  negotiations: z.record(z.string(), NegotiationSchema),
  contracts: z.record(z.string(), LedgerContractSchema),
  markets: z.record(z.string(), MarketStateSchema),
  teamSummary: TeamSummarySchema,
});
export type RoomState = z.infer<typeof RoomStateSchema>;

export function emptyRoomState(roomId: string): RoomState {
  return {
    roomId,
    lastSeq: 0,
    sessions: {},
    leases: {},
    collisions: {},
    negotiations: {},
    contracts: {},
    markets: {},
    teamSummary: {
      sessions: 0,
      activeSessions: 0,
      openCollisions: 0,
      openNegotiations: 0,
      activeLeases: 0,
    },
  };
}
