import { describe, expect, it } from 'vitest';
import { claudeAdapter, codexAdapter, createAdapter } from './hosts.js';

describe('managed host adapters', () => {
  it('refuses to construct unattended adapters without explicit autonomy', () => {
    expect(() => createAdapter('codex')).toThrow(/explicit autonomous mode/);
    expect(() => createAdapter('claude-code')).toThrow(/explicit autonomous mode/);
  });

  it('starts and resumes Codex through stdin with its documented JSON stream', () => {
    const adapter = codexAdapter({ autonomous: true, command: 'fake-codex' });
    const start = adapter.start('initial prompt');
    expect(start.invocation).toEqual({
      command: 'fake-codex',
      args: ['exec', '--json', '--sandbox', 'workspace-write', '--approve-for-me', '-'],
      stdin: 'initial prompt',
    });
    expect(adapter.parseLine('{"type":"thread.started","thread_id":"thread-1"}')).toEqual({
      sessionId: 'thread-1',
    });
    expect(
      adapter.parseLine(
        '{"type":"item.completed","item":{"type":"agent_message","text":"done"}}',
      ),
    ).toEqual({ finalText: 'done' });
    expect(adapter.resume('thread-1', 'wake').args).toEqual([
      'exec',
      '--json',
      '--sandbox',
      'workspace-write',
      '--approve-for-me',
      'resume',
      'thread-1',
      '-',
    ]);
  });

  it('assigns and resumes a Claude session without putting prompts in arguments', () => {
    const adapter = claudeAdapter({ autonomous: true, command: 'fake-claude' });
    const start = adapter.start('initial prompt');
    expect(start.sessionId).toMatch(/^[0-9a-f-]{36}$/);
    expect(start.invocation.stdin).toBe('initial prompt');
    expect(start.invocation.args).toEqual(
      expect.arrayContaining(['--permission-mode', 'auto']),
    );
    expect(start.invocation.args).not.toContain('initial prompt');
    const resume = adapter.resume(start.sessionId!, 'wake');
    expect(resume.args).toContain('--resume');
    expect(resume.args).toContain(start.sessionId);
    expect(resume.stdin).toBe('wake');
  });
});
