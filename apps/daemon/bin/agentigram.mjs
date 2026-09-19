#!/usr/bin/env node
// Dev launcher: runs the TypeScript CLI through tsx. Packaging to plain JS for `npx agentigram`
// is Part 2's job (spec → Local daemon).
import { register } from 'tsx/esm/api';

register();
const { main } = await import('../src/cli.ts');
await main();
