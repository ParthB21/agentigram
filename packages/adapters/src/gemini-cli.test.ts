import { describe, expect, it } from 'vitest';
import { GeminiCliAdapter, geminiToolPaths } from './gemini-cli.js';

const context = {
  roomId: 'hackathon',
  engineerId: 'eng-3',
  sessionId: 'gemini-frontend',
  branch: 'feature/frontend',
  worktree: '/repo',
  newId: () => crypto.randomUUID(),
};

const common = {
  session_id: 'gemini-session',
  transcript_path: '/tmp/gemini-session.json',
  cwd: '/repo',
  timestamp: '2026-09-19T12:00:00.000Z',
};

describe('GeminiCliAdapter', () => {
  it('announces the Agentigram session on Gemini SessionStart', async () => {
    const events = await new GeminiCliAdapter().normalize(
      { ...common, hook_event_name: 'SessionStart', source: 'startup' },
      context,
    );
    expect(events[0]?.payload).toEqual({
      type: 'SESSION_STARTED',
      sessionId: 'gemini-frontend',
      host: 'gemini-cli',
      model: 'gemini',
      branch: 'feature/frontend',
    });
  });

  it('normalizes Gemini write and read tool paths', async () => {
    const adapter = new GeminiCliAdapter();
    const write = await adapter.normalize(
      {
        ...common,
        hook_event_name: 'AfterTool',
        tool_name: 'write_file',
        tool_input: { file_path: '/repo/apps/web/page.tsx', content: 'not uploaded' },
        tool_response: { llmContent: 'ok' },
      },
      context,
    );
    expect(write[0]?.payload).toEqual({
      type: 'FILE_WRITE',
      path: 'apps/web/page.tsx',
      worktree: '/repo',
    });

    const read = await adapter.normalize(
      {
        ...common,
        hook_event_name: 'AfterTool',
        tool_name: 'read_file',
        tool_input: { file_path: 'packages/protocol/src/index.ts' },
      },
      context,
    );
    expect(read[0]?.payload).toEqual({
      type: 'FILE_READ',
      path: 'packages/protocol/src/index.ts',
    });
  });

  it('extracts paths for pre-tool lease enforcement', () => {
    expect(
      geminiToolPaths({
        ...common,
        tool_name: 'replace',
        tool_input: { file_path: '/repo/src/payments.ts' },
      }),
    ).toEqual(['src/payments.ts']);
  });

  it('tracks later prompts without sending their contents', async () => {
    const adapter = new GeminiCliAdapter();
    const hook = { ...common, hook_event_name: 'BeforeAgent' as const, prompt: 'secret task' };
    expect((await adapter.normalize(hook, context))[0]?.payload).toMatchObject({
      type: 'SESSION_STARTED',
    });
    const events = await adapter.normalize(hook, context);
    expect(events[0]?.payload).toMatchObject({ type: 'TOOL_CALL', tool: 'HumanPrompt' });
    expect(JSON.stringify(events)).not.toContain('secret task');
  });

  it('redacts secrets from shell summaries', async () => {
    const events = await new GeminiCliAdapter().normalize(
      {
        ...common,
        hook_event_name: 'AfterTool',
        tool_name: 'run_shell_command',
        tool_input: { command: 'curl -H "Authorization: Bearer secret-token" example.com' },
      },
      context,
    );
    expect(JSON.stringify(events)).not.toContain('secret-token');
  });
});
