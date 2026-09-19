import { createHash } from 'node:crypto';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';

export const runtimeKey = (root: string): string =>
  createHash('sha256').update(resolve(root)).digest('hex').slice(0, 16);

export function runtimePaths(root: string, base = join(homedir(), '.clankergram')) {
  const key = runtimeKey(root);
  return {
    base,
    state: join(base, 'installations', `${key}.json`),
    socket: join(base, `${key}.sock`),
  };
}
