import { z } from 'zod';
import * as C from './payloads-coordination.js';
import * as O from './payloads-observed.js';
import * as X from './payloads-other.js';

export const PayloadSchema = z.discriminatedUnion('type', [
  // Observed
  O.FileRead,
  O.FileWrite,
  O.ApiDelta,
  O.ToolCall,
  O.Usage,
  // Declared
  O.Intent,
  O.Discovery,
  O.Blocker,
  O.Bug,
  O.Message,
  O.CompleteClaimed,
  // Coordination
  C.LeaseRequested,
  C.LeaseGranted,
  C.LeaseDenied,
  C.LeaseReleased,
  C.LeaseExpired,
  C.Collision,
  C.Proposal,
  C.Counter,
  C.Accept,
  C.Escalate,
  C.ContractCompiled,
  // Context
  C.ContextPacket,
  C.ContextQuery,
  C.ContextAnswer,
  // Verification
  X.SpecMergeResult,
  X.CiResult,
  X.ReviewResult,
  X.ContractResult,
  X.RunVerified,
  // Session
  X.SessionStarted,
  X.SessionEnded,
  X.Heartbeat,
  X.TaskCreated,
  X.DuelStarted,
  X.DuelResult,
  // Dashboard-only
  X.MarketOpened,
  X.Trade,
  X.MarketClosed,
  X.MarketResolved,
  X.MarketVoided,
  X.PersonaLines,
]);
export type Payload = z.infer<typeof PayloadSchema>;
export type PayloadType = Payload['type'];
export type PayloadOf<T extends PayloadType> = Extract<Payload, { type: T }>;

export const PAYLOAD_TYPES: readonly PayloadType[] = PayloadSchema.options.map(
  (o) => o.shape.type.value,
);
