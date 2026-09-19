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
});
