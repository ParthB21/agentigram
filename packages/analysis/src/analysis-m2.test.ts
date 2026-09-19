import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { assessImpact, compareIndexes, Indexer, readSetFromFiles, resolveIntent } from './index.js';

const DEMO = resolve(dirname(fileURLToPath(import.meta.url)), '../../../demo-repo');
const USER_ID = 'src/types/user.ts#User.id:property';

describe('analysis collision tiers', () => {
  it('classifies User.id number to string as breaking and names local references', async () => {
    const beforeIndexer = new Indexer(DEMO);
    const before = beforeIndexer.index();
    const afterIndexer = new Indexer(DEMO);
    const source =
      afterIndexer.host.service
        .getProgram()
        ?.getSourceFile(afterIndexer.host.abs('src/types/user.ts'))
        ?.getFullText() ?? '';
    afterIndexer.update('src/types/user.ts', source.replace('id: number;', 'id: string;'));
    const changes = compareIndexes(before, afterIndexer.index());
    const userChange = changes.find((change) => change.symbol === USER_ID);
    expect(userChange).toMatchObject({ breaking: true });

    const readSet = readSetFromFiles(['src/checkout/checkout.ts'], before, 1);
    const impact = assessImpact(
      { writerSession: 'backend', changes: [userChange!] },
      before,
      readSet,
    );
    expect(impact.tier).toBe('SEMANTIC');
    expect(impact.symbols).toContain(USER_ID);
    expect(
      impact.references.some((reference) => reference.path === 'src/checkout/checkout.ts'),
    ).toBe(true);
    expect(impact.detail).toContain('src/checkout/checkout.ts:');
  });

  it('resolves explicit symbols, files, and identifiers without an LLM', async () => {
    const index = new Indexer(DEMO).index();
    expect((await resolveIntent('anything', [], [USER_ID], index)).method).toBe('explicit');
    expect((await resolveIntent('checkout', ['src/checkout/types.ts'], [], index)).method).toBe(
      'files',
    );
    const identified = await resolveIntent('Update User id', [], [], index);
    expect(identified.symbols).toContain(USER_ID);
    expect(identified.llmUsed).toBe(false);
  });
});
