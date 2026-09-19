import { redactSecrets } from './redact.js';

/**
 * Consecutive heartbeat failures before an adapter reports an error. Ported from OpenAgents
 * `adapters/base.js` (HEARTBEAT_ERROR_THRESHOLD): one failure is usually a network blip that the
 * next tick recovers from, so surfacing it would make the agent flap red for no real reason.
 */
export const HEARTBEAT_ERROR_THRESHOLD = 2;

export type AdapterStatus = {
  /** null means healthy again (clears any prior error). */
  reason: 'heartbeat_failed' | 'auth_failed' | 'hook_error' | null;
  message: string;
};

export type StatusListener = (status: AdapterStatus) => void;

/** Tracks adapter connectivity and reports only state *changes* (never duplicates). */
export class HealthTracker {
  private failStreak = 0;
  private lastKey: string | null = null;

  constructor(
    private readonly onStatus: StatusListener,
    private readonly threshold = HEARTBEAT_ERROR_THRESHOLD,
  ) {}

  /** Record one heartbeat/hook outcome. Failure text is redacted before it leaves this class. */
  record(ok: boolean, message = '', reason: AdapterStatus['reason'] = 'heartbeat_failed'): void {
    if (ok) {
      this.failStreak = 0;
      this.report({ reason: null, message: '' });
      return;
    }
    this.failStreak++;
    if (this.failStreak >= this.threshold) {
      this.report({ reason, message: redactSecrets(message, { catchAll: true }).slice(0, 200) });
    }
  }

  private report(status: AdapterStatus): void {
    const key = `${status.reason}:${status.message}`;
    // A recovery report is only meaningful if an error was reported before.
    if (status.reason === null && this.lastKey === null) return;
    if (key === this.lastKey) return;
    this.lastKey = status.reason === null ? null : key;
    this.onStatus(status);
  }
}
