import { z } from 'zod';
import { ContractSchema } from './contract.js';
import { MAX_MESSAGE_TEXT_LENGTH } from './payloads-observed.js';
import { SymbolKeySchema } from './symbols.js';

/** MCP tool inputs (spec → "MCP tools"). Only what agents must declare; the rest is observed. */
export const McpToolInputs = {
  sync: z.object({}),
  announce_intent: z.object({
    task: z.string().max(500),
    files: z.array(z.string()).max(100),
    symbols: z.array(SymbolKeySchema).max(100),
  }),
  report: z.object({
    kind: z.enum(['discovery', 'blocker', 'bug']),
    text: z.string().min(1).max(MAX_MESSAGE_TEXT_LENGTH),
    symbols: z.array(SymbolKeySchema).max(50).optional(),
  }),
  message_agent: z.object({
    to: z.string(),
    text: z.string().max(2000),
    collisionId: z.string().optional(),
  }),
  propose: z.object({ collisionId: z.string(), contract: ContractSchema }),
  respond: z.object({
    collisionId: z.string(),
    action: z.enum(['accept', 'counter']),
    contract: ContractSchema.optional(),
    reason: z.string().max(1000).optional(),
  }),
  ask_context: z.object({ session: z.string(), question: z.string().max(1000) }),
  claim_complete: z.object({ summary: z.string().max(2000) }),
} as const;

export type McpToolName = keyof typeof McpToolInputs;
export const MCP_TOOL_NAMES = Object.keys(McpToolInputs) as McpToolName[];

/** JSON Schema for each tool input, via Zod's native export (Zod 4). */
export function mcpToolJsonSchemas(): Record<McpToolName, Record<string, unknown>> {
  return Object.fromEntries(
    MCP_TOOL_NAMES.map((name) => [
      name,
      z.toJSONSchema(McpToolInputs[name]) as Record<string, unknown>,
    ]),
  ) as Record<McpToolName, Record<string, unknown>>;
}
