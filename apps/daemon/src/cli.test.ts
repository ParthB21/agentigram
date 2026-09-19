import { NotImplementedError } from '@clankergram/protocol';
import { describe, expect, it } from 'vitest';
import { buildProgram } from './cli.js';
import { summarise } from './summary.js';

describe('clankergram CLI', () => {
  it('--help lists the commands', () => {
    const help = buildProgram().helpInformation();
    for (const cmd of ['dev-connect', 'join', 'mcp']) expect(help).toContain(cmd);
  });

  it('dev-connect exposes url/room/session options', () => {
    const cmd = buildProgram().commands.find((c) => c.name() === 'dev-connect');
    expect(cmd?.options.map((o) => o.long)).toEqual(
      expect.arrayContaining(['--url', '--room', '--session', '--token', '--from-start']),
    );
  });

  it('join and mcp are Part 2 stubs that fail loudly rather than pretend to work', async () => {
    const program = buildProgram().exitOverride();
    await expect(program.parseAsync(['node', 'clankergram', 'mcp'])).rejects.toThrow(
      NotImplementedError,
    );
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
});
