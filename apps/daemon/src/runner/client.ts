import { createConnection } from 'node:net';
import type { InboxClaim } from '../inbox.js';
import { type IpcRequest, requestIpc } from '../ipc.js';

const REQUEST_TIMEOUT_MS = 5_000;
const RECONNECT_MS = 1_000;

export type RunnerCompletion = {
  claimId: string;
  outcome: 'acted' | 'no_action' | 'blocked';
  reply?: { to: string; text: string };
};

/** The runner's view of its daemon. An interface so the orchestrator can be tested without sockets. */
export type RunnerClient = {
  register(autonomous: boolean): Promise<void>;
  unregister(): Promise<void>;
  claim(): Promise<InboxClaim | null>;
  requeue(claimId: string): Promise<void>;
  complete(completion: RunnerCompletion): Promise<void>;
  /** Calls back on every wake frame, and once on each (re)connect to drain anything missed. */
  onWake(callback: () => void): () => void;
};

export class IpcRunnerClient implements RunnerClient {
  constructor(
    private readonly socketPath: string,
    private readonly sessionId: string,
  ) {}

  private async call(request: IpcRequest): Promise<unknown> {
    const response = await requestIpc(this.socketPath, request, REQUEST_TIMEOUT_MS);
    if (!response.ok) throw new Error(response.error);
    return response.output;
  }

  async register(autonomous: boolean): Promise<void> {
    await this.call({ type: 'runner_register', sessionId: this.sessionId, autonomous });
  }

  async unregister(): Promise<void> {
    await this.call({ type: 'runner_unregister', sessionId: this.sessionId });
  }

  async claim(): Promise<InboxClaim | null> {
    return ((await this.call({ type: 'runner_claim', sessionId: this.sessionId })) ??
      null) as InboxClaim | null;
  }

  async requeue(claimId: string): Promise<void> {
    await this.call({ type: 'runner_requeue', sessionId: this.sessionId, claimId });
  }

  async complete(completion: RunnerCompletion): Promise<void> {
    await this.call({ type: 'runner_complete', sessionId: this.sessionId, ...completion });
  }

  onWake(callback: () => void): () => void {
    let stopped = false;
    let socket: ReturnType<typeof createConnection> | undefined;
    let timer: NodeJS.Timeout | undefined;

    const connect = () => {
      if (stopped) return;
      let buffer = '';
      const current = createConnection(this.socketPath);
      socket = current;
      current.setEncoding('utf8');
      current.once('connect', () => {
        current.write(`${JSON.stringify({ type: 'subscribe' })}\n`);
        callback();
      });
      current.on('data', (chunk: string) => {
        buffer += chunk;
        let newline = buffer.indexOf('\n');
        while (newline >= 0) {
          const line = buffer.slice(0, newline);
          buffer = buffer.slice(newline + 1);
          try {
            const frame = JSON.parse(line) as { t?: string; sessionId?: string };
            if (frame.t === 'wake' && frame.sessionId === this.sessionId) callback();
          } catch {
            // Not a frame we understand.
          }
          newline = buffer.indexOf('\n');
        }
      });
      const retry = () => {
        if (stopped || timer) return;
        timer = setTimeout(() => {
          timer = undefined;
          connect();
        }, RECONNECT_MS);
      };
      current.on('error', retry);
      current.on('close', retry);
    };
    connect();

    return () => {
      stopped = true;
      clearTimeout(timer);
      socket?.destroy();
    };
  }
}
