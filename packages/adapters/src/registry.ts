import { type NewEvent, NotImplementedError } from '@clankergram/protocol';

/** What an adapter needs to stamp events it produces. Ids and time never come from the adapter. */
export type AdapterContext = {
  roomId: string;
  engineerId: string;
  sessionId: string;
  newId: () => string;
};

/** Normalises one agent host's raw signals (hook payloads) into protocol events. */
export interface AgentAdapter {
  readonly host: string;
  /** `hooks`: full passive capture. `degraded`: file watcher + MCP only (spec → Adapters). */
  readonly mode: 'hooks' | 'degraded';
  normalize(input: unknown, ctx: AdapterContext): NewEvent[];
}

export type HostInfo = {
  host: string;
  displayName: string;
  mode: AgentAdapter['mode'];
  status: 'stub' | 'planned';
};

/**
 * Catalog of known hosts (the OpenAgents `registry/*.json` idea, in code). Claude Code first;
 * the others are added "as their hook support allows" (spec → Adapters).
 */
export const HOST_CATALOG: readonly HostInfo[] = [
  { host: 'claude-code', displayName: 'Claude Code', mode: 'hooks', status: 'stub' },
  { host: 'codex', displayName: 'Codex CLI', mode: 'degraded', status: 'planned' },
  { host: 'cursor', displayName: 'Cursor', mode: 'degraded', status: 'planned' },
  { host: 'gemini-cli', displayName: 'Gemini CLI', mode: 'degraded', status: 'planned' },
];

export class UnknownHostError extends Error {
  constructor(host: string) {
    super(`unknown agent host "${host}". Known: ${HOST_CATALOG.map((h) => h.host).join(', ')}`);
    this.name = 'UnknownHostError';
  }
}

/**
 * Claude Code adapter. Hook payload shapes must be verified against the current official docs
 * before this is implemented (CLAUDE.md rule 10), so this is deliberately a stub.
 */
class ClaudeCodeAdapter implements AgentAdapter {
  readonly host = 'claude-code';
  readonly mode = 'hooks' as const;
  normalize(): NewEvent[] {
    throw new NotImplementedError(
      'ClaudeCodeAdapter.normalize (Part 2: verify hook payloads first)',
    );
  }
}

/** Host with no usable hooks: nothing to normalise; the watcher and MCP carry the signal. */
class DegradedAdapter implements AgentAdapter {
  readonly mode = 'degraded' as const;
  constructor(readonly host: string) {}
  normalize(): NewEvent[] {
    return [];
  }
}

export type AdapterFactory = () => AgentAdapter;

const factories = new Map<string, AdapterFactory>([['claude-code', () => new ClaudeCodeAdapter()]]);

/** Registers or replaces an adapter for a host (how Part 2 plugs real adapters in). */
export function registerAdapter(host: string, factory: AdapterFactory): void {
  factories.set(host, factory);
}

/** Mirrors OpenAgents `createAdapter(type)`: registered → that adapter, catalogued → degraded. */
export function createAdapter(host: string): AgentAdapter {
  const factory = factories.get(host);
  if (factory) return factory();
  if (HOST_CATALOG.some((h) => h.host === host)) return new DegradedAdapter(host);
  throw new UnknownHostError(host);
}

export function listHosts(): HostInfo[] {
  return HOST_CATALOG.map((h) => ({ ...h }));
}
