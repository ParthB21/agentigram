import { type Contract, NotImplementedError } from '@clankergram/protocol';

export type CheckFile = { path: string; content: string };
export type CompiledContract = { contractId: string; checkFiles: CheckFile[] };

/** Everything `verifyRun` needs; assembled by the coordinator from hooks, GitHub and the ledger. */
export type RunEvidence = {
  runId: string;
  sessionId: string;
  declaredComplete: boolean;
  commitsWithTrailer: number;
  requiredCiGreen: boolean;
  contractsPass: boolean;
  humanTakeover: boolean;
};
export type RunVerdict = { verified: boolean; reasons: string[] };

export function compile(_contract: Contract): CompiledContract {
  throw new NotImplementedError('contracts.compile (Part 3)');
}

/** Pure: the reducer calls this to decide whether to emit RUN_VERIFIED. */
export function verifyRun(_evidence: RunEvidence): RunVerdict {
  throw new NotImplementedError('contracts.verifyRun (Part 3)');
}
