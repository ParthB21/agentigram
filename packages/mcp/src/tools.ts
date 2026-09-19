import {
  MCP_TOOL_NAMES,
  McpToolInputs,
  type McpToolName,
  mcpToolJsonSchemas,
  ValidationError,
} from '@clankergram/protocol';

/** MCP tool definition as advertised over `tools/list`. */
export type ToolDef = {
  name: McpToolName;
  description: string;
  inputSchema: Record<string, unknown>;
};

/**
 * Descriptions are written for the agent that reads them. Peer text is never described as a
 * command channel: there is no "run this" tool (spec → Security).
 */
export const TOOL_DESCRIPTIONS: Record<McpToolName, string> = {
  sync: 'Return the compressed team state: who is working on what, leases, open collisions and decisions.',
  announce_intent:
    'Declare what you are about to change, before editing. Lets the team flag overlaps early.',
  report: 'Report a discovery, a blocker or a bug so relevant teammates see it.',
  message_agent:
    'Send a short message to another agent (or "all"). Replies arrive at your next tool call.',
  propose: 'Propose a contract that resolves a collision you own.',
  respond: 'Accept a proposed contract, or counter it with your own and a reason.',
  ask_context: 'Ask another session a question about its work; the answer cites files and lines.',
  claim_complete: 'Declare your task complete. The team verifies it; you may be asked to continue.',
};

/**
 * Mirrors OpenAgents `buildToolDefs(disabledModules)`: definitions are data, and individual tools
 * can be switched off. Schemas come from `@clankergram/protocol`, so they cannot drift.
 */
export function buildToolDefs(disabled: ReadonlySet<McpToolName> = new Set()): ToolDef[] {
  const schemas = mcpToolJsonSchemas();
  return MCP_TOOL_NAMES.filter((n) => !disabled.has(n)).map((name) => ({
    name,
    description: TOOL_DESCRIPTIONS[name],
    inputSchema: schemas[name],
  }));
}

export type ToolCall = {
  [N in McpToolName]: { name: N; args: import('zod').infer<(typeof McpToolInputs)[N]> };
}[McpToolName];

/** Validates an untrusted `tools/call` request with the protocol's schema (CLAUDE.md rule 2). */
export function parseToolCall(name: string, args: unknown): ToolCall {
  if (!(MCP_TOOL_NAMES as string[]).includes(name))
    throw new ValidationError(`unknown tool: ${name}`);
  const toolName = name as McpToolName;
  const parsed = McpToolInputs[toolName].safeParse(args ?? {});
  if (!parsed.success) {
    throw new ValidationError(
      `invalid input for ${name}: ${parsed.error.issues[0]?.message}`,
      parsed.error.issues,
    );
  }
  return { name: toolName, args: parsed.data } as ToolCall;
}
