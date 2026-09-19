import type { NewEvent } from '@agentigram/protocol';
import { AntigravityAdapter } from './antigravity.js';
import { ClaudeCodeAdapter } from './claude-code.js';
import { CodexAdapter } from './codex.js';
import { GeminiCliAdapter } from './gemini-cli.js';

/** What an adapter needs to stamp events it produces. Ids and time never come from the adapter. */
export type AdapterContext = {
  roomId: string;
  engineerId: string;
  sessionId: string;
  newId: () => string;
  branch?: string;
  worktree?: string;
};

/** Normalises one agent host's raw signals (hook payloads) into protocol events. */
export interface AgentAdapter {
  readonly host: string;
  /** `hooks`: full passive capture. `degraded`: file watcher + MCP only (spec → Adapters). */
  readonly mode: 'hooks' | 'degraded';
  normalize(input: unknown, ctx: AdapterContext): Promise<NewEvent[]>;
}

export type HostInfo = {
  host: string;
  displayName: string;
  mode: AgentAdapter['mode'];
  status: 'ready' | 'planned';
};

/**
 * Catalog of known hosts (the OpenAgents `registry/*.json` idea, in code). Claude Code first;
 * the others are added "as their hook support allows" (spec → Adapters).
 */
export const HOST_CATALOG: readonly HostInfo[] = [
  { host: 'claude-code', displayName: 'Claude Code', mode: 'hooks', status: 'ready' },
  { host: 'codex', displayName: 'Codex CLI', mode: 'hooks', status: 'ready' },
  { host: 'cursor', displayName: 'Cursor', mode: 'degraded', status: 'planned' },
  { host: 'gemini-cli', displayName: 'Gemini CLI', mode: 'hooks', status: 'ready' },
  { host: 'antigravity', displayName: 'Antigravity (agy)', mode: 'hooks', status: 'ready' },
];

export class UnknownHostError extends Error {
  constructor(host: string) {
    super(`unknown agent host "${host}". Known: ${HOST_CATALOG.map((h) => h.host).join(', ')}`);
    this.name = 'UnknownHostError';
  }
}

/** Host with no usable hooks: nothing to normalise; the watcher and MCP carry the signal. */
class DegradedAdapter implements AgentAdapter {
  readonly mode = 'degraded' as const;
  constructor(readonly host: string) {}
  async normalize(): Promise<NewEvent[]> {
    return Promise.resolve([]);
  }
}

export type AdapterFactory = () => AgentAdapter;

const factories = new Map<string, AdapterFactory>([
  ['claude-code', () => new ClaudeCodeAdapter()],
  ['codex', () => new CodexAdapter()],
  ['gemini-cli', () => new GeminiCliAdapter()],
  ['antigravity', () => new AntigravityAdapter()],
]);

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
