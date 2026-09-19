import { NotImplementedError } from '@clankergram/protocol';
import { describe, expect, it } from 'vitest';
import { betaPosterior } from './index.js';

describe('@clankergram/stats (stub)', () => {
  it('throws NotImplementedError until Part 4 lands', () => {
    expect(() => betaPosterior(1, 1)).toThrow(NotImplementedError);
  });
});
