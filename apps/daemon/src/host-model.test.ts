import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { modelFromTranscript, resolveHostModel } from './host-model.js';

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'agg-model-'));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const line = (model: string) =>
  JSON.stringify({ type: 'assistant', message: { model, role: 'assistant', content: [] } });

describe('resolveHostModel', () => {
  it('reads the newest real model from a transcript, ignoring synthetic turns', () => {
    const file = join(dir, 't.jsonl');
    writeFileSync(
      file,
      [line('claude-sonnet-4'), line('claude-opus-4-1'), line('<synthetic>')].join('\n'),
    );
    expect(modelFromTranscript(file)).toBe('claude-opus-4-1');
    expect(resolveHostModel('claude-code', { transcript_path: file })).toBe('claude-opus-4-1');
  });

  it('prefers what the hook itself says', () => {
    const file = join(dir, 't.jsonl');
    writeFileSync(file, line('claude-opus-4-1'));
    expect(resolveHostModel('claude-code', { model: 'x-model', transcript_path: file })).toBe(
      'x-model',
    );
  });

  it('falls back to the codex configured model', () => {
    mkdirSync(join(dir, '.codex'));
    writeFileSync(
      join(dir, '.codex', 'config.toml'),
      'approval = "never"\nmodel = "gpt-5-codex"\n',
    );
    expect(resolveHostModel('codex', {}, dir)).toBe('gpt-5-codex');
  });

  it('returns undefined rather than guessing when nothing names a model', () => {
    const file = join(dir, 'empty.jsonl');
    writeFileSync(file, '');
    expect(resolveHostModel('codex', { transcript_path: file }, dir)).toBeUndefined();
    expect(modelFromTranscript(join(dir, 'missing.jsonl'))).toBeUndefined();
  });
});
