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
    join(root, '.git', 'hooks', 'prepare-commit-msg.agentigram-original'),
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
    const base = mkdtempSync(join(tmpdir(), 'agentigram-install-'));
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

    const state = install({
      root,
      roomId: 'hackathon',
      mode: 'authority',
      host: 'claude-code',
      sessionId: 'backend',
      repositoryFingerprint: 'repo',
      capability: 'capability',
      runtimeBase,
      claudeConfigPath,
    });
    expect(state.authoritySeed).toMatch(/^[0-9a-f]{64}$/);
    const settings = readFileSync(join(root, '.claude', 'settings.local.json'), 'utf8');
    expect(settings).toContain('PostToolUse');
    expect(settings).toContain('CLAUDE_CODE_ENABLE_TELEMETRY');
    expect(readFileSync(claudeConfigPath, 'utf8')).toContain('agentigram');

    uninstall(root, runtimeBase);
    expect(capture(root)).toEqual(before);
    expect(readFileSync(claudeConfigPath, 'utf8')).toBe(claudeBefore);
  });

  it('removes local directories that did not exist before join', () => {
    const base = mkdtempSync(join(tmpdir(), 'agentigram-clean-install-'));
    const root = join(base, 'repo');
    mkdirSync(join(root, '.git'), { recursive: true });
    install({
      root,
      roomId: 'hackathon',
      mode: 'authority',
      host: 'claude-code',
      sessionId: 'backend',
      repositoryFingerprint: 'repo',
      capability: 'capability',
      runtimeBase: join(base, 'runtime'),
      claudeConfigPath: join(base, 'claude.json'),
    });
    expect(existsSync(join(root, '.claude'))).toBe(true);
    uninstall(root, join(base, 'runtime'));
    expect(existsSync(join(root, '.claude'))).toBe(false);
  });

  it('installs Gemini hooks and MCP, then restores existing settings exactly', () => {
    const base = mkdtempSync(join(tmpdir(), 'agentigram-gemini-install-'));
    const root = join(base, 'repo');
    const runtimeBase = join(base, 'runtime');
    const settingsPath = join(root, '.gemini', 'settings.json');
    mkdirSync(join(root, '.git'), { recursive: true });
    mkdirSync(join(root, '.gemini'), { recursive: true });
    const before = '{"ui":{"theme":"GitHub"},"hooks":{"BeforeTool":[]}}\n';
    writeFileSync(settingsPath, before);

    install({
      root,
      roomId: 'hackathon',
      mode: 'peer',
      host: 'gemini-cli',
      sessionId: 'gemini-frontend',
      repositoryFingerprint: 'repo',
      runtimeBase,
    });

    const settings = JSON.parse(readFileSync(settingsPath, 'utf8')) as {
      ui: unknown;
      hooksConfig: { enabled: boolean };
      hooks: Record<
        string,
        Array<{ matcher?: string; hooks: Array<{ name: string; timeout: number }> }>
      >;
      mcpServers: { agentigram: { cwd: string; trust: boolean; args: string[] } };
    };
    expect(settings.ui).toEqual({ theme: 'GitHub' });
    expect(settings.hooksConfig.enabled).toBe(true);
    expect(settings.hooks.SessionStart?.[0]?.hooks[0]?.name).toBe('agentigram-SessionStart');
    expect(settings.hooks.BeforeTool?.[0]?.matcher).toBe('.*');
    expect(settings.hooks.AfterTool?.[0]?.hooks[0]?.timeout).toBe(3000);
    expect(settings.mcpServers.agentigram).toMatchObject({ cwd: root, trust: true });
    expect(settings.mcpServers.agentigram.args).toContain('mcp');

    uninstall(root, runtimeBase);
    expect(readFileSync(settingsPath, 'utf8')).toBe(before);
  });

  it('removes a newly-created Gemini settings directory on leave', () => {
    const base = mkdtempSync(join(tmpdir(), 'agentigram-gemini-clean-install-'));
    const root = join(base, 'repo');
    const runtimeBase = join(base, 'runtime');
    mkdirSync(join(root, '.git'), { recursive: true });

    install({
      root,
      roomId: 'hackathon',
      mode: 'peer',
      host: 'gemini-cli',
      sessionId: 'gemini-frontend',
      repositoryFingerprint: 'repo',
      runtimeBase,
    });
    expect(existsSync(join(root, '.gemini', 'settings.json'))).toBe(true);

    uninstall(root, runtimeBase);
    expect(existsSync(join(root, '.gemini'))).toBe(false);
  });
});
