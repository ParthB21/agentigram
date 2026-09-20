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
import type { RoomInvite } from '@agentigram/p2p';
import { isPipe, runtimePaths } from './runtime.js';

const SETTINGS_PATH = join('.claude', 'settings.local.json');
const CODEX_HOOKS_PATH = join('.codex', 'hooks.json');
const CODEX_CONFIG_PATH = join('.codex', 'config.toml');
const GEMINI_SETTINGS_PATH = join('.gemini', 'settings.json');
const GIT_HOOK_PATH = join('.git', 'hooks', 'prepare-commit-msg');
const ORIGINAL_HOOK_PATH = `${GIT_HOOK_PATH}.agentigram-original`;
const MCP_SERVER_NAME = 'agentigram';
/**
 * Whole seconds, per every host's hook schema. Generous on purpose: this is the
 * ceiling before a host gives up and discards the hook's output, not a delay
 * anyone waits for. The daemon answers in milliseconds once it is warm; the
 * cost being covered here is Node plus tsx starting up.
 */
const HOOK_TIMEOUT_S = 10;
const OTLP_ENDPOINT = 'http://127.0.0.1:4318';

type FileSnapshot = { exists: boolean; content?: string; mode?: number };

export type InstallState = {
  version: 2;
  root: string;
  roomId: string;
  mode: 'authority' | 'peer';
  host: 'claude-code' | 'codex' | 'gemini-cli' | 'antigravity';
  sessionId: string;
  repositoryFingerprint: string;
  p2pStorage: string;
  invite?: RoomInvite;
  capability?: string;
  engineerId: string;
  socketPath: string;
  pid?: number;
  files: Record<string, FileSnapshot>;
  createdDirectories: string[];
  claudeConfigPath: string;
};

