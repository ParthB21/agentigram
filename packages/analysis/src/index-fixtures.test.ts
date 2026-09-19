import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { beforeAll, describe, expect, it } from 'vitest';
import { dependentsOf, fileOverlap, importClosure, indexRepo, type RepoIndex } from './index.js';

const fixture = (name: string) =>
  resolve(dirname(fileURLToPath(import.meta.url)), '../fixtures', name);
const lineOf = (root: string, file: string, text: string) => {
  const i = readFileSync(resolve(root, file), 'utf8')
    .split('\n')
    .findIndex((l) => l.includes(text));
  if (i < 0) throw new Error(`"${text}" not in ${file}`);
  return i + 1;
};

describe('kitchen-sink: exported surface', () => {
  const root = fixture('kitchen-sink');
  let idx: RepoIndex;
  beforeAll(async () => {
    idx = await indexRepo(root);
  });
  const models = () =>
    Object.fromEntries(
      Object.values(idx.symbols)
        .filter((s) => s.path === 'src/models.ts')
        .map((s) => [s.key.replace('src/models.ts#', ''), s.signature]),
    );

  it('indexes exactly the expected symbols with normalised signatures', () => {
    const { 'parse:function': parse, ...rest } = models();
    expect(rest).toEqual({
      'Base:interface': 'interface Base',
      'Base.id:property': 'id: number',
      'Admin:interface': 'interface Admin extends Base',
      'Admin.id:property': 'id: number', // inherited members are part of the subtype's surface
      'Admin.perms:property': 'perms: string[]',
      'Admin.tag:property': 'readonly tag?: string | undefined',
      'Point:type': 'type Point = { x: number; y?: number | undefined; }',
      'Point.x:property': 'x: number',
      'Point.y:property': 'y?: number | undefined',
      'Mode:type': "type Mode = 'fast' | 'slow'",
      'Mapper:type': 'type Mapper<T> = (input: T) => T',
      'Color:enum': 'enum Color',
      'Color.Red:property': 'Red = 0',
      'Color.Green:property': "Green = 'green'",
      'Flag:enum': 'const enum Flag',
      'Flag.On:property': 'On = 1',
      'Counter:class': 'class Counter',
      'Counter.label:property': 'readonly label: string',
      'Counter.step:property': 'step: number',
      'Counter.inc:method': 'inc: (by?: number | undefined) => number',
      'Counter.constructor:method': 'new (start: number, label?: string) => Counter',
      'Counter.static$instances:property': 'static instances: number',
      'Counter.static$create:method': 'static create: () => Counter',
      'Shape:class': 'abstract class Shape',
      'Shape.area:method': 'area: () => number',
      'identity:function': '<T>(x: T) => T',
      'double:function': '(n: number) => number',
      'LIMIT:variable': '10',
      'default:function': '() => void',
      'visible:variable': '1',
      'Util:module': 'namespace Util',
    });
    expect(parse).toMatch(/^\{ \(s: string\): number; \(s: number\): string; \}$/);
  });

  it('leaves out private, #private, non-exported and lib members', () => {
    const keys = Object.keys(idx.symbols).join('\n');
    for (const hidden of [
      'secret',
      '#hidden',
      'notExported',
      'toString',
      'prototype',
      ':variable\nhidden',
    ]) {
      expect(keys).not.toContain(hidden);
    }
    expect(Object.keys(idx.symbols).some((k) => k.includes('lib.'))).toBe(false);
  });

  it('gives every symbol a valid key, a 16-char hash and a real line', () => {
    for (const s of Object.values(idx.symbols)) {
      expect(s.signatureHash).toMatch(/^[0-9a-f]{16}$/);
      expect(s.line).toBeGreaterThan(0);
    }
    expect(idx.symbols['src/models.ts#Counter.inc:method']?.line).toBe(
      lineOf(root, 'src/models.ts', 'inc(by?'),
    );
  });

  it('indexes re-exports where they are declared, not in the barrel', () => {
    expect(Object.values(idx.symbols).some((s) => s.path === 'src/barrel.ts')).toBe(false);
    expect(idx.symbols['src/util.ts#helper:function']?.signature).toBe('() => number');
  });

  it('is deterministic: same repo, same index', async () => {
    expect(await indexRepo(root)).toEqual(idx);
  });
});

