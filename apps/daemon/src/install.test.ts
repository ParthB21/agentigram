import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { install, uninstall } from './install.js';

function capture(root: string) {
  const paths = [
    join(root, '.claude', 'settings.local.json'),
    join(root, '.git', 'hooks', 'prepare-commit-msg'),
    join(root, '.git', 'hooks', 'prepare-commit-msg.clankergram-original'),
  ];
  return paths.map((path) => {
    try {
      return { path, content: readFileSync(path, 'utf8'), mode: statSync(path).mode };
    } catch {
      return { path, content: undefined, mode: undefined };
    }
  });
}

describe('join / leave installation', () => {
  it('leaves repository files byte-identical and preserves existing hooks/settings', () => {
    const base = mkdtempSync(join(tmpdir(), 'clankergram-install-'));
    const root = join(base, 'repo');
    const runtimeBase = join(base, 'runtime');
    const claudeConfigPath = join(base, 'claude.json');
    mkdirSync(join(root, '.git', 'hooks'), { recursive: true });
    mkdirSync(join(root, '.claude'), { recursive: true });
    writeFileSync(join(root, '.claude', 'settings.local.json'), '{"theme":"dark"}\n');
    const hook = join(root, '.git', 'hooks', 'prepare-commit-msg');
    writeFileSync(hook, '#!/bin/sh\necho existing\n');
    chmodSync(hook, 0o744);
    writeFileSync(claudeConfigPath, '{"projects":{},"other":true}\n');
    const before = capture(root);
    const claudeBefore = readFileSync(claudeConfigPath, 'utf8');

    install({ root, teamCode: 'hackathon', runtimeBase, claudeConfigPath });
    const settings = readFileSync(join(root, '.claude', 'settings.local.json'), 'utf8');
    expect(settings).toContain('PostToolUse');
    expect(settings).toContain('CLAUDE_CODE_ENABLE_TELEMETRY');
    expect(readFileSync(claudeConfigPath, 'utf8')).toContain('clankergram');

    uninstall(root, runtimeBase);
    expect(capture(root)).toEqual(before);
    expect(readFileSync(claudeConfigPath, 'utf8')).toBe(claudeBefore);
  });

  it('removes local directories that did not exist before join', () => {
    const base = mkdtempSync(join(tmpdir(), 'clankergram-clean-install-'));
    const root = join(base, 'repo');
    mkdirSync(join(root, '.git'), { recursive: true });
    install({
      root,
      teamCode: 'hackathon',
      runtimeBase: join(base, 'runtime'),
      claudeConfigPath: join(base, 'claude.json'),
    });
    expect(existsSync(join(root, '.claude'))).toBe(true);
    uninstall(root, join(base, 'runtime'));
    expect(existsSync(join(root, '.claude'))).toBe(false);
  });
});
