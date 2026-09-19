import { relative, resolve, sep } from 'node:path';
import type { NewEvent } from '@agentigram/protocol';
import { z } from 'zod';
import { redactSecrets } from './redact.js';
import type { AdapterContext, AgentAdapter } from './registry.js';

const hookNames = [
  'SessionStart',
  'BeforeAgent',
  'BeforeTool',
  'AfterTool',
  'AfterAgent',
  'SessionEnd',
] as const;

export const GeminiHookInputSchema = z
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

export type GeminiHookInput = z.infer<typeof GeminiHookInputSchema>;

const READ_TOOLS = new Set(['read_file', 'read_many_files', 'glob', 'search_file_content']);
const WRITE_TOOLS = new Set(['write_file', 'replace', 'apply_patch']);
const MAX_TOOL_SUMMARY_CHARS = 240;

function repoPath(cwd: string, input: unknown): string | undefined {
  if (typeof input !== 'string' || input.length === 0) return undefined;
  const absolute = resolve(cwd, input);
  const path = relative(cwd, absolute);
  return (path.startsWith('..') ? absolute : path || '.').split(sep).join('/');
}

export function geminiToolPaths(
  input: Pick<GeminiHookInput, 'cwd' | 'tool_name' | 'tool_input'>,
): string[] {
  const toolInput = input.tool_input ?? {};
  const candidates: unknown[] = [
    toolInput.file_path,
    toolInput.path,
    toolInput.dir_path,
    toolInput.target_file,
  ];
  if (Array.isArray(toolInput.paths)) candidates.push(...toolInput.paths);
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

export class GeminiCliAdapter implements AgentAdapter {
  readonly host = 'gemini-cli';
  readonly mode = 'hooks' as const;
  private readonly startedSessions = new Set<string>();
  private readonly promptedSessions = new Set<string>();

  async normalize(raw: unknown, ctx: AdapterContext): Promise<NewEvent[]> {
    const input = GeminiHookInputSchema.parse(raw);
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
      case 'BeforeAgent': {
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
        return seen
          ? [
              {
                ...base(),
                payload: { type: 'TOOL_CALL', tool: 'HumanPrompt', phase: 'post', ok: true },
              },
            ]
          : [];
      }
      case 'AfterTool': {
        const tool = input.tool_name ?? 'unknown';
        const paths = geminiToolPaths(input);
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
        if (tool === 'run_shell_command') {
          const command = input.tool_input?.command;
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
      case 'BeforeTool':
      case 'AfterAgent':
        return [];
    }
  }
}
