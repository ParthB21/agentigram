import { spawnSync } from 'node:child_process';
import { readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const files = ['bin.mjs', 'app.js'];
for (const directory of ['lib', 'ui', 'workers', 'test']) {
  for (const name of readdirSync(join(root, directory))) {
    if (name.endsWith('.js')) files.push(join(directory, name));
  }
}

for (const file of files) {
  const checked = spawnSync(process.execPath, ['--check', join(root, file)], { stdio: 'inherit' });
  if (checked.status !== 0) process.exit(checked.status ?? 1);
}
