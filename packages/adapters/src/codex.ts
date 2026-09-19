import type { NewEvent } from '@agentigram/protocol';
import { z } from 'zod';
import type { AdapterContext, AgentAdapter } from './registry.js';

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
