import { describe, expect, it } from 'vitest';
import { runSpeculativeMerge } from './index.js';

describe('@clankergram/specmerge', () => {
  it('reports setup failures honestly without claiming checks ran', async () => {
    const result = await runSpeculativeMerge(
      { baseCommit: 'missing', sessions: [], diffs: {}, root: process.cwd() },
      {
        runner: async () => ({ exitCode: 1, stdout: '', stderr: 'bad revision', timedOut: false }),
      },
    );
    expect(result.typeErrors[0]).toMatchObject({ code: 'WORKTREE' });
    expect(result.notRun).toEqual(['typecheck', 'tests', 'contracts']);
  });

  it('decrypts and applies patches in deterministic lease order', async () => {
    const applied: string[] = [];
    const ok = { exitCode: 0, stdout: '', stderr: '', timedOut: false };
    const result = await runSpeculativeMerge(
      {
        baseCommit: 'base',
        sessions: [],
        diffs: [
          { sessionId: 'later', leaseSeq: 9, encryptedPatch: 'enc-b' },
          { sessionId: 'first', leaseSeq: 2, patch: 'patch-a' },
        ],
        root: process.cwd(),
      },
      {
        runner: async () => ok,
        patcher: async (patch) => {
          applied.push(patch);
          return ok;
        },
        decryptPatch: async (encrypted) => `decrypted-${encrypted}`,
      },
    );
    expect(applied).toEqual(['patch-a', 'decrypted-enc-b']);
    expect(result.sessions).toEqual(['first', 'later']);
    expect(result.notRun).toEqual([]);
  });
});
