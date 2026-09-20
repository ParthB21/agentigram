import { spawn } from 'node:child_process';
import type { Invocation } from './hosts.js';

export const TURN_TIMEOUT_MS = 15 * 60 * 1000;
const STDERR_TAIL = 500;

export type HostRun = {
  /** True once the host printed its first line — it got as far as running. */
  started: boolean;
  exitCode: number | null;
  timedOut: boolean;
  spawnError?: string;
  stderr: string;
};

export type HostProcess = { done: Promise<HostRun>; kill(): void };
export type SpawnHost = (
  invocation: Invocation,
  options: { cwd: string; timeoutMs: number; onLine: (line: string) => void },
) => HostProcess;

/**
 * Run one host turn. No shell except on Windows, where `claude` and `codex`
 * are `.cmd` shims that only a shell can resolve; the arguments there are all
 * fixed flags and ids, and the prompt never leaves stdin.
 */
export const spawnHost: SpawnHost = (invocation, { cwd, timeoutMs, onLine }) => {
  let child: ReturnType<typeof spawn> | undefined;
  const done = new Promise<HostRun>((resolve) => {
    const run: HostRun = { started: false, exitCode: null, timedOut: false, stderr: '' };
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(run);
    };

    try {
      child = spawn(invocation.command, invocation.args, {
        cwd,
        shell: process.platform === 'win32',
        stdio: ['pipe', 'pipe', 'pipe'],
      });
    } catch (error) {
      run.spawnError = error instanceof Error ? error.message : String(error);
      resolve(run);
      return;
    }
    const active = child;
    const timer = setTimeout(() => {
      run.timedOut = true;
      active.kill('SIGKILL');
    }, timeoutMs);

    let buffer = '';
    active.stdout?.setEncoding('utf8');
    active.stdout?.on('data', (chunk: string) => {
      buffer += chunk;
      let newline = buffer.indexOf('\n');
      while (newline >= 0) {
        const line = buffer.slice(0, newline).trim();
        buffer = buffer.slice(newline + 1);
        if (line) {
          run.started = true;
          onLine(line);
        }
        newline = buffer.indexOf('\n');
      }
    });
    active.stderr?.setEncoding('utf8');
    active.stderr?.on('data', (chunk: string) => {
      run.stderr = (run.stderr + chunk).slice(-STDERR_TAIL);
    });
    active.stdin?.on('error', () => {
      // The host may exit before reading its prompt; the exit code says why.
    });
    active.stdin?.end(invocation.stdin);
    active.on('error', (error) => {
      run.spawnError = error.message;
      finish();
    });
    active.on('close', (code) => {
      const rest = buffer.trim();
      if (rest) {
        run.started = true;
        onLine(rest);
      }
      run.exitCode = code;
      finish();
    });
  });
  return { done, kill: () => child?.kill('SIGKILL') };
};
