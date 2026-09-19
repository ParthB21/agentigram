import { NotImplementedError } from '@clankergram/protocol';
import { describe, expect, it } from 'vitest';
import { compile, verifyRun } from './index.js';

describe('@clankergram/contracts (stub)', () => {
  it('throws NotImplementedError until Part 3 lands', () => {
    expect(() => compile({ symbol: 's', kind: 'type', before: 'a', after: 'b' })).toThrow(
      NotImplementedError,
    );
    expect(() =>
      verifyRun({
        runId: 'r',
        sessionId: 's',
        declaredComplete: true,
        commitsWithTrailer: 1,
        requiredCiGreen: true,
        contractsPass: true,
        humanTakeover: false,
      }),
    ).toThrow(NotImplementedError);
  });
});
