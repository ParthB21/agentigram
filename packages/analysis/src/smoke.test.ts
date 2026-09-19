import { NotImplementedError } from '@clankergram/protocol';
import { describe, expect, it } from 'vitest';
import { assessImpact, indexRepo } from './index.js';

describe('@clankergram/analysis (stub)', () => {
  it('exposes the agreed API and throws NotImplementedError until Part 3 lands', () => {
    expect(() => indexRepo('.')).toThrow(NotImplementedError);
    expect(() =>
      assessImpact(
        { writerSession: 'a', changes: [] },
        { root: '.', symbols: {}, imports: {} },
        { symbols: {} },
      ),
    ).toThrow(NotImplementedError);
  });
});
