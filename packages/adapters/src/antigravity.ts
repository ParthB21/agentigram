import { relative, resolve, sep } from 'node:path';
import type { NewEvent } from '@agentigram/protocol';
import { z } from 'zod';
import { redactSecrets } from './redact.js';
import type { AdapterContext, AgentAdapter } from './registry.js';

/**
 * Antigravity (agy) hook lifecycle events.
 * Mirrors the Gemini CLI hook names — agy exposes the same five checkpoints
 * plus the two Gemini-style session bookends.
 */
const hookNames = [
  'SessionStart',
  'PreInvocation',
  'PreToolUse',
  'PostToolUse',
  'PostInvocation',
  'Stop',
  'SessionEnd',
] as const;

export const AntigravityHookInputSchema = z
  .object({
    session_id: z.string().min(1),
    transcript_path: z.string().optional(),
    cwd: z.string().min(1),
    hook_event_name: z.enum(hookNames),
    timestamp: z.string().optional(),
    model: z.string().optional(),
    source: z.string().optional(),
    prompt: z.string().optional(),
    prompt_response: z.string().optional(),
    tool_name: z.string().optional(),
    tool_input: z.record(z.string(), z.unknown()).optional(),
    tool_response: z.unknown().optional(),
    stop_hook_active: z.boolean().optional(),
    reason: z.string().optional(),
  })
  .passthrough();

export type AntigravityHookInput = z.infer<typeof AntigravityHookInputSchema>;

// agy uses the same tool name conventions as Gemini CLI
const READ_TOOLS = new Set(['read_file', 'read_many_files', 'glob', 'search_file_content', 'grep_search']);
const WRITE_TOOLS = new Set(['write_to_file', 'replace_file_content', 'multi_replace_file_content', 'write_file', 'replace', 'apply_patch']);
const MAX_TOOL_SUMMARY_CHARS = 240;

function repoPath(cwd: string, input: unknown): string | undefined {
  if (typeof input !== 'string' || input.length === 0) return undefined;
  const absolute = resolve(cwd, input);
  const path = relative(cwd, absolute);
  return (path.startsWith('..') ? absolute : path || '.').split(sep).join('/');
}

export function antigravityToolPaths(
  input: Pick<AntigravityHookInput, 'cwd' | 'tool_name' | 'tool_input'>,
): string[] {
  const toolInput = input.tool_input ?? {};
  const candidates: unknown[] = [
    toolInput.file_path,
    toolInput.path,
    toolInput.TargetFile,   // agy write_to_file / replace_file_content
    toolInput.AbsolutePath, // agy view_file / read_file
    toolInput.dir_path,
    toolInput.target_file,
  ];
  if (Array.isArray(toolInput.paths)) candidates.push(...toolInput.paths);
  return [
    ...new Set(candidates.map((p) => repoPath(input.cwd, p)).filter(Boolean)),
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

export class AntigravityAdapter implements AgentAdapter {
  readonly host = 'antigravity';
  readonly mode = 'hooks' as const;
  private readonly startedSessions = new Set<string>();
  private readonly promptedSessions = new Set<string>();

  async normalize(raw: unknown, ctx: AdapterContext): Promise<NewEvent[]> {
    const input = AntigravityHookInputSchema.parse(raw);
    const base = () => baseEvent(ctx);

    switch (input.hook_event_name) {
      case 'SessionStart':
        this.startedSessions.add(ctx.sessionId);
        return [
          {
            ...base(),
            payload: {
              type: 'SESSION_STARTED',
              sessionId: ctx.sessionId,
              host: this.host,
              model: input.model ?? 'gemini',
              branch: ctx.branch ?? 'unknown',
            },
          },
        ];

      case 'SessionEnd':
        this.startedSessions.delete(ctx.sessionId);
        this.promptedSessions.delete(ctx.sessionId);
        return [
          {
            ...base(),
            payload: { type: 'SESSION_ENDED', sessionId: ctx.sessionId, reason: input.reason },
          },
        ];

      case 'PreInvocation': {
        // First PreInvocation is session start if we haven't seen SessionStart
        const started = this.startedSessions.has(ctx.sessionId);
        this.startedSessions.add(ctx.sessionId);
        const seen = this.promptedSessions.has(ctx.sessionId);
        this.promptedSessions.add(ctx.sessionId);
        if (!started) {
          return [
            {
              ...base(),
              payload: {
                type: 'SESSION_STARTED',
                sessionId: ctx.sessionId,
                host: this.host,
                model: input.model ?? 'gemini',
                branch: ctx.branch ?? 'unknown',
              },
            },
          ];
        }
        // Subsequent PreInvocations = user re-prompted the agent
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
        const paths = antigravityToolPaths(input);
        if (READ_TOOLS.has(tool)) {
          return paths.map((path) => ({
            ...base(),
            payload: { type: 'FILE_READ' as const, path },
          }));
        }
        if (WRITE_TOOLS.has(tool)) {
          return paths.map((path) => ({
            ...base(),
            payload: { type: 'FILE_WRITE' as const, path, worktree: ctx.worktree ?? input.cwd },
          }));
        }
        if (tool === 'run_command' || tool === 'Bash') {
          const command = input.tool_input?.command ?? input.tool_input?.CommandLine;
          const summary = redactSecrets(command, { catchAll: true }).slice(
            0,
            MAX_TOOL_SUMMARY_CHARS,
          );
          return [
            {
              ...base(),
              payload: {
                type: 'TOOL_CALL',
                tool: summary ? `Shell: ${summary}` : 'Shell',
                phase: 'post',
                paths: paths.length ? paths : undefined,
                ok: true,
              },
            },
          ];
        }
        return [
          {
            ...base(),
            payload: { type: 'TOOL_CALL', tool, phase: 'post', ok: true },
          },
        ];
      }

      case 'PreToolUse':
      case 'PostInvocation':
      case 'Stop':
        return [];
    }
  }
}
