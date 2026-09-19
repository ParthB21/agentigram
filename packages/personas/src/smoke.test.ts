import { NotImplementedError } from '@clankergram/protocol';
import { describe, expect, it } from 'vitest';
import { render } from './index.js';

describe('@clankergram/personas (stub)', () => {
  it('throws NotImplementedError until Part 4 lands', () => {
    expect(() => render([], [])).toThrow(NotImplementedError);
  });
});
