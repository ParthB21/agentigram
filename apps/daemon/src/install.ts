import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { homedir, userInfo } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runtimePaths } from './runtime.js';

const SETTINGS_PATH = join('.claude', 'settings.local.json');
const GIT_HOOK_PATH = join('.git', 'hooks', 'prepare-commit-msg');
const ORIGINAL_HOOK_PATH = `${GIT_HOOK_PATH}.clankergram-original`;
const MCP_SERVER_NAME = 'clankergram';
const DEFAULT_COORDINATOR = 'ws://localhost:8787';
const OTLP_ENDPOINT = 'http://127.0.0.1:4318';

type FileSnapshot = { exists: boolean; content?: string; mode?: number };

export type InstallState = {
  version: 1;
  root: string;
  roomId: string;
  teamCode: string;
  engineerId: string;
  coordinator: string;
  socketPath: string;
  pid?: number;
  files: Record<string, FileSnapshot>;
  createdDirectories: string[];
  claudeConfigPath: string;
};

export type InstallOptions = {
  root: string;
  teamCode: string;
  coordinator?: string;
  engineerId?: string;
  runtimeBase?: string;
  claudeConfigPath?: string;
};

function snapshot(path: string): FileSnapshot {
  if (!existsSync(path)) return { exists: false };
  const stats = statSync(path);
  return { exists: true, content: readFileSync(path, 'utf8'), mode: stats.mode };
}

function writeAtomic(path: string, content: string, mode?: number): void {
  mkdirSync(dirname(path), { recursive: true });
  const temp = `${path}.${process.pid}.tmp`;
  writeFileSync(temp, content, { mode: mode ?? 0o600 });
  renameSync(temp, path);
  if (mode !== undefined) chmodSync(path, mode);
}

function readJson(path: string): Record<string, unknown> {
  if (!existsSync(path)) return {};
  return JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>;
}

function mergeSettings(root: string, socketPath: string): string {
  const path = join(root, SETTINGS_PATH);
  const settings = readJson(path);
  const executable = fileURLToPath(new URL('../bin/clankergram.mjs', import.meta.url));
  const handler = (event: string, timeout: number) => ({
    type: 'command',
    command: process.execPath,
    args: [executable, 'hook', event, '--root', root],
    timeout,
  });
  const hooks = { ...(settings.hooks as Record<string, unknown> | undefined) };
  for (const [event, matcher, timeout] of [
    ['SessionStart', undefined, 1],
    ['UserPromptSubmit', undefined, 1],
    ['PreToolUse', 'Edit|Write|MultiEdit|Bash', 0.3],
    ['PostToolUse', 'Read|Grep|Glob|Edit|Write|MultiEdit|Bash', 1],
    ['Stop', undefined, 1],
    ['SessionEnd', undefined, 1],
  ] as const) {
    const current = Array.isArray(hooks[event]) ? hooks[event] : [];
    hooks[event] = [
      ...current,
      { ...(matcher ? { matcher } : {}), hooks: [handler(event, timeout)] },
    ];
  }
  return `${JSON.stringify(
    {
      ...settings,
      env: {
        ...(settings.env as Record<string, unknown> | undefined),
        CLANKERGRAM_SOCKET: socketPath,
        CLAUDE_CODE_ENABLE_TELEMETRY: '1',
        OTEL_METRICS_EXPORTER: 'otlp',
        OTEL_LOGS_EXPORTER: 'otlp',
        OTEL_EXPORTER_OTLP_PROTOCOL: 'http/protobuf',
        OTEL_EXPORTER_OTLP_ENDPOINT: OTLP_ENDPOINT,
      },
      hooks,
    },
    null,
    2,
  )}\n`;
}

function mergeMcpConfig(path: string, root: string): string {
  const config = readJson(path);
  const projects = { ...(config.projects as Record<string, unknown> | undefined) };
  const project = { ...(projects[root] as Record<string, unknown> | undefined) };
  const servers = { ...(project.mcpServers as Record<string, unknown> | undefined) };
  const executable = fileURLToPath(new URL('../bin/clankergram.mjs', import.meta.url));
  servers[MCP_SERVER_NAME] = {
    type: 'stdio',
    command: process.execPath,
    args: [executable, 'mcp', '--root', root],
  };
  projects[root] = { ...project, mcpServers: servers };
  return `${JSON.stringify({ ...config, projects }, null, 2)}\n`;
}

