#!/usr/bin/env node

import { spawnSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const PNPM_VERSION = '10.34.5';
const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const npx = process.platform === 'win32' ? 'npx.cmd' : 'npx';
const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';

function run(label, command, args, cwd = repositoryRoot) {
  console.log(`\n[agg setup] ${label}`);
  const executable = process.platform === 'win32' ? (process.env.ComSpec ?? 'cmd.exe') : command;
  const executableArgs =
    process.platform === 'win32' ? ['/d', '/s', '/c', [command, ...args].join(' ')] : args;
  const result = spawnSync(executable, executableArgs, { cwd, stdio: 'inherit' });

  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`${label} failed with exit code ${result.status ?? 'unknown'}`);
  }
}

export async function runSetup(args = []) {
  const unknown = args.filter((arg) => arg !== '--skip-model' && arg !== '--skip-link');
  if (unknown.length > 0) {
    throw new Error(`Unknown setup option: ${unknown.join(', ')}`);
  }

  const skipModel = args.includes('--skip-model');
  const skipLink = args.includes('--skip-link');

  run('Installing workspace dependencies', npx, ['--yes', `pnpm@${PNPM_VERSION}`, 'install']);
  run('Installing the Bare/Pear terminal UI', npm, ['--prefix', 'apps/tui', 'ci']);

  if (!skipLink) {
    run('Making the agg command available globally', npx, [
      '--yes',
      `pnpm@${PNPM_VERSION}`,
      'link',
      '--global',
    ]);
  }

  if (!skipModel) {
    run('Downloading and warming the local negotiation model', npm, [
      '--prefix',
      'apps/tui',
      'run',
      'warm',
    ]);
  }

  console.log('\nAgentigram is ready. Run `agg --help` to see the available commands.');
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  runSetup(process.argv.slice(2)).catch((error) => {
    console.error(`\nSetup failed: ${error instanceof Error ? error.message : error}`);
    process.exitCode = 1;
  });
}
