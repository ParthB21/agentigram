export const MAX_WAKES_PER_HOUR = 20;
const HOUR_MS = 60 * 60 * 1000;

/** Sliding-window cap on automatic wakes. */
export class WakeLimiter {
  private readonly stamps: number[] = [];

  constructor(
    private readonly max = MAX_WAKES_PER_HOUR,
    private readonly windowMs = HOUR_MS,
    private readonly now: () => number = Date.now,
  ) {}

  tryAcquire(): { ok: true } | { ok: false; retryAfterMs: number } {
    const cutoff = this.now() - this.windowMs;
    while (this.stamps.length > 0 && (this.stamps[0] as number) <= cutoff) this.stamps.shift();
    if (this.stamps.length < this.max) {
      this.stamps.push(this.now());
      return { ok: true };
    }
    return { ok: false, retryAfterMs: (this.stamps[0] as number) + this.windowMs - this.now() };
  }

  /** A wake that never started the host should not count against the hour. */
  refund(): void {
    this.stamps.pop();
  }
}

export const MAX_START_FAILURES = 5;

/** Exponential retry delay: 2s, 4s, … capped at 60s. */
export class Backoff {
  failures = 0;
  constructor(
    private readonly baseMs = 2_000,
    private readonly capMs = 60_000,
  ) {}

  next(): number {
    const delay = Math.min(this.capMs, this.baseMs * 2 ** this.failures);
    this.failures++;
    return delay;
  }

  reset(): void {
    this.failures = 0;
  }
}
