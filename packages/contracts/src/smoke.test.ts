import { describe, expect, it } from 'vitest';
import { compile, verifyRun } from './index.js';

describe('@clankergram/contracts', () => {
  it('compiles deterministic TypeScript checks', () => {
    const contract = {
      symbol: 'src/types/user.ts#User.id',
      kind: 'type' as const,
      before: 'number',
      after: 'string',
    };
    expect(compile(contract)).toEqual(compile(contract));
    expect(compile(contract).checkFiles[0]?.content).toContain("Imported['id'], string");
  });

  it('requires every verified-success fact', () => {
    expect(
      verifyRun({
        runId: 'r',
        sessionId: 's',
        declaredComplete: true,
        commitsWithTrailer: 1,
        requiredCiGreen: true,
        contractsPass: true,
        humanTakeover: false,
      }).verified,
    ).toBe(true);
    expect(
      verifyRun({
        runId: 'r',
        sessionId: 's',
        declaredComplete: false,
        commitsWithTrailer: 0,
        requiredCiGreen: false,
        contractsPass: false,
        humanTakeover: true,
      }).reasons,
    ).toHaveLength(5);
  });
});