export type InstallOptions = {
  root: string;
  roomId: string;
  mode: InstallState['mode'];
  host: InstallState['host'];
  sessionId: string;
  repositoryFingerprint: string;
  invite?: RoomInvite;
  capability?: string;
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
  const executable = fileURLToPath(new URL('../bin/agentigram.mjs', import.meta.url));
  const handler = (event: string, timeout: number) => ({
    type: 'command',
    command: process.execPath,
    args: [executable, 'hook', event, '--root', root],
    timeout,
  });
  const hooks = { ...(settings.hooks as Record<string, unknown> | undefined) };
  // Timeouts are whole seconds. One second is not enough: the hook command
  // boots Node and tsx (which transpiles the CLI) before it has said anything,
  // and that alone can exceed a second cold. A hook that times out has its
  // output discarded, so reads were being dropped and no read set was ever
  // built. The daemon still bounds its own work — PRE_TOOL_TIMEOUT_MS keeps an
  // edit decision fast — so these are ceilings, not delays anyone waits for.
  for (const [event, matcher, timeout] of [
    ['SessionStart', undefined, HOOK_TIMEOUT_S],
    ['UserPromptSubmit', undefined, HOOK_TIMEOUT_S],
    ['PreToolUse', 'Edit|Write|MultiEdit|Bash', HOOK_TIMEOUT_S],
    ['PostToolUse', 'Read|Grep|Glob|Edit|Write|MultiEdit|Bash', HOOK_TIMEOUT_S],
    ['Stop', undefined, HOOK_TIMEOUT_S],
    ['SessionEnd', undefined, HOOK_TIMEOUT_S],
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
        AGENTIGRAM_SOCKET: socketPath,
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
  const executable = fileURLToPath(new URL('../bin/agentigram.mjs', import.meta.url));
  servers[MCP_SERVER_NAME] = {
    type: 'stdio',
    command: process.execPath,
    args: [executable, 'mcp', '--root', root],
  };
  projects[root] = { ...project, mcpServers: servers };
  return `${JSON.stringify({ ...config, projects }, null, 2)}\n`;
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

function mergeCodexHooks(root: string): string {
  const path = join(root, CODEX_HOOKS_PATH);
  const config = readJson(path);
  const executable = fileURLToPath(new URL('../bin/agentigram.mjs', import.meta.url));
  const command = (event: string) =>
    [process.execPath, executable, 'hook', event, '--root', root].map(shellQuote).join(' ');
  const hooks = { ...(config.hooks as Record<string, unknown> | undefined) };
  for (const [event, matcher, timeout] of [
    ['SessionStart', undefined, HOOK_TIMEOUT_S],
    ['UserPromptSubmit', undefined, HOOK_TIMEOUT_S],
    ['PreToolUse', 'Bash|apply_patch|Edit|Write', HOOK_TIMEOUT_S],
    ['PostToolUse', 'Bash|apply_patch|Edit|Write', HOOK_TIMEOUT_S],
    ['Stop', undefined, HOOK_TIMEOUT_S],
    ['SessionEnd', undefined, HOOK_TIMEOUT_S],
  ] as const) {
    const current = Array.isArray(hooks[event]) ? hooks[event] : [];
    hooks[event] = [
      ...current,
      {
        ...(matcher ? { matcher } : {}),
        hooks: [{ type: 'command', command: command(event), timeout }],
      },
    ];
  }
  return `${JSON.stringify(
    { ...config, description: 'Agentigram coordination hooks', hooks },
    null,
    2,
  )}\n`;
}

function mergeCodexMcp(path: string, root: string): string {
  const existing = existsSync(path) ? readFileSync(path, 'utf8') : '';
  if (/^\[mcp_servers\.agentigram\]$/m.test(existing)) {
    throw new Error('Codex already has an mcp_servers.agentigram entry');
  }
  const executable = fileURLToPath(new URL('../bin/agentigram.mjs', import.meta.url));
  const block = [
    '[mcp_servers.agentigram]',
    `command = ${JSON.stringify(process.execPath)}`,
    `args = ${JSON.stringify([executable, 'mcp', '--root', root])}`,
    '',
  ].join('\n');
  return `${existing.trimEnd()}${existing.trim() ? '\n\n' : ''}${block}`;
}

function mergeGeminiSettings(root: string): string {
  const path = join(root, GEMINI_SETTINGS_PATH);
  const settings = readJson(path);
  const executable = fileURLToPath(new URL('../bin/agentigram.mjs', import.meta.url));
  const command = (event: string) =>
    [process.execPath, executable, 'hook', event, '--root', root].map(shellQuote).join(' ');
  const hooks = { ...(settings.hooks as Record<string, unknown> | undefined) };
  for (const [event, matcher] of [
    ['SessionStart', undefined],
    ['BeforeAgent', undefined],
    ['BeforeTool', '.*'],
    ['AfterTool', '.*'],
    ['SessionEnd', undefined],
  ] as const) {
    const current = Array.isArray(hooks[event]) ? hooks[event] : [];
    hooks[event] = [
      ...current,
      {
        ...(matcher ? { matcher } : {}),
        hooks: [
          {
            type: 'command',
            name: `agentigram-${event}`,
            command: command(event),
            timeout: 3000,
            description: 'Forward Gemini CLI activity to Agentigram',
          },
        ],
      },
    ];
  }
  const mcpServers = { ...(settings.mcpServers as Record<string, unknown> | undefined) };
  if (MCP_SERVER_NAME in mcpServers) {
    throw new Error('Gemini CLI already has an mcpServers.agentigram entry');
  }
  mcpServers[MCP_SERVER_NAME] = {
    command: process.execPath,
    args: [executable, 'mcp', '--root', root],
    cwd: root,
    trust: true,
  };
  return `${JSON.stringify(
    {
      ...settings,
      hooksConfig: {
        ...(settings.hooksConfig as Record<string, unknown> | undefined),
        enabled: true,
      },
      hooks,
      mcpServers,
    },
    null,
    2,
  )}\n`;
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
    '# Managed by Agentigram. Restored exactly by `agentigram leave`.',
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
  if (existsSync(paths.state)) throw new Error('Agentigram is already joined in this repository');
  const claudeConfigPath = options.claudeConfigPath ?? join(homedir(), '.claude.json');
  const hostPaths =
    options.host === 'claude-code'
      ? [join(root, SETTINGS_PATH), claudeConfigPath]
      : options.host === 'codex'
        ? [join(root, CODEX_HOOKS_PATH), join(root, CODEX_CONFIG_PATH)]
        : [join(root, GEMINI_SETTINGS_PATH)]; // gemini-cli and antigravity share .gemini/settings.json
  const trackedPaths = [
    join(root, GIT_HOOK_PATH),
    join(root, ORIGINAL_HOOK_PATH),
    ...hostPaths,
  ];
  const candidateDirectories = [...new Set(trackedPaths.map((path) => dirname(path)))];
  const state: InstallState = {
    version: 2,
    root,
    roomId: options.roomId,
    mode: options.mode,
    host: options.host,
    sessionId: options.sessionId,
    repositoryFingerprint: options.repositoryFingerprint,
    p2pStorage: paths.p2pStorage,
    ...(options.invite ? { invite: options.invite } : {}),
    ...(options.capability ? { capability: options.capability } : {}),
    engineerId: options.engineerId ?? userInfo().username,
    socketPath: paths.socket,
    claudeConfigPath,
    files: Object.fromEntries(trackedPaths.map((path) => [path, snapshot(path)])),
    createdDirectories: candidateDirectories.filter((path) => !existsSync(path)),
  };

  writeAtomic(paths.state, `${JSON.stringify(state, null, 2)}\n`, 0o600);
  try {
    if (options.host === 'claude-code') {
      writeAtomic(join(root, SETTINGS_PATH), mergeSettings(root, paths.socket));
      writeAtomic(claudeConfigPath, mergeMcpConfig(claudeConfigPath, root));
    } else if (options.host === 'codex') {
      writeAtomic(join(root, CODEX_HOOKS_PATH), mergeCodexHooks(root));
      writeAtomic(
        join(root, CODEX_CONFIG_PATH),
        mergeCodexMcp(join(root, CODEX_CONFIG_PATH), root),
      );
    } else {
      // gemini-cli and antigravity both use .gemini/settings.json for hooks + MCP
      writeAtomic(join(root, GEMINI_SETTINGS_PATH), mergeGeminiSettings(root));
    }
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
  if (!existsSync(statePath)) throw new Error('Agentigram is not joined in this repository');
  const state = JSON.parse(readFileSync(statePath, 'utf8')) as InstallState;
  for (const [path, file] of Object.entries(state.files)) restore(path, file);
  for (const directory of [...state.createdDirectories].reverse()) {
    try {
      rmdirSync(directory);
    } catch {
      // A directory with unrelated files must be preserved.
    }
  }
  // A Windows named pipe has no directory entry to remove, and `unlink` on one
  // throws EINVAL — which `force` does not suppress, so this aborted `leave`
  // before the install state was removed and the repo stayed "already joined".
  if (!isPipe(state.socketPath)) rmSync(state.socketPath, { force: true });
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
