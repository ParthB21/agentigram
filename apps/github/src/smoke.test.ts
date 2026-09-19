import { NotImplementedError } from '@clankergram/protocol';
import { describe, expect, it } from 'vitest';
import { handleWebhook } from './index.js';

describe('@clankergram/github (stub)', () => {
  it('throws NotImplementedError until Part 3 lands', () => {
    expect(() => handleWebhook('push', {})).toThrow(NotImplementedError);
  });
});
