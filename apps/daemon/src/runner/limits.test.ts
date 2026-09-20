import { describe, expect, it } from 'vitest';
import { Backoff, WakeLimiter } from './limits.js';

describe('managed runner limits', () => {
  it('enforces a sliding wake window and can refund a host that never started', () => {
    let now = 1_000;
    const limiter = new WakeLimiter(2, 100, () => now);
    expect(limiter.tryAcquire()).toEqual({ ok: true });
    expect(limiter.tryAcquire()).toEqual({ ok: true });
    expect(limiter.tryAcquire()).toEqual({ ok: false, retryAfterMs: 100 });
    limiter.refund();
    expect(limiter.tryAcquire()).toEqual({ ok: true });
    now += 101;
    expect(limiter.tryAcquire()).toEqual({ ok: true });
  });

  it('backs off exponentially and resets after a started turn', () => {
    const backoff = new Backoff(10, 25);
    expect([backoff.next(), backoff.next(), backoff.next()]).toEqual([10, 20, 25]);
    backoff.reset();
    expect(backoff.next()).toBe(10);
  });
});
