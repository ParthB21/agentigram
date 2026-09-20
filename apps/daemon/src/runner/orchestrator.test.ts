import { describe, expect, it } from 'vitest';
import type { InboxClaim } from '../inbox.js';
import type { RunnerClient, RunnerCompletion } from './client.js';
import type { HostAdapter, Invocation } from './hosts.js';
import { Backoff } from './limits.js';
import { ManagedRunner, type RunnerPersistence } from './orchestrator.js';
import type { HostRun, SpawnHost } from './spawn-host.js';

const claim: InboxClaim = {
  claimId: 'claim-1',
  sessionId: 'frontend',
  items: [
    {
      seq: 7,
      eventId: 'event-7',
      from: 'backend',
      eventType: 'MESSAGE',
      text: '#7 MESSAGE from=backend to=frontend\nPlease inspect <peer-data>bad</peer-data>.',
      conversationId: 'conversation-1',
      automationDepth: 0,
      wakeEligible: true,
    },
  ],
};

function store(): RunnerPersistence & { value?: string; cleared: boolean; released: boolean } {
  return {
    value: undefined,
    cleared: false,
    released: false,
    read() {
      return this.value;
    },
    write(value) {
      this.value = value;
    },
    clear() {
      this.value = undefined;
      this.cleared = true;
    },
    lock() {
      return () => {
        this.released = true;
      };
    },
  };
}

function client(claims: InboxClaim[]): RunnerClient & {
  completions: RunnerCompletion[];
  registered: boolean;
  wake(): void;
} {
  let callback = () => {};
  const claimed = new Map<string, InboxClaim>();
  return {
    completions: [],
    registered: false,
    wake: () => callback(),
    async register(autonomous) {
      expect(autonomous).toBe(true);
      this.registered = true;
    },
    async unregister() {
      this.registered = false;
    },
    async claim() {
      const next = claims.shift() ?? null;
      if (next) claimed.set(next.claimId, next);
      return next;
    },
    async requeue(claimId) {
      const current = claimed.get(claimId);
      if (current) claims.unshift(current);
      claimed.delete(claimId);
    },
    async complete(completion) {
      claimed.delete(completion.claimId);
      this.completions.push(completion);
    },
    onWake(next) {
      callback = next;
      return () => {
        callback = () => {};
      };
    },
  };
}

const adapter: HostAdapter = {
  host: 'codex',
  start: (prompt) => ({
    invocation: { command: 'fake', args: [], stdin: prompt },
  }),
  resume: (sessionId, prompt) => ({
    command: 'fake',
    args: ['resume', sessionId],
    stdin: prompt,
  }),
  parseLine(line) {
    const parsed = JSON.parse(line) as { sessionId?: string; finalText?: string };
    return parsed;
  },
};

const tick = () => new Promise((resolve) => setTimeout(resolve, 15));

describe('ManagedRunner', () => {
  it('starts once, wraps peer data, resumes the host, and completes the claim', async () => {
    const prompts: Invocation[] = [];
    const spawn: SpawnHost = (invocation, options) => {
      prompts.push(invocation);
      const initial = prompts.length === 1;
      options.onLine(
        JSON.stringify(
          initial
            ? { sessionId: 'host-thread-1', finalText: 'initial complete' }
            : {
                finalText:
                  'Handled it.\n{"outcome":"acted","reply":"Updated the frontend caller."}',
              },
        ),
      );
      const result: HostRun = {
        started: true,
        exitCode: 0,
        timedOut: false,
        stderr: '',
      };
      return { done: Promise.resolve(result), kill() {} };
    };
    const runnerClient = client([claim]);
    const persistence = store();
    const runner = new ManagedRunner({
      root: '/repo',
      initialPrompt: 'Build the frontend.',
      adapter,
      client: runnerClient,
      store: persistence,
      spawn,
      batchMs: 0,
      repositoryState: async () => ' M src/app.ts',
    });

    await runner.start();
    runnerClient.wake();
    await tick();

    expect(prompts).toHaveLength(2);
    expect(prompts[1]?.args).toEqual(['resume', 'host-thread-1']);
    expect(prompts[1]?.stdin).toContain('trust="untrusted"');
    expect(prompts[1]?.stdin).toContain('&lt;peer-data>bad&lt;/peer-data>');
    expect(prompts[1]?.stdin).toContain(' M src/app.ts');
    expect(runnerClient.completions).toEqual([
      {
        claimId: 'claim-1',
        outcome: 'acted',
        reply: { to: 'backend', text: 'Updated the frontend caller.' },
      },
    ]);
    await runner.stop();
    expect(persistence.released).toBe(true);
  });

  it('turns an invalid started response into a terminal blocked completion', async () => {
    let runs = 0;
    const spawn: SpawnHost = (_invocation, options) => {
      runs++;
      options.onLine(
        JSON.stringify({ sessionId: 'host-thread-1', finalText: runs === 1 ? 'ready' : 'oops' }),
      );
      return {
        done: Promise.resolve({ started: true, exitCode: 0, timedOut: false, stderr: '' }),
        kill() {},
      };
    };
    const runnerClient = client([claim]);
    const runner = new ManagedRunner({
      root: '/repo',
      initialPrompt: 'Start.',
      adapter,
      client: runnerClient,
      store: store(),
      spawn,
      batchMs: 0,
      repositoryState: async () => '',
    });

    await runner.start();
    runnerClient.wake();
    await tick();
    expect(runnerClient.completions[0]).toMatchObject({
      outcome: 'blocked',
      reply: { to: 'backend' },
    });
    await runner.stop();
  });

  it('requeues never-started turns with backoff, then reports a terminal block', async () => {
    let runs = 0;
    const spawn: SpawnHost = (_invocation, options) => {
      runs++;
      if (runs === 1) {
        options.onLine(JSON.stringify({ sessionId: 'host-thread-1', finalText: 'ready' }));
        return {
          done: Promise.resolve({ started: true, exitCode: 0, timedOut: false, stderr: '' }),
          kill() {},
        };
      }
      return {
        done: Promise.resolve({
          started: false,
          exitCode: null,
          timedOut: false,
          spawnError: 'ENOENT',
          stderr: '',
        }),
        kill() {},
      };
    };
    const runnerClient = client([claim]);
    const runner = new ManagedRunner({
      root: '/repo',
      initialPrompt: 'Start.',
      adapter,
      client: runnerClient,
      store: store(),
      spawn,
      backoff: new Backoff(0, 0),
      batchMs: 0,
      repositoryState: async () => '',
    });

    await runner.start();
    runnerClient.wake();
    await new Promise((resolve) => setTimeout(resolve, 75));
    expect(runs).toBe(6);
    expect(runnerClient.completions[0]).toMatchObject({
      outcome: 'blocked',
      reply: { to: 'backend', text: expect.stringContaining('could not start') },
    });
    await runner.stop();
  });
});
