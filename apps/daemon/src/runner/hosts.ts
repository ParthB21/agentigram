import { randomUUID } from 'node:crypto';

export type ManagedHost = 'codex' | 'claude-code';

/** What to execute. The prompt travels on stdin so nothing a peer wrote ever reaches a command line. */
export type Invocation = { command: string; args: string[]; stdin: string };

/** What one line of host output can tell the runner. */
export type HostLine = { sessionId?: string; finalText?: string; error?: string };

export type HostAdapter = {
  readonly host: ManagedHost;
  /** Claude takes a generated id up front; Codex reports its thread id in the stream. */
  start(prompt: string): { invocation: Invocation; sessionId?: string };
  resume(sessionId: string, prompt: string): Invocation;
  parseLine(line: string): HostLine;
};

export type AdapterOptions = {
  /** Dangerous unattended host flags are unavailable without explicit consent. */
  autonomous?: boolean;
  /** Replace the host binary — tests point this at a fake. */
  command?: string;
  prefixArgs?: string[];
};

function requireAutonomous(options: AdapterOptions): void {
  if (options.autonomous !== true) {
    throw new Error('managed host adapters require explicit autonomous mode');
  }
}

function json(line: string): Record<string, unknown> | undefined {
  try {
    const value: unknown = JSON.parse(line);
    return value && typeof value === 'object' ? (value as Record<string, unknown>) : undefined;
  } catch {
    return undefined;
  }
}

const str = (value: unknown): string | undefined =>
  typeof value === 'string' && value.length > 0 ? value : undefined;

/**
 * `claude --print --output-format stream-json` (which needs `--verbose`).
 * Auto permission mode keeps the run non-interactive while Claude's classifier
 * and Agentigram's hooks continue reviewing actions.
 */
export function claudeAdapter(options: AdapterOptions = {}): HostAdapter {
  requireAutonomous(options);
  const command = options.command ?? 'claude';
  const prefix = options.prefixArgs ?? [];
  const common = [
    '--print',
    '--output-format',
    'stream-json',
    '--verbose',
    '--permission-mode',
    'auto',
  ];
  return {
    host: 'claude-code',
    start(prompt) {
      const sessionId = randomUUID();
      return {
        sessionId,
        invocation: {
          command,
          args: [...prefix, ...common, '--session-id', sessionId],
          stdin: prompt,
        },
      };
    },
    resume: (sessionId, prompt) => ({
      command,
      args: [...prefix, ...common, '--resume', sessionId],
      stdin: prompt,
    }),
    parseLine(line) {
      const event = json(line);
      if (!event) return {};
      const sessionId = str(event.session_id);
      if (event.type === 'result') {
        const text = str(event.result);
        return {
          ...(sessionId ? { sessionId } : {}),
          ...(event.is_error === true
            ? { error: text ?? 'claude reported an error' }
            : text
              ? { finalText: text }
              : {}),
        };
      }
      return sessionId ? { sessionId } : {};
    },
  };
}

/**
 * `codex exec --json`: a JSONL stream whose `thread.started` names the thread
 * and whose last `agent_message` item is the answer. Resuming is
 * `codex exec resume <id>`; `-` reads the prompt from stdin. Autonomous mode
 * uses workspace-write plus automatic approval review. It can edit the checked
 * out repository without granting peer-triggered turns unrestricted host access.
 */
export function codexAdapter(options: AdapterOptions = {}): HostAdapter {
  requireAutonomous(options);
  const command = options.command ?? 'codex';
  const prefix = options.prefixArgs ?? [];
  const common = ['exec', '--json', '--sandbox', 'workspace-write', '--approve-for-me'];
  return {
    host: 'codex',
    start: (prompt) => ({
      invocation: { command, args: [...prefix, ...common, '-'], stdin: prompt },
    }),
    resume: (sessionId, prompt) => ({
      command,
      args: [...prefix, ...common, 'resume', sessionId, '-'],
      stdin: prompt,
    }),
    parseLine(line) {
      const event = json(line);
      if (!event) return {};
      if (event.type === 'thread.started') {
        const sessionId = str(event.thread_id);
        return sessionId ? { sessionId } : {};
      }
      if (event.type === 'item.completed') {
        const item = event.item as Record<string, unknown> | undefined;
        const text = item?.type === 'agent_message' ? str(item.text) : undefined;
        return text ? { finalText: text } : {};
      }
      if (event.type === 'turn.failed') {
        const error = event.error as Record<string, unknown> | undefined;
        return { error: str(error?.message) ?? 'codex turn failed' };
      }
      if (event.type === 'error') return { error: str(event.message) ?? 'codex error' };
      return {};
    },
  };
}

export function createAdapter(host: string, options: AdapterOptions = {}): HostAdapter {
  if (host === 'codex') return codexAdapter(options);
  if (host === 'claude-code') return claudeAdapter(options);
  throw new Error(`managed runs support codex and claude-code, not ${host}`);
}
