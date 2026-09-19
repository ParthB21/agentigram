import { NotImplementedError } from '@clankergram/protocol';
import { describe, expect, it } from 'vitest';
import { fetch } from './index.js';

describe('@clankergram/coordinator (stub)', () => {
  it('throws NotImplementedError until Part 1 lands', () => {
    expect(() => fetch(new Request('http://localhost/room/x'))).toThrow(NotImplementedError);
  });
});
