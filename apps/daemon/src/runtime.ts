import { createHash } from 'node:crypto';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';

export const runtimeKey = (root: string): string =>
  createHash('sha256').update(resolve(root)).digest('hex').slice(0, 16);

/** IPC endpoint: a Unix socket under the runtime dir, or a named pipe on Windows (Node cannot listen on a `.sock` path there). */
export const isPipe = (path: string): boolean => path.startsWith('\\\\.\\pipe\\');

export function runtimePaths(root: string, base = join(homedir(), '.clankergram')) {
  const key = runtimeKey(root);
  return {
    base,
    state: join(base, 'installations', `${key}.json`),
    socket:
      process.platform === 'win32' ? `\\\\.\\pipe\\clankergram-${key}` : join(base, `${key}.sock`),
  };
}
