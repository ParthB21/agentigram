import { NotImplementedError } from '@clankergram/protocol';
import { describe, expect, it } from 'vitest';
import { runSpeculativeMerge } from './index.js';

describe('@clankergram/specmerge (stub)', () => {
  it('throws NotImplementedError until Part 3 lands', () => {
    expect(() => runSpeculativeMerge({ baseCommit: 'a', sessions: [], diffs: {} })).toThrow(
      NotImplementedError,
    );
  });
});
