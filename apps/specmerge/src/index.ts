import { NotImplementedError, type Payload } from '@clankergram/protocol';

export type SpecMergeRequest = {
  baseCommit: string;
  sessions: string[];
  diffs: Record<string, string>;
};

/** Part 3. Shadow worktree: apply live diffs on `main`, run `tsc --noEmit` and affected tests. */
export function runSpeculativeMerge(
  _request: SpecMergeRequest,
): Promise<Extract<Payload, { type: 'SPEC_MERGE_RESULT' }>> {
  throw new NotImplementedError('specmerge.runSpeculativeMerge (Part 3)');
}
