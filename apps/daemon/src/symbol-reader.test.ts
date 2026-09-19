import { cpSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { symbolKey } from '@agentigram/protocol';
import { describe, expect, it } from 'vitest';
import { SymbolReader } from './symbol-reader.js';

const DEMO = resolve(dirname(fileURLToPath(import.meta.url)), '../../../demo-repo');
const USER_ID = symbolKey('src/types/user.ts', 'User', 'id', 'property');
const log = { info() {}, warn() {} };

/** A throwaway copy of the demo repo so tests can edit files on disk. */
function copyOfDemo(): string {
  const dir = mkdtempSync(join(tmpdir(), 'agentigram-symbols-'));
  cpSync(join(DEMO, 'src'), join(dir, 'src'), { recursive: true });
  cpSync(join(DEMO, 'tsconfig.json'), join(dir, 'tsconfig.json'));
  return dir;
}

describe('SymbolReader (daemon <-> @agentigram/analysis)', () => {
  it('maps a Read of checkout.ts to the symbols it defines and references, including User.id', () => {
    const reader = new SymbolReader(DEMO, log);
    const keys = reader.read(['src/checkout/checkout.ts']);
    expect(keys).toContain(USER_ID);
    expect(keys).toContain('src/checkout/checkout.ts#checkout:function');
    expect(keys).not.toContain('src/security/middleware.ts#requireAuth:function');
  });

  it('resolves paths against the hook cwd, not only the repo root', () => {
    const reader = new SymbolReader(DEMO, log);
    expect(reader.read(['checkout.ts'], join(DEMO, 'src', 'checkout'))).toContain(
      'src/checkout/checkout.ts#checkout:function',
    );
  });

  it('picks up an edit once the file is marked dirty', () => {
    const dir = copyOfDemo();
    const reader = new SymbolReader(dir, log);
    expect(reader.read(['src/security/middleware.ts'])).not.toContain(
      'src/security/middleware.ts#audit:function',
    );
    const file = join(dir, 'src', 'security', 'middleware.ts');
    writeFileSync(file, `${'export function audit(): void {}\n'}`, { flag: 'a' });
    reader.markDirty(['src/security/middleware.ts']);
    expect(reader.read(['src/security/middleware.ts'])).toContain(
      'src/security/middleware.ts#audit:function',
    );
  });

  it('degrades to no symbols, without throwing, when the repo has no tsconfig', () => {
    const dir = mkdtempSync(join(tmpdir(), 'agentigram-notts-'));
    mkdirSync(join(dir, 'src'));
    const warnings: object[] = [];
    const reader = new SymbolReader(dir, {
      info: (o) => warnings.push(o),
      warn: (o) => warnings.push(o),
    });
    expect(reader.read(['src/a.ts'])).toEqual([]);
    expect(reader.read(['src/a.ts'])).toEqual([]);
    expect(warnings).toHaveLength(1); // reported once, not on every hook
  });

  it('warm() builds the index off the hook path', async () => {
    const reader = new SymbolReader(DEMO, log);
    reader.warm();
    await new Promise((r) => setTimeout(r, 300));
    const t0 = performance.now();
    reader.read(['src/checkout/checkout.ts']);
    expect(performance.now() - t0).toBeLessThan(250);
  });
});
