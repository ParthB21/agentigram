import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { MAX_MESSAGE_TEXT_LENGTH } from '@agentigram/protocol';
import type { InboxClaim } from '../inbox.js';
import type { RunnerClient } from './client.js';
import type { HostAdapter, Invocation } from './hosts.js';
import { Backoff, MAX_START_FAILURES, WakeLimiter } from './limits.js';
import { parseRunnerResult, wakePrompt } from './result.js';
import type { HostProcess, HostRun, SpawnHost } from './spawn-host.js';
import { TURN_TIMEOUT_MS } from './spawn-host.js';

const execFileAsync = promisify(execFile);
export const WAKE_BATCH_MS = 750;

export type RunnerPersistence = {
  read(): string | undefined;
  write(hostSessionId: string): void;
  clear(): void;
  lock(): () => void;
};

type TurnOutput = HostRun & { finalText?: string; hostError?: string };

export type ManagedRunnerOptions = {
  root: string;
  initialPrompt: string;
  newSession?: boolean;
  adapter: HostAdapter;
  client: RunnerClient;
  store: RunnerPersistence;
  spawn: SpawnHost;
  limiter?: WakeLimiter;
  backoff?: Backoff;
  batchMs?: number;
  timeoutMs?: number;
  repositoryState?: () => Promise<string>;
};

export class ManagedRunner {
  private readonly limiter: WakeLimiter;
  private readonly backoff: Backoff;
  private readonly batchMs: number;
  private readonly timeoutMs: number;
  private readonly repositoryState: () => Promise<string>;
  private stopWake?: () => void;
  private releaseLock?: () => void;
  private timer?: NodeJS.Timeout;
  private pendingDelay?: number;
  private current?: HostProcess;
  private drainPromise?: Promise<void>;
  private running = false;
  private stopped = false;
  private startFailures = 0;

  constructor(private readonly options: ManagedRunnerOptions) {
    this.limiter = options.limiter ?? new WakeLimiter();
    this.backoff = options.backoff ?? new Backoff();
    this.batchMs = options.batchMs ?? WAKE_BATCH_MS;
    this.timeoutMs = options.timeoutMs ?? TURN_TIMEOUT_MS;
    this.repositoryState = options.repositoryState ?? (() => gitStatus(options.root));
  }

  async start(): Promise<void> {
    this.releaseLock = this.options.store.lock();
    if (this.options.newSession) this.options.store.clear();
    try {
      await this.options.client.register(true);
      if (this.options.initialPrompt.trim()) await this.runInitialTurn(this.options.initialPrompt);
      this.stopWake = this.options.client.onWake(() => this.schedule(this.batchMs));
    } catch (error) {
      await this.stop();
      throw error;
    }
  }

  async stop(): Promise<void> {
    if (this.stopped) return;
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    this.stopWake?.();
    this.current?.kill();
    await this.drainPromise;
    try {
      await this.options.client.unregister();
    } catch {
      // The daemon may already be stopping. The process lock still must be released.
    }
    this.releaseLock?.();
  }

