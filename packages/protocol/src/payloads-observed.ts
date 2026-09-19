import { z } from 'zod';
import { SymbolKeySchema } from './symbols.js';

/** Payload helper: keeps the literal `type` so the union discriminates. */
export const payload = <T extends string, S extends z.ZodRawShape>(type: T, shape: S) =>
  z.object({ type: z.literal(type), ...shape });

// Observed
export const FileRead = payload('FILE_READ', {
  path: z.string(),
  symbols: z.array(SymbolKeySchema).optional(),
});
export const FileWrite = payload('FILE_WRITE', {
  path: z.string(),
  worktree: z.string(),
  /** Lease generation observed by the edit guard. Omitted when no leased symbol is touched. */
  fencingToken: z.number().int().nonnegative().optional(),
});

export const ApiChangeSchema = z.object({
  symbol: SymbolKeySchema,
  before: z.string().nullable(),
  after: z.string().nullable(),
  breaking: z.boolean(),
  reason: z.string(),
});
export type ApiChange = z.infer<typeof ApiChangeSchema>;
export const ApiDelta = payload('API_DELTA', {
  module: z.string(),
  changes: z.array(ApiChangeSchema),
});

export const ToolCall = payload('TOOL_CALL', {
  tool: z.string(),
  phase: z.enum(['pre', 'post']).optional(),
  paths: z.array(z.string()).optional(),
  ok: z.boolean().optional(),
});
export const Usage = payload('USAGE', {
  model: z.string(),
  inputTokens: z.number().int().nonnegative().optional(),
  outputTokens: z.number().int().nonnegative().optional(),
  costUsd: z.number().nonnegative().optional(),
  latencyMs: z.number().nonnegative().optional(),
});

// Declared
export const Intent = payload('INTENT', {
  task: z.string(),
  files: z.array(z.string()),
  symbols: z.array(SymbolKeySchema),
});
export const Discovery = payload('DISCOVERY', {
  text: z.string(),
  symbols: z.array(SymbolKeySchema).optional(),
});
export const Blocker = payload('BLOCKER', { text: z.string(), blockedOn: z.string().optional() });
export const Bug = payload('BUG', {
  bugId: z.string().optional(),
  text: z.string(),
  symbols: z.array(SymbolKeySchema).optional(),
  files: z.array(z.string()).optional(),
});
export const Message = payload('MESSAGE', {
  to: z.string(), // a sessionId, or 'all'
  text: z.string(),
  collisionId: z.string().optional(),
});
export const CompleteClaimed = payload('COMPLETE_CLAIMED', { summary: z.string() });
