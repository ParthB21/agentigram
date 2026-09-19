import { symbolKey } from '@agentigram/protocol';
import { describe, expect, it } from 'vitest';
import { ClaudeCodeAdapter } from './claude-code.js';

const context = {
  roomId: 'hackathon',
  engineerId: 'eng-1',
  sessionId: 'session-1',
  branch: 'feature/payments',
  worktree: '/repo',
  newId: () => crypto.randomUUID(),
};

const common = {
  session_id: 'session-1',
  transcript_path: '/tmp/session-1.jsonl',
  cwd: '/repo',
};

describe('ClaudeCodeAdapter', () => {
  it.each([
    ['session-start.json', 'SESSION_STARTED'],
    ['post-tool-use.json', 'FILE_READ'],
    ['pre-tool-use.json', undefined],
    ['stop.json', undefined],
    ['session-end.json', 'SESSION_ENDED'],
  ])('normalizes the secret-free %s golden fixture', async (fixture, expectedType) => {
    const raw = JSON.parse(
      readFileSync(new URL(`../test/fixtures/${fixture}`, import.meta.url), 'utf8'),
    ) as unknown;
    const events = await new ClaudeCodeAdapter().normalize(raw, {
      ...context,
      sessionId: 'session-fixture',
    });
    expect(events[0]?.payload.type).toBe(expectedType);
  });

  it('tracks the UserPromptSubmit golden fixture without uploading prompt text', async () => {
    const raw = JSON.parse(
      readFileSync(new URL('../test/fixtures/user-prompt-submit.json', import.meta.url), 'utf8'),
    ) as unknown;
    const adapter = new ClaudeCodeAdapter();
    const fixtureContext = { ...context, sessionId: 'session-fixture' };
    expect(await adapter.normalize(raw, fixtureContext)).toEqual([]);
    const intervention = await adapter.normalize(raw, fixtureContext);
    expect(intervention[0]?.payload).toMatchObject({ type: 'TOOL_CALL', tool: 'HumanPrompt' });
    expect(JSON.stringify(intervention)).not.toContain('Update the checkout flow');
  });

  it('maps real hook shapes to observed protocol events', async () => {
    const userId = symbolKey('src/types/user.ts', 'User', 'id', 'property');
    const adapter = new ClaudeCodeAdapter(async () => [userId]);
    const read = await adapter.normalize(
      {
        ...common,
        hook_event_name: 'PostToolUse',
        tool_name: 'Read',
        tool_input: { file_path: '/repo/src/types/user.ts' },
        tool_response: { type: 'text', file: { content: 'not uploaded' } },
      },
      context,
    );
    expect(read[0]?.payload).toEqual({
      type: 'FILE_READ',
      path: 'src/types/user.ts',
      symbols: [userId],
    });

    const write = await adapter.normalize(
      {
        ...common,
        hook_event_name: 'PostToolUse',
        tool_name: 'Edit',
        tool_input: { file_path: '/repo/src/checkout.ts', old_string: 'a', new_string: 'b' },
      },
      context,
    );
    expect(write[0]?.payload).toEqual({
      type: 'FILE_WRITE',
      path: 'src/checkout.ts',
      worktree: '/repo',
    });
  });

  it('counts only prompts after the initial task as human intervention', async () => {
    const adapter = new ClaudeCodeAdapter();
    const hook = { ...common, hook_event_name: 'UserPromptSubmit', prompt: 'continue' };
    expect(await adapter.normalize(hook, context)).toEqual([]);
    expect((await adapter.normalize(hook, context))[0]?.payload).toMatchObject({
      tool: 'HumanPrompt',
    });
  });

  it('redacts Bash command secrets', async () => {
    const adapter = new ClaudeCodeAdapter();
    const events = await adapter.normalize(
      {
        ...common,
        hook_event_name: 'PostToolUse',
        tool_name: 'Bash',
        tool_input: { command: 'curl -H "Authorization: Bearer secret-token" example.com' },
      },
      context,
    );
    expect(JSON.stringify(events)).not.toContain('secret-token');
  });
});

import { readFileSync } from 'node:fs';
