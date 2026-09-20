import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { symbolKey } from '@agentigram/protocol';
import { beforeAll, describe, expect, it } from 'vitest';
import { dependentsOf, Indexer, type RepoIndex, readSetFromFiles } from './index.js';

const DEMO = resolve(dirname(fileURLToPath(import.meta.url)), '../../../demo-repo');
const USER_ID = symbolKey('src/types/user.ts', 'User', 'id', 'property');
const source = (rel: string) => readFileSync(resolve(DEMO, rel), 'utf8');
const linesWith = (rel: string, text: string) =>
  source(rel)
    .split('\n')
    .flatMap((l, i) => (l.includes(text) ? [i + 1] : []));

// Budgets from the Part 3 prompt: indexRepo under 2 s for the demo repo after warm-up.
const WARM_BUDGET_MS = 2000;
const COLD_BUDGET_MS = 10_000;

describe('demo repo index', () => {
  let indexer: Indexer;
  let idx: RepoIndex;
  let coldMs = 0;

  beforeAll(() => {
    const t0 = performance.now();
    indexer = new Indexer(DEMO);
    idx = indexer.index();
    coldMs = performance.now() - t0;
  });

  it('indexes every module and exports (timings are logged)', () => {
    console.info(
      `[timing] indexRepo cold: ${coldMs.toFixed(0)} ms (${idx.modules.length} modules, ${Object.keys(idx.symbols).length} symbols)`,
    );
    expect(coldMs).toBeLessThan(COLD_BUDGET_MS);
    expect(idx.modules).toContain('src/checkout/checkout.ts');
    const tests = idx.modules.filter((module) => module.endsWith('.test.ts'));
    expect(tests).toHaveLength(5);
    expect(tests).toContain('src/collaboration-lab/collaboration-lab.test.ts');
    expect(idx.symbols[USER_ID]).toMatchObject({
      kind: 'property',
      signature: 'id: number',
      path: 'src/types/user.ts',
    });
    expect(idx.symbols['src/auth/types.ts#AuthResponse.userId:property']?.signature).toBe(
      'userId: number',
    );
    expect(idx.symbols['src/users/repository.ts#UserRepository.constructor:method']).toBeDefined();
  });

  it('names exactly the three sites in checkout.ts that use User.id', () => {
    const refs = (idx.references['src/checkout/checkout.ts'] ?? []).filter(
      (r) => r.key === USER_ID,
    );
    expect(refs.map((r) => r.line)).toEqual(linesWith('src/checkout/checkout.ts', 'user.id'));
    expect(refs).toHaveLength(3);
  });

  it('follows the import graph across the demo modules', () => {
    expect(idx.imports['src/checkout/checkout.ts']).toEqual([
      'src/auth/types.ts',
      'src/checkout/stripe.ts',
      'src/checkout/types.ts',
      'src/users/service.ts',
    ]);
    // Changing user.ts reaches checkout and its test, through users/service and users/repository.
    const dependents = dependentsOf(idx, ['src/types/user.ts']);
    expect(dependents).toEqual(
      expect.arrayContaining(['src/checkout/checkout.ts', 'src/checkout/checkout.test.ts']),
    );
  });

  it('re-indexes incrementally after an edit, inside the warm budget, without touching disk', () => {
    const before = source('src/types/user.ts');
    const t0 = performance.now();
    indexer.update('src/types/user.ts', before.replace('id: number;', 'id: string;'));
    const after = indexer.index();
    const warmMs = performance.now() - t0;
    console.info(`[timing] update + re-index (warm): ${warmMs.toFixed(0)} ms`);

    expect(warmMs).toBeLessThan(WARM_BUDGET_MS);
    expect(after.symbols[USER_ID]?.signature).toBe('id: string');
    expect(after.symbols[USER_ID]?.signatureHash).not.toBe(idx.symbols[USER_ID]?.signatureHash);
    expect(after.symbols['src/types/user.ts#User.email:property']).toEqual(
      idx.symbols['src/types/user.ts#User.email:property'],
    );
    expect(source('src/types/user.ts')).toBe(before);

    indexer.refreshFromDisk(['src/types/user.ts']); // back to disk truth
    expect(indexer.index().symbols[USER_ID]?.signature).toBe('id: number');
  });

  it('handles new and deleted files', () => {
    indexer.update('src/extra.ts', 'export const extra = 1;\n');
    expect(indexer.index().symbols['src/extra.ts#extra:variable']?.signature).toBe('1');
    indexer.update('src/extra.ts', null);
    const gone = indexer.index();
    expect(gone.modules).not.toContain('src/extra.ts');
    expect(gone.symbols['src/extra.ts#extra:variable']).toBeUndefined();
  });
});

