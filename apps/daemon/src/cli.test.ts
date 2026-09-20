import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { buildProgram, detectHost, resolveRepositoryRoot } from './cli.js';
import { summarise } from './summary.js';

describe('agentigram CLI', () => {
  it('--help lists the commands', () => {
    const help = buildProgram().helpInformation();
    for (const cmd of [
      'create',
      'setup',
      'demo',
      'dev-connect',
      'join',
      'leave',
      'daemon',
      'hook',
      'mcp',
      'status',
      'tui',
      'ui',
    ]) {
      expect(help).toContain(cmd);
    }
  });

  it('dev-connect exposes url/room/session options', () => {
    const cmd = buildProgram().commands.find((c) => c.name() === 'dev-connect');
    expect(cmd?.options.map((o) => o.long)).toEqual(
      expect.arrayContaining(['--url', '--room', '--session', '--token', '--from-start']),
    );
  });

  it('join exposes peer session and host options', () => {
    const command = buildProgram().commands.find((candidate) => candidate.name() === 'join');
    expect(command?.options.map((option) => option.long)).toEqual(
      expect.arrayContaining(['--root', '--session', '--host', '--engineer']),
    );
  });

  it('resolves repository roots from the original invocation directory', () => {
    const program = buildProgram('/tmp/agentigram-worktree');
    const create = program.commands.find((candidate) => candidate.name() === 'create');
    const ui = program.commands.find((candidate) => candidate.name() === 'ui');
    const expected = resolve('/tmp/agentigram-worktree');

    expect(create?.getOptionValue('root')).toBe(expected);
    expect(ui?.getOptionValue('root')).toBe(expected);
    expect(resolveRepositoryRoot('.', '/tmp/agentigram-worktree')).toBe(expected);
  });

  it('accepts concise positional session names and exposes start as a TUI alias', () => {
    const create = buildProgram().commands.find((candidate) => candidate.name() === 'create');
    const join = buildProgram().commands.find((candidate) => candidate.name() === 'join');
    const tui = buildProgram().commands.find((candidate) => candidate.name() === 'tui');

    expect(create?.registeredArguments.map((argument) => argument.name())).toEqual(['session']);
    expect(join?.registeredArguments.map((argument) => argument.name())).toEqual([
      'invite',
      'session',
    ]);
    expect(tui?.aliases()).toContain('start');
  });

  it('does not guess a host outside a positively identified agent environment', () => {
    expect(detectHost({})).toBeUndefined();
    expect(detectHost({ CODEX_THREAD_ID: 'thread' })).toBe('codex');
    expect(detectHost({ CLAUDECODE: '1' })).toBe('claude');
    expect(detectHost({ GEMINI_CLI: '1' })).toBe('gemini');
    expect(detectHost({ AGENTIGRAM_HOST: 'antigravity' })).toBe('antigravity');
  });

  it('summarises events on one line', () => {
    const line = summarise({
      id: 'e',
      seq: 7,
      roomId: 'r',
      ts: 'x',
      actor: { engineerId: 'e', sessionId: 'backend', kind: 'agent' },
      source: 'hook',
      payload: { type: 'FILE_WRITE', path: 'a.ts', worktree: 'w' },
    });
    expect(line).toBe('#7 backend FILE_WRITE a.ts');
  });

  it('uses clear room lifecycle language', () => {
    const base = {
      id: 'lifecycle',
      roomId: 'r',
      ts: '2026-09-20T00:00:00.000Z',
      actor: { engineerId: 'eng', sessionId: 'frontend', kind: 'agent' as const },
      source: 'hook' as const,
    };
    expect(
      summarise({
        ...base,
        seq: 8,
        payload: {
          type: 'SESSION_STARTED',
          sessionId: 'frontend',
          host: 'codex',
          model: 'unknown',
          branch: 'main',
        },
      }),
    ).toBe('#8 frontend joined the room');
    expect(
      summarise({
        ...base,
        seq: 9,
        payload: { type: 'SESSION_ENDED', sessionId: 'frontend', reason: 'daemon_stopped' },
      }),
    ).toBe('#9 frontend left the room');
  });
});