  private schedule(delay: number): void {
    if (this.stopped) return;
    if (this.running) {
      this.pendingDelay =
        this.pendingDelay === undefined ? delay : Math.min(this.pendingDelay, delay);
      return;
    }
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.timer = undefined;
      this.drainPromise = this.drain().finally(() => {
        this.drainPromise = undefined;
      });
    }, delay);
  }

  private async drain(): Promise<void> {
    if (this.running || this.stopped) return;
    this.running = true;
    try {
      while (!this.stopped) {
        const claim = await this.options.client.claim();
        if (!claim) break;
        const permitted = this.limiter.tryAcquire();
        if (!permitted.ok) {
          await this.options.client.requeue(claim.claimId);
          this.schedule(permitted.retryAfterMs);
          break;
        }
        const shouldContinue = await this.handleClaim(claim);
        if (!shouldContinue) break;
      }
    } finally {
      this.running = false;
      const pendingDelay = this.pendingDelay;
      this.pendingDelay = undefined;
      if (pendingDelay !== undefined) this.schedule(pendingDelay);
    }
  }

  private async runInitialTurn(prompt: string): Promise<void> {
    const output = await this.runTurn(prompt);
    if (!output.started || output.exitCode !== 0 || output.hostError || output.timedOut) {
      throw new Error(turnFailure(output, 'initial managed agent turn failed'));
    }
  }

  private async handleClaim(claim: InboxClaim): Promise<boolean> {
    const prompt = wakePrompt(claim.items, await this.repositoryState());
    const output = await this.runTurn(prompt);
    if (this.stopped) {
      await this.options.client.requeue(claim.claimId);
      return false;
    }
    if (!output.started) {
      this.limiter.refund();
      this.startFailures++;
      if (this.startFailures < MAX_START_FAILURES) {
        await this.options.client.requeue(claim.claimId);
        this.schedule(this.backoff.next());
        return false;
      }
      await this.completeBlocked(claim, turnFailure(output, 'agent host could not start'));
      return true;
    }

    this.startFailures = 0;
    this.backoff.reset();
    if (output.exitCode !== 0 || output.hostError || output.timedOut) {
      await this.completeBlocked(claim, turnFailure(output, 'managed agent turn failed'));
      return true;
    }
    const result = parseRunnerResult(output.finalText);
    if (!result) {
      await this.completeBlocked(claim, 'The coding agent returned an invalid completion result.');
      return true;
    }
    await this.options.client.complete({
      claimId: claim.claimId,
      outcome: result.outcome,
      ...(result.reply
        ? { reply: { to: claim.items[0]?.from ?? '', text: result.reply } }
        : {}),
    });
    return true;
  }

  private completeBlocked(claim: InboxClaim, text: string): Promise<void> {
    return this.options.client.complete({
      claimId: claim.claimId,
      outcome: 'blocked',
      reply: {
        to: claim.items[0]?.from ?? '',
        text: text.slice(0, MAX_MESSAGE_TEXT_LENGTH),
      },
    });
  }

  private async runTurn(prompt: string): Promise<TurnOutput> {
    let hostSessionId = this.options.store.read();
    let invocation: Invocation;
    if (hostSessionId) invocation = this.options.adapter.resume(hostSessionId, prompt);
    else {
      const started = this.options.adapter.start(prompt);
      invocation = started.invocation;
      hostSessionId = started.sessionId;
    }
    let finalText: string | undefined;
    let hostError: string | undefined;
    this.current = this.options.spawn(invocation, {
      cwd: this.options.root,
      timeoutMs: this.timeoutMs,
      onLine: (line) => {
        const parsed = this.options.adapter.parseLine(line);
        if (parsed.sessionId && parsed.sessionId !== hostSessionId) {
          hostSessionId = parsed.sessionId;
          this.options.store.write(parsed.sessionId);
        }
        if (parsed.finalText) finalText = parsed.finalText;
        if (parsed.error) hostError = parsed.error;
      },
    });
    const output = await this.current.done;
    this.current = undefined;
    if (output.started && hostSessionId) this.options.store.write(hostSessionId);
    return { ...output, ...(finalText ? { finalText } : {}), ...(hostError ? { hostError } : {}) };
  }
}

async function gitStatus(root: string): Promise<string> {
  try {
    const { stdout } = await execFileAsync('git', ['status', '--short'], {
      cwd: root,
      encoding: 'utf8',
    });
    return stdout.trim();
  } catch (error) {
    return `unavailable: ${error instanceof Error ? error.message : String(error)}`;
  }
}

function turnFailure(output: TurnOutput, fallback: string): string {
  if (output.timedOut) return 'The coding agent timed out before it could respond.';
  if (output.hostError) return output.hostError;
  if (output.spawnError) return `The coding agent could not start: ${output.spawnError}`;
  if (output.stderr.trim()) return output.stderr.trim().slice(-500);
  return `${fallback}${output.exitCode === null ? '' : ` (exit ${output.exitCode})`}.`;
}