describe('kitchen-sink: references', () => {
  const root = fixture('kitchen-sink');
  let idx: RepoIndex;
  beforeAll(async () => {
    idx = await indexRepo(root);
  });
  const at = (text: string) => {
    const line = lineOf(root, 'src/consumer.ts', text);
    return (idx.references['src/consumer.ts'] ?? [])
      .filter((r) => r.line === line)
      .map((r) => r.key.replace(/^src\/[a-z]+\.ts#/, ''))
      .sort();
  };

  it('resolves through barrels, aliases and re-exports to the declaring symbol', () => {
    expect(at('import {')).toEqual([
      'Admin:interface',
      'Color:enum',
      'Counter:class',
      'LIMIT:variable',
      'double:function',
      'helper:function',
    ]);
  });

  it('resolves destructuring to the property', () => {
    expect(at('const { perms }')).toEqual(['Admin.perms:property']);
  });

  it('resolves object-literal properties through their contextual type', () => {
    const keys = at('const made');
    expect(keys).toEqual(
      expect.arrayContaining(['Admin.id:property', 'Admin.perms:property', 'Base.id:property']),
    );
  });

  it('a use of an inherited member counts for the base and every subtype', () => {
    const keys = at('return a.id');
    expect(keys).toEqual(expect.arrayContaining(['Base.id:property', 'Admin.id:property']));
    expect(keys).toEqual(
      expect.arrayContaining([
        'Counter.static$create:method',
        'Counter.inc:method',
        'Color.Red:property',
        'double:function',
        'LIMIT:variable',
        'helper:function',
      ]),
    );
  });

  it('never reports references to symbols declared in the same file', () => {
    for (const refs of Object.values(idx.references)) {
      for (const r of refs) expect(idx.symbols[r.key]?.path).not.toBe(r.path);
    }
  });
});

describe('graph fixture: import graph', () => {
  let idx: RepoIndex;
  beforeAll(async () => {
    idx = await indexRepo(fixture('graph'));
  });

  it('resolves side-effect, type-only, barrel and cyclic imports; skips unresolved externals', () => {
    expect(idx.imports).toEqual({
      'src/a.test.ts': ['src/a.ts'],
      'src/a.ts': ['src/d.ts', 'src/lib/index.ts', 'src/side-effect.ts'],
      'src/d.ts': ['src/lib/index.ts'],
      'src/lib/b.ts': [],
      'src/lib/c.ts': ['src/a.ts'],
      'src/lib/index.ts': ['src/lib/b.ts', 'src/lib/c.ts'],
      'src/side-effect.ts': [],
    });
    expect(idx.modules).toEqual(Object.keys(idx.imports).sort());
  });

  it('computes import closure (terminating on cycles) and dependents', () => {
    expect(importClosure(idx, ['src/a.ts'])).toEqual([
      'src/a.ts',
      'src/d.ts',
      'src/lib/b.ts',
      'src/lib/c.ts',
      'src/lib/index.ts',
      'src/side-effect.ts',
    ]);
    expect(dependentsOf(idx, ['src/lib/b.ts'])).toEqual([
      'src/a.test.ts',
      'src/a.ts',
      'src/d.ts',
      'src/lib/b.ts',
      'src/lib/c.ts',
      'src/lib/index.ts',
    ]);
    expect(importClosure(idx, ['src/nope.ts'])).toEqual([]);
  });
});

describe('tier 0: file overlap', () => {
  it('intersects write sets, normalising separators and ./ prefixes', () => {
    expect(
      fileOverlap(['./src/a.ts', 'src/b.ts', 'src/a.ts'], ['src/a.ts', 'src\\b.ts', 'src/c.ts']),
    ).toEqual(['src/a.ts', 'src/b.ts']);
    expect(fileOverlap([], ['a'])).toEqual([]);
    expect(fileOverlap(['a'], ['b'])).toEqual([]);
  });
});
