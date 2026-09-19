// Run a Bare entry point with the Bare binary this app installed.
//
// `brittle-bare` and friends shell out to a `bare` on PATH, which means a
// global `npm i -g bare-runtime` that may not be there. bare-runtime ships the
// prebuilt binary as a dependency and can hand us its path, so use that and
// keep the app self-contained.
import { spawn } from 'node:child_process'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const bare = require('bare-runtime')()

const [entry, ...rest] = process.argv.slice(2)
if (!entry) {
  console.error('usage: node scripts/bare.mjs <entry.js> [args...]')
  process.exit(1)
}

const child = spawn(bare, [require.resolve(entry), ...rest], { stdio: 'inherit' })
child.on('exit', (code, signal) => {
  if (signal) process.kill(process.pid, signal)
  else process.exit(code ?? 0)
})