function installGitHook(root: string): void {
  const hook = join(root, GIT_HOOK_PATH);
  const original = join(root, ORIGINAL_HOOK_PATH);
  mkdirSync(dirname(hook), { recursive: true });
  if (existsSync(hook)) {
    writeFileSync(original, readFileSync(hook));
    chmodSync(original, statSync(hook).mode);
  }
  const script = [
    '#!/bin/sh',
    '# Managed by Clankergram. Restored exactly by `clankergram leave`.',
    `[ -x "${original}" ] && "${original}" "$@"`,
    'exit 0',
    '',
  ].join('\n');
  writeFileSync(hook, script, { mode: 0o755 });
}

export function install(options: InstallOptions): InstallState {
  const root = resolve(options.root);
  if (!existsSync(join(root, '.git'))) throw new Error(`${root} is not a Git repository`);
  const paths = runtimePaths(root, options.runtimeBase);
  if (existsSync(paths.state)) throw new Error('Clankergram is already joined in this repository');
  const claudeConfigPath = options.claudeConfigPath ?? join(homedir(), '.claude.json');
  const trackedPaths = [
    join(root, SETTINGS_PATH),
    join(root, GIT_HOOK_PATH),
    join(root, ORIGINAL_HOOK_PATH),
    claudeConfigPath,
  ];
  const candidateDirectories = [...new Set(trackedPaths.map((path) => dirname(path)))];
  const state: InstallState = {
    version: 1,
    root,
    roomId: options.teamCode,
    teamCode: options.teamCode,
    engineerId: options.engineerId ?? userInfo().username,
    coordinator: options.coordinator ?? DEFAULT_COORDINATOR,
    socketPath: paths.socket,
    claudeConfigPath,
    files: Object.fromEntries(trackedPaths.map((path) => [path, snapshot(path)])),
    createdDirectories: candidateDirectories.filter((path) => !existsSync(path)),
  };

  writeAtomic(paths.state, `${JSON.stringify(state, null, 2)}\n`, 0o600);
  try {
    writeAtomic(join(root, SETTINGS_PATH), mergeSettings(root, paths.socket));
    writeAtomic(claudeConfigPath, mergeMcpConfig(claudeConfigPath, root));
    installGitHook(root);
  } catch (error) {
    uninstall(root, options.runtimeBase);
    throw error;
  }
  return state;
}

function restore(path: string, file: FileSnapshot): void {
  if (!file.exists) {
    rmSync(path, { force: true });
    return;
  }
  writeAtomic(path, file.content ?? '', file.mode);
}

export function uninstall(root: string, runtimeBase?: string): InstallState {
  const statePath = runtimePaths(root, runtimeBase).state;
  if (!existsSync(statePath)) throw new Error('Clankergram is not joined in this repository');
  const state = JSON.parse(readFileSync(statePath, 'utf8')) as InstallState;
  for (const [path, file] of Object.entries(state.files)) restore(path, file);
  for (const directory of [...state.createdDirectories].reverse()) {
    try {
      rmdirSync(directory);
    } catch {
      // A directory with unrelated files must be preserved.
    }
  }
  rmSync(state.socketPath, { force: true });
  rmSync(statePath, { force: true });
  return state;
}

export function readInstallState(root: string, runtimeBase?: string): InstallState | undefined {
  const path = runtimePaths(root, runtimeBase).state;
  if (!existsSync(path)) return undefined;
  return JSON.parse(readFileSync(path, 'utf8')) as InstallState;
}

export function writeInstallState(state: InstallState, runtimeBase?: string): void {
  const path = runtimePaths(state.root, runtimeBase).state;
  writeAtomic(path, `${JSON.stringify(state, null, 2)}\n`, 0o600);
}
