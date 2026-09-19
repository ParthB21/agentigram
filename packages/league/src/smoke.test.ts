import { NotImplementedError } from '@clankergram/protocol';
import { describe, expect, it } from 'vitest';
import { createMarket } from './index.js';

describe('@clankergram/league (stub)', () => {
  it('throws NotImplementedError until Part 4 lands', () => {
    expect(() =>
      createMarket({
        marketId: 'm',
        kind: 'binary',
        question: 'q',
        outcomes: ['yes', 'no'],
        closesAt: 'x',
      }),
    ).toThrow(NotImplementedError);
  });
});
