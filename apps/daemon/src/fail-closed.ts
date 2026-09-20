import {
  antigravityToolPaths,
  claudeToolPaths,
  codexToolPaths,
  geminiToolPaths,
} from '@agentigram/adapters';

/** The hook events that run before a tool does, and so are the only ones that can stop it. */
export const isPreToolEvent = (event: string): boolean =>
  event === 'PreToolUse' || event === 'BeforeTool';

/**
 * The deny to answer with when the daemon cannot be asked. A host treats a hook that errors as
 * "no objection", so an unreachable daemon would otherwise let every write through — including the
 * two-laptops-one-file case this whole layer exists to stop.
 *
 * "Write" is decided by the call naming a file path. The installed PreToolUse matchers already
 * limit this hook to Edit/Write/MultiEdit/Bash, and a Bash call carries no file path here, so it
 * passes: shell writes are not covered when the daemon is down. Everything else fails open too,
 * so a dead daemon does not brick the agent.
 */
export function failClosedDenial(host: string, input: unknown, why: string): object | undefined {
  const paths = writePaths(host, input);
  if (paths.length === 0) return undefined;
  const reason = `STOP. Agentigram could not check whether ${paths[0]} is safe to modify (${why}). Do not modify any file until it can. Do not retry or route around this. Tell the user to run \`agg status\` and wait.`;
  if (host === 'gemini-cli') return { decision: 'deny', reason };
  return {
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: 'deny',
      permissionDecisionReason: reason,
    },
  };
}

function writePaths(host: string, input: unknown): string[] {
  try {
    if (host === 'codex') return codexToolPaths(input as never);
    if (host === 'gemini-cli') return geminiToolPaths(input as never);
    if (host === 'antigravity') return antigravityToolPaths(input as never);
    return claudeToolPaths(input as never);
  } catch {
    // A payload we cannot read is one we cannot vouch for, but we also cannot name a file to refuse.
    return [];
  }
}
