import { describe, expect, it } from 'vitest';
import { Supervisor, type SupervisorState } from './supervisor.js';

const noSleep = { sleep: () => Promise.resolve() };

describe('Supervisor (ported from OpenAgents daemon loop)', () => {
  it('does not restart a clean exit', async () => {
    const r = await new Supervisor('a', async () => 0, noSleep).start();
    expect(r).toEqual({ state: 'stopped', restarts: 0, reason: 'clean-exit' });
  });

  it('restarts after a crash with doubling backoff capped at the max', async () => {
    const delays: number[] = [];
    let runs = 0;
    const sup = new Supervisor('a', async () => (++runs < 6 ? 1 : 0), {
      sleep: async (ms) => void delays.push(ms),
      initialBackoffMs: 2000,
      maxBackoffMs: 10_000,
    });
    const r = await sup.start();
    expect(delays).toEqual([2000, 4000, 8000, 10_000, 10_000]);
    expect(r).toMatchObject({ reason: 'clean-exit', restarts: 5 });
  });

  it('treats a rejected run as a crash and gives up after maxRestarts', async () => {
    const states: SupervisorState[] = [];
    const r = await new Supervisor(
      'a',
      async () => {
        throw new Error('boom');
      },
      { ...noSleep, maxRestarts: 3, onState: (s) => states.push(s) },
    ).start();
    expect(r).toMatchObject({ reason: 'gave-up', restarts: 3, lastError: 'boom' });
    expect(states.at(-1)).toBe('stopped');
    expect(states).toContain('error');
  });

  it('a stop request wins over restarting, and cuts a backoff sleep short', async () => {
    let runs = 0;
    const sup = new Supervisor(
      'a',
      async () => {
        runs++;
        return 1;
      },
      { initialBackoffMs: 60_000 },
    );
    const done = sup.start();
    await new Promise((r) => setTimeout(r, 20));
    sup.stop();
    const r = await done;
    expect(r.reason).toBe('stop-requested');
    expect(runs).toBe(1);
  });

  it('resets the crash counter once a run stays healthy long enough', async () => {
    let t = 0;
    let runs = 0;
    const r = await new Supervisor(
      'a',
      async () => {
        runs++;
        t += runs % 2 === 0 ? 100_000 : 1; // every other run is long-lived
        if (runs > 20) return 0;
        return 1;
      },
      { ...noSleep, now: () => t, maxRestarts: 3, healthyAfterMs: 60_000 },
    ).start();
    expect(r.reason).toBe('clean-exit'); // without the reset it would have given up at 3
  });
});
