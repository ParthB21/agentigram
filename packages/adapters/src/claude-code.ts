import { relative, resolve, sep } from 'node:path';
import type { NewEvent, SymbolKey } from '@agentigram/protocol';
import { z } from 'zod';
import { redactSecrets } from './redact.js';
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

export const ClaudeHookInputSchema = z
  .object({
    session_id: z.string().min(1),
    transcript_path: z.string().min(1),
    cwd: z.string().min(1),
    hook_event_name: z.enum(hookNames),
    model: z.string().optional(),
    source: z.string().optional(),
    prompt: z.string().optional(),
    tool_name: z.string().optional(),
    tool_input: z.record(z.string(), z.unknown()).optional(),
    tool_response: z.unknown().optional(),
    stop_hook_active: z.boolean().optional(),
    reason: z.string().optional(),
  })
  .passthrough();

export type ClaudeHookInput = z.infer<typeof ClaudeHookInputSchema>;
export type ReadSymbols = (paths: string[], cwd?: string) => Promise<SymbolKey[]>;

const READ_TOOLS = new Set(['Read', 'Grep', 'Glob']);
const WRITE_TOOLS = new Set(['Edit', 'Write', 'MultiEdit']);
const MAX_TOOL_SUMMARY_CHARS = 240;

function repoPath(cwd: string, input: unknown): string | undefined {
  if (typeof input !== 'string' || input.length === 0) return undefined;
  const absolute = resolve(cwd, input);
  const path = relative(cwd, absolute);
  // Protocol paths are always POSIX, whatever the host OS.
  return (path.startsWith('..') ? absolute : path || '.').split(sep).join('/');
}

export function claudeToolPaths(input: ClaudeHookInput): string[] {
  const toolInput = input.tool_input ?? {};
  const candidates: unknown[] = [toolInput.file_path, toolInput.path];
  if (Array.isArray(toolInput.edits)) {
    for (const edit of toolInput.edits) {
      if (edit && typeof edit === 'object') {
        candidates.push((edit as Record<string, unknown>).file_path);
      }
    }
  }
  return [
    ...new Set(candidates.map((path) => repoPath(input.cwd, path)).filter(Boolean)),
  ] as string[];
}

function baseEvent(ctx: AdapterContext): Pick<NewEvent, 'id' | 'roomId' | 'actor' | 'source'> {
  return {
    id: ctx.newId(),
    roomId: ctx.roomId,
    actor: { engineerId: ctx.engineerId, sessionId: ctx.sessionId, kind: 'agent' },
    source: 'hook',
  };
}

export class ClaudeCodeAdapter implements AgentAdapter {
  readonly host = 'claude-code';
  readonly mode = 'hooks' as const;
  private readonly promptedSessions = new Set<string>();

  constructor(private readonly readSymbols: ReadSymbols = async () => []) {}

  async normalize(raw: unknown, ctx: AdapterContext): Promise<NewEvent[]> {
    const input = ClaudeHookInputSchema.parse(raw);
    const base = () => baseEvent(ctx);

    switch (input.hook_event_name) {
      case 'SessionStart':
        return [
          {
            ...base(),
            payload: {
              type: 'SESSION_STARTED',
              sessionId: ctx.sessionId,
              host: this.host,
              model: input.model ?? 'unknown',
              branch: ctx.branch ?? 'unknown',
            },
          },
        ];
      case 'SessionEnd':
        this.promptedSessions.delete(ctx.sessionId);
        return [
          {
            ...base(),
            payload: { type: 'SESSION_ENDED', sessionId: ctx.sessionId, reason: input.reason },
          },
        ];
      case 'UserPromptSubmit': {
        const seen = this.promptedSessions.has(ctx.sessionId);
        this.promptedSessions.add(ctx.sessionId);
        return seen
          ? [
              {
                ...base(),
                payload: { type: 'TOOL_CALL', tool: 'HumanPrompt', phase: 'post', ok: true },
              },
            ]
          : [];
      }
      case 'PostToolUse': {
        const tool = input.tool_name ?? 'unknown';
        const paths = claudeToolPaths(input);
        if (READ_TOOLS.has(tool)) {
          const symbols = await this.readSymbols(paths, input.cwd);
          return paths.map((path) => ({
            ...base(),
            payload: { type: 'FILE_READ' as const, path, ...(symbols.length ? { symbols } : {}) },
          }));
        }
        if (WRITE_TOOLS.has(tool)) {
          return paths.map((path) => ({
            ...base(),
            payload: { type: 'FILE_WRITE' as const, path, worktree: ctx.worktree ?? input.cwd },
          }));
        }
        if (tool === 'Bash') {
          const command = input.tool_input?.command;
          const summary = redactSecrets(command, { catchAll: true }).slice(
            0,
            MAX_TOOL_SUMMARY_CHARS,
          );
          // A shell edit is still an edit: without this, an agent that works through `sed -i`,
          // a redirect or `git checkout` is invisible to collision detection.
          const shell = shellActivity(typeof command === 'string' ? command : undefined);
          const writes = shell.writes
            .map((path) => repoPath(input.cwd, path))
            .filter((path): path is string => Boolean(path));
          return [
            {
              ...base(),
              payload: {
                type: 'TOOL_CALL',
                tool: shell.git ?? (summary ? `Bash: ${summary}` : 'Bash'),
                phase: 'post',
                paths: writes.length ? writes : paths.length ? paths : undefined,
                ok: true,
              },
            },
            ...writes.map((path) => ({
              ...base(),
              payload: {
                type: 'FILE_WRITE' as const,
                path,
                worktree: ctx.worktree ?? input.cwd,
              },
            })),
          ];
        }
        return [];
      }
      case 'PreToolUse':
      case 'Stop':
        return [];
    }
  }
}
