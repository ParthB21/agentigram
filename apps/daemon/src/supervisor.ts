/**
 * Process supervisor: restart with exponential backoff, give up after too many crashes.
 * Ported from OpenAgents `daemon.js` (agent subprocess loop): backoff starts at 2 s, doubles to a
 * 60 s cap, gives up after 10 restarts, never restarts a clean exit or a requested stop.
 *
 * One deliberate change: the crash counter resets after a run stays up for `healthyAfterMs`,
 * so ten crashes spread over days do not permanently kill the daemon.
 */

export type SupervisorState = 'starting' | 'running' | 'error' | 'stopped';

export type SupervisorOptions = {
  maxRestarts?: number;
  initialBackoffMs?: number;
  maxBackoffMs?: number;
  healthyAfterMs?: number;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  log?: (line: string) => void;
  onState?: (state: SupervisorState) => void;
};

export type SupervisorResult = {
  state: 'stopped';
  restarts: number;
  reason: 'clean-exit' | 'stop-requested' | 'gave-up';
  lastError?: string;
};

export class Supervisor {
  private stopRequested = false;
  private wake: (() => void) | undefined;

  /**
   * @param run starts the supervised work and resolves with its exit code (0 = clean).
   *            Rejecting counts as a crash.
   */
  constructor(
    readonly name: string,
    private readonly run: () => Promise<number>,
    private readonly options: SupervisorOptions = {},
  ) {}

  /** Requests a stop; a pending backoff sleep is cut short. */
  stop(): void {
    this.stopRequested = true;
    this.wake?.();
  }

  async start(): Promise<SupervisorResult> {
    const {
      maxRestarts = 10,
      initialBackoffMs = 2000,
      maxBackoffMs = 60_000,
      healthyAfterMs = 60_000,
      now = Date.now,
      log = () => {},
      onState = () => {},
    } = this.options;
    const sleep = this.options.sleep ?? ((ms: number) => this.interruptibleSleep(ms));

    let restarts = 0;
    let backoff = initialBackoffMs;
    let lastError: string | undefined;

    while (!this.stopRequested) {
      onState('starting');
      const startedAt = now();
      try {
        onState('running');
        const code = await this.run();
        if (this.stopRequested) break;
        if (code === 0) {
          log(`${this.name} exited cleanly`);
          onState('stopped');
          return { state: 'stopped', restarts, reason: 'clean-exit' };
        }
        throw new Error(`exited with code ${code}`);
      } catch (err) {
        if (this.stopRequested) break;
        if (now() - startedAt >= healthyAfterMs) {
          restarts = 0;
          backoff = initialBackoffMs;
        }
        restarts++;
        lastError = (err instanceof Error ? err.message : String(err)).slice(0, 200);
        onState('error');
        if (restarts >= maxRestarts) {
          log(`${this.name} crashed ${restarts} times, giving up: ${lastError}`);
          onState('stopped');
          return { state: 'stopped', restarts, reason: 'gave-up', lastError };
        }
        log(`${this.name} crashed: ${lastError}; restarting in ${backoff}ms (attempt ${restarts})`);
        await sleep(backoff);
        backoff = Math.min(backoff * 2, maxBackoffMs);
      }
    }
    onState('stopped');
    return {
      state: 'stopped',
      restarts,
      reason: 'stop-requested',
      ...(lastError ? { lastError } : {}),
    };
  }

  private interruptibleSleep(ms: number): Promise<void> {
    return new Promise((resolve) => {
      const timer = setTimeout(done, ms);
      function done() {
        clearTimeout(timer);
        resolve();
      }
      this.wake = done;
    });
  }
}
