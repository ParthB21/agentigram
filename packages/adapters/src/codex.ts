import { relative, resolve, sep } from 'node:path';
import type { NewEvent } from '@agentigram/protocol';
import { z } from 'zod';
import type { AdapterContext, AgentAdapter } from './registry.js';
import { shellActivity } from './shell.js';

const hookNames = [
  'SessionStart',
  'UserPromptSubmit',
  'PreToolUse',
  'PostToolUse',
  'Stop',
  'SessionEnd',
] as const;

export const CodexHookInputSchema = z
  .object({
    session_id: z.string().min(1),
    transcript_path: z.string().nullable().optional(),
    cwd: z.string().min(1),
    hook_event_name: z.enum(hookNames),
    model: z.string().optional(),
    source: z.string().optional(),
    prompt: z.string().optional(),
    tool_name: z.string().optional(),
    tool_input: z.record(z.string(), z.unknown()).optional(),
    tool_response: z.unknown().optional(),
    reason: z.string().optional(),
  })
  .passthrough();

export type CodexHookInput = z.infer<typeof CodexHookInputSchema>;

export function codexToolPaths(input: Pick<CodexHookInput, 'tool_name' | 'tool_input'>): string[] {
  if (!['apply_patch', 'Edit', 'Write'].includes(input.tool_name ?? '')) return [];
  const command = input.tool_input?.command;
  if (typeof command !== 'string') return [];
  const paths = [...command.matchAll(/^\*\*\* (?:Add|Update|Delete) File: (.+)$/gm)].map((match) =>
    match[1]?.trim(),
  );
  return [...new Set(paths.filter((path): path is string => !!path))];
}

/** Protocol paths are always POSIX and repo-relative, whatever the host OS. */
function repoPath(cwd: string, value: unknown): string | undefined {
  if (typeof value !== 'string' || value.length === 0) return undefined;
  const absolute = resolve(cwd, value);
  const path = relative(cwd, absolute);
  return (path.startsWith('..') ? absolute : path || '.').split(sep).join('/');
}

/**
 * Shell commands that mean "this file was read".
 *
 * Codex has no built-in read tool: its canonical tools are `Bash`, `apply_patch`
 * and MCP tools, so an agent inspecting a file runs `cat`/`sed`/`head` through
 * the shell. Without this, a Codex session never builds a read set and can
 * never be the affected side of a collision.
 */
const READ_COMMANDS = new Set([
  'cat',
  'head',
  'tail',
  'less',
  'more',
  'bat',
  'nl',
  'sed',
  'awk',
  'rg',
  'grep',
  'wc',
]);

// Anything that looks like a source file rather than a flag or a glob.
const FILE_LIKE = /^[^-][^\s'"|;&<>()]*\.[A-Za-z0-9]+$/;

/**
 * Best-effort file paths out of a shell command line. Deliberately conservative:
 * a missed read costs a weaker collision tier, but a wrong path would put a file
 * in someone's read set that they never opened.
 */
export function codexShellReadPaths(cwd: string, command: unknown): string[] {
  if (typeof command !== 'string' || command.length === 0) return [];
  const found: string[] = [];
  // Split on shell separators so `cd x && cat a.ts | head` is seen as segments.
  for (const segment of command.split(/\|\||&&|[|;\n]/)) {
    const tokens = segment.trim().split(/\s+/).filter(Boolean);
    if (tokens.length === 0) continue;
    const binary = (tokens[0] ?? '').split('/').pop() ?? '';
    if (!READ_COMMANDS.has(binary)) continue;
    for (const token of tokens.slice(1)) {
      const bare = token.replace(/^["']|["']$/g, '');
      if (!FILE_LIKE.test(bare)) continue;
      const path = repoPath(cwd, bare);
      if (path) found.push(path);
    }
  }
  return [...new Set(found)];
}

export class CodexAdapter implements AgentAdapter {
  readonly host = 'codex';
  readonly mode = 'hooks' as const;

  async normalize(raw: unknown, context: AdapterContext): Promise<NewEvent[]> {
    const input = CodexHookInputSchema.parse(raw);
    const base = (): Pick<NewEvent, 'id' | 'roomId' | 'actor' | 'source'> => ({
      id: context.newId(),
      roomId: context.roomId,
      actor: {
        engineerId: context.engineerId,
        sessionId: context.sessionId,
        kind: 'agent',
      },
      source: 'hook',
    });
    if (input.hook_event_name === 'SessionStart') {
      return [
        {
          ...base(),
          payload: {
            type: 'SESSION_STARTED',
            sessionId: context.sessionId,
            host: this.host,
            model: input.model ?? 'unknown',
            branch: context.branch ?? 'unknown',
          },
        },
      ];
    }
    if (input.hook_event_name === 'SessionEnd') {
      return [
        {
          ...base(),
          payload: { type: 'SESSION_ENDED', sessionId: context.sessionId, reason: input.reason },
        },
      ];
    }
    if (input.hook_event_name === 'PostToolUse') {
      const paths = codexToolPaths(input);
      if (paths.length > 0) {
        return paths.map((path) => ({
          ...base(),
          payload: {
            type: 'FILE_WRITE' as const,
            path,
            worktree: context.worktree ?? input.cwd,
          },
        }));
      }
      // Shell edits. Codex works through the shell by default, so `sed -i`, a
      // redirect or a `git checkout` is its normal way of changing a file.
      const shell = shellActivity(
        typeof input.tool_input?.command === 'string' ? input.tool_input.command : undefined,
      );
      const shellWrites = shell.writes
        .map((path) => repoPath(input.cwd, path))
        .filter((path): path is string => Boolean(path));
      if (shellWrites.length > 0 || shell.git) {
        return [
          {
            ...base(),
            payload: {
              type: 'TOOL_CALL',
              tool: shell.git ?? input.tool_name ?? 'shell',
              phase: 'post',
              ...(shellWrites.length ? { paths: shellWrites } : {}),
              ok: true,
            },
          },
          ...shellWrites.map((path) => ({
            ...base(),
            payload: {
              type: 'FILE_WRITE' as const,
              path,
              worktree: context.worktree ?? input.cwd,
            },
          })),
        ];
      }
      // Reads. An MCP filesystem tool names its file directly; the shell does
      // not, so the command line has to be read for it.
      const readPaths = /^mcp__.*(read|cat|open|view)/i.test(input.tool_name ?? '')
        ? [repoPath(input.cwd, input.tool_input?.path ?? input.tool_input?.file_path)].filter(
            (path): path is string => !!path,
          )
        : codexShellReadPaths(input.cwd, input.tool_input?.command);
      // Symbols are left off deliberately: the daemon resolves them for any
      // FILE_READ that arrives without them (`attachReadSymbols`), using the
      // repo's TypeScript index, so every host gets the same treatment.
      if (readPaths.length > 0) {
        return readPaths.map((path) => ({
          ...base(),
          payload: { type: 'FILE_READ' as const, path },
        }));
      }
      return [
        {
          ...base(),
          payload: {
            type: 'TOOL_CALL',
            tool: input.tool_name ?? 'unknown',
            phase: 'post',
            ok: true,
          },
        },
      ];
    }
    if (input.hook_event_name === 'UserPromptSubmit') {
      return [
        {
          ...base(),
          payload: { type: 'TOOL_CALL', tool: 'HumanPrompt', phase: 'post', ok: true },
        },
      ];
    }
    return [];
  }
}
