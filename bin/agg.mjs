#!/usr/bin/env node

// Keep setup dependency-free so it can repair a fresh or stale checkout before
// the TypeScript CLI (and its workspace dependencies) can be imported.
const [command] = process.argv.slice(2);

if (command === 'setup') {
  const { runSetup } = await import('../scripts/setup.mjs');
  try {
    await runSetup(process.argv.slice(3));
  } catch (error) {
    console.error(`\nSetup failed: ${error instanceof Error ? error.message : error}`);
    process.exitCode = 1;
  }
} else {
  // npm sets INIT_CWD while running package scripts. A globally linked `agg`
  // should always treat the shell's current directory as the repository root.
  process.env.INIT_CWD = process.cwd();
  await import('../apps/daemon/bin/agentigram.mjs');
}
