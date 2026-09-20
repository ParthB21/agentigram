import { createHash } from 'node:crypto';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';

export const runtimeKey = (root: string): string =>
  createHash('sha256').update(resolve(root)).digest('hex').slice(0, 16);

/** IPC endpoint: a Unix socket under the runtime dir, or a named pipe on Windows (Node cannot listen on a `.sock` path there). */
export const isPipe = (path: string): boolean => path.startsWith('\\\\.\\pipe\\');

export function runtimePaths(
  root: string,
  base = join(homedir(), '.agentigram'),
  roomId = 'hackathon',
) {
  const key = runtimeKey(root);
  return {
    base,
    state: join(base, 'installations', `${key}.json`),
    p2pStorage: join(base, 'p2p', key),
    /** Mirrors `CursorStore.forRoom`, so a teardown can clear what it wrote. */
    cursor: join(base, 'cursors', `${roomId.replace(/[^A-Za-z0-9_-]/g, '_')}.json`),
    socket:
      process.platform === 'win32' ? `\\\\.\\pipe\\agentigram-${key}` : join(base, `${key}.sock`),
  };
}
