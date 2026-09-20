import { rmSync } from 'node:fs';

for (const directory of ['../.next/types', '../.next/dev/types']) {
  rmSync(new URL(directory, import.meta.url), { recursive: true, force: true });
}
