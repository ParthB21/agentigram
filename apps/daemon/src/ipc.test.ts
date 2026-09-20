import { describe, expect, it } from 'vitest';
import { IpcRequestSchema } from './ipc.js';

describe('IPC hook validation', () => {
  it('accepts native Gemini CLI hook payloads', () => {
    expect(
      IpcRequestSchema.parse({
        type: 'hook',
        event: 'BeforeTool',
        input: {
          session_id: 'gemini-session',
          transcript_path: '/tmp/gemini-session.json',
          cwd: '/repo',
          hook_event_name: 'BeforeTool',
          timestamp: '2026-09-19T12:00:00.000Z',
          tool_name: 'write_file',
          tool_input: { file_path: '/repo/src/index.ts' },
        },
      }),
    ).toMatchObject({ type: 'hook', event: 'BeforeTool' });
  });

  it('validates transactional runner requests', () => {
    expect(
      IpcRequestSchema.parse({
        type: 'runner_complete',
        sessionId: 'frontend',
        claimId: 'claim-1',
        outcome: 'acted',
        reply: { to: 'backend', text: 'Updated the caller.' },
      }),
    ).toMatchObject({ type: 'runner_complete', outcome: 'acted' });
    expect(
      IpcRequestSchema.safeParse({
        type: 'runner_complete',
        sessionId: 'frontend',
        claimId: 'claim-1',
        outcome: 'acted',
      }).success,
    ).toBe(false);
    expect(
      IpcRequestSchema.safeParse({
        type: 'runner_complete',
        sessionId: 'frontend',
        claimId: 'claim-1',
        outcome: 'no_action',
        reply: { to: 'backend', text: 'unexpected' },
      }).success,
    ).toBe(false);
  });
});