describe('demo tasks: what each scripted change breaks (documented in demo-repo/README.md)', () => {
  const typeErrors = (indexer: Indexer, idx: RepoIndex) =>
    idx.modules.flatMap((m) =>
      indexer.host.service.getSemanticDiagnostics(indexer.host.abs(m)).map((d) => ({
        file: m,
        line:
          (d.start === undefined
            ? 0
            : (indexer.host.service
                .getProgram()
                ?.getSourceFile(indexer.host.abs(m))
                ?.getLineAndCharacterOfPosition(d.start).line ?? -1)) + 1,
        code: d.code,
      })),
    );

  it('the demo repo starts clean', () => {
    const indexer = new Indexer(DEMO);
    expect(typeErrors(indexer, indexer.index())).toEqual([]);
  });

  it('Backend: User.id -> string gives exactly 3 type errors in checkout.ts, each on an indexed reference', () => {
    const indexer = new Indexer(DEMO);
    indexer.update(
      'src/types/user.ts',
      source('src/types/user.ts').replace('id: number;', 'id: string;'),
    );
    const idx = indexer.index();
    const errors = typeErrors(indexer, idx);
    const inCheckout = errors.filter((e) => e.file === 'src/checkout/checkout.ts');
    expect(inCheckout.map((e) => [e.line, e.code])).toEqual([
      [linesWith('src/checkout/checkout.ts', 'chargeCustomer(user.id')[0], 2345],
      [linesWith('src/checkout/checkout.ts', 'user.id * ')[0], 2362],
      [linesWith('src/checkout/checkout.ts', 'userId: user.id')[0], 2322],
    ]);
    // Recall on this scenario: every error site is a place the index says references User.id.
    const refLines = new Set(
      Object.values(idx.references)
        .flat()
        .filter((r) => r.key === USER_ID)
        .map((r) => `${r.path}:${r.line}`),
    );
    for (const e of errors) expect(refLines.has(`${e.file}:${e.line}`)).toBe(true);
    // Files outside Backend's and Payments' areas are untouched by this change.
    expect(
      errors.some(
        (e) => e.file === 'src/security/middleware.ts' || e.file === 'src/checkout/view-model.ts',
      ),
    ).toBe(false);
  });

  it('Payments: renaming CheckoutResponse.userId hits Frontend (view-model.ts) and checkout.ts, not Security', () => {
    const key = symbolKey('src/checkout/types.ts', 'CheckoutResponse', 'userId', 'property');
    const idx = new Indexer(DEMO).index();
    const users = Object.values(idx.references)
      .flat()
      .filter((r) => r.key === key);
    expect(users.map((r) => r.path)).toEqual(
      expect.arrayContaining(['src/checkout/view-model.ts', 'src/checkout/checkout.ts']),
    );
    expect(users.some((r) => r.path.startsWith('src/security/'))).toBe(false);
    expect(users.filter((r) => r.path === 'src/checkout/view-model.ts').map((r) => r.line)).toEqual(
      linesWith('src/checkout/view-model.ts', 'response.userId'),
    );
  });

  it('Security: changing verifyToken hits security/middleware.ts', () => {
    const key = symbolKey('src/auth/token.ts', 'verifyToken', 'function');
    const idx = new Indexer(DEMO).index();
    const users = Object.values(idx.references)
      .flat()
      .filter((r) => r.key === key)
      .map((r) => r.path);
    expect(users).toContain('src/security/middleware.ts');
  });
});

describe('read sets', () => {
  let idx: RepoIndex;
  beforeAll(() => {
    idx = new Indexer(DEMO).index();
  });

  it("Payments' files put User.id in the read set", () => {
    const rs = readSetFromFiles(['src/types/user.ts', 'src/checkout/checkout.ts'], idx, 1234);
    expect(rs.symbols[USER_ID]).toBe(1234); // defined in user.ts, and referenced by checkout.ts
    expect(rs.symbols['src/checkout/checkout.ts#checkout:function']).toBe(1234); // defined
    expect(rs.symbols['src/auth/types.ts#AuthResponse:interface']).toBe(1234); // referenced
    expect(rs.symbols['src/users/service.ts#UserService.requireUser:method']).toBe(1234);
  });

  it("Security's middleware does not depend on User.id, so it is not in that read set", () => {
    const rs = readSetFromFiles(['src/security/middleware.ts'], idx, 1);
    expect(rs.symbols[USER_ID]).toBeUndefined();
    expect(rs.symbols['src/types/user.ts#User.role:property']).toBe(1);
    expect(rs.symbols['src/auth/token.ts#verifyToken:function']).toBe(1);
  });

  it('accepts absolute paths and ignores unknown files', () => {
    const abs = resolve(DEMO, 'src/types/user.ts');
    expect(Object.keys(readSetFromFiles([abs], idx, 0).symbols)).toContain(USER_ID);
    expect(readSetFromFiles(['src/nope.ts', 'README.md'], idx, 0).symbols).toEqual({});
  });
});
