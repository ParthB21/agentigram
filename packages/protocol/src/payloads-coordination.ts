import { z } from 'zod';
import { ContractSchema } from './contract.js';
import { payload } from './payloads-observed.js';
import { SymbolKeySchema } from './symbols.js';

export const COLLISION_TIERS = [
  'FILE_OVERLAP',
  'PREDICTED',
  'SEMANTIC',
  'CONFIRMED',
  'TEXTUAL',
] as const;
export const CollisionTierSchema = z.enum(COLLISION_TIERS);
export type CollisionTier = z.infer<typeof CollisionTierSchema>;

export const LeaseRequested = payload('LEASE_REQUESTED', {
  symbols: z.array(SymbolKeySchema),
  ttlMs: z.number().int().positive(),
});
export const LeaseGranted = payload('LEASE_GRANTED', {
  leaseId: z.string(),
  symbols: z.array(SymbolKeySchema),
  fencingToken: z.number().int().nonnegative(),
  expiresAt: z.string(),
});
export const LeaseDenied = payload('LEASE_DENIED', {
  symbols: z.array(SymbolKeySchema),
  heldBy: z.string(),
  leaseId: z.string().optional(),
  reason: z.string(),
});
export const LeaseReleased = payload('LEASE_RELEASED', { leaseId: z.string() });
export const LeaseExpired = payload('LEASE_EXPIRED', {
  leaseId: z.string(),
  reason: z.enum(['ttl', 'disconnect', 'session_ended', 'overridden']).optional(),
});

export const Collision = payload('COLLISION', {
  collisionId: z.string(),
  tier: CollisionTierSchema,
  symbols: z.array(SymbolKeySchema),
  writerSession: z.string(),
  affectedSessions: z.array(z.string()),
  detail: z.string(),
  confidence: z.number().min(0).max(1).optional(),
});
export const Proposal = payload('PROPOSAL', { collisionId: z.string(), contract: ContractSchema });
export const Counter = payload('COUNTER', {
  collisionId: z.string(),
  contract: ContractSchema,
  reason: z.string(),
});
export const Accept = payload('ACCEPT', { collisionId: z.string() });
export const Escalate = payload('ESCALATE', { collisionId: z.string(), reason: z.string() });
export const ContractCompiled = payload('CONTRACT_COMPILED', {
  contractId: z.string(),
  collisionId: z.string().optional(),
  checkFiles: z.array(z.object({ path: z.string(), content: z.string() })),
});

// Context
export const ContextPacket = payload('CONTEXT_PACKET', {
  kind: z.enum(['intent', 'lease_release', 'completion', 'handoff']),
  body: z.string(),
  symbols: z.array(SymbolKeySchema),
});
export const ContextQuery = payload('CONTEXT_QUERY', {
  queryId: z.string(),
  toSession: z.string(),
  question: z.string(),
});
export const ContextAnswer = payload('CONTEXT_ANSWER', {
  queryId: z.string(),
  answer: z.string(),
  citations: z.array(z.object({ path: z.string(), line: z.number().int().positive().optional() })),
});
