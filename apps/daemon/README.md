# @agentigram/daemon

**Owner:** Part 2

`agg` CLI + local daemon. It hosts or joins an encrypted P2P room, installs Claude Code or
Codex hooks and a private MCP server, watches the worktree, enforces leases before edits, injects
labelled peer context, and restores every modified configuration file on `leave`.

## Commands

```bash
npm run setup                       # once per clone; installs and links `agg`
agg create backend --host claude
agg join '<invite>' payments --host codex
agg start                           # Bare/Pear TUI; `agg tui` is equivalent
agg ui                              # native animated meeting room
agg status
agg leave
```

## Desktop meeting room

`agg ui` opens a packaged-app-style Electron room rather than a browser page. It renders each coding
agent as a stable participant tile, animates live activity and collision state, and provides dialogue
and read-only negotiation details in a glass meeting interface. System speech synthesis is
queued by priority; speaking indicators and captions follow the audio engine's real start, boundary
and end events instead of guessing from message arrival.

The renderer remains sandboxed with context isolation and no Node integration. Windows uses the
native Mica backdrop when available, macOS uses vibrancy, and other platforms retain the same CSS
glass treatment. Local agents are audible by default; remote agents start muted and can be enabled
individually from their tile.

Build a portable desktop archive for the current platform with:

```bash
npx pnpm@10.34.5 --filter @agentigram/daemon ui:make
```

The previous `pnpm agentigram ...`, `--root`, and `--session` forms remain supported.

## Verified external interfaces

Checked against official documentation on 2026-09-19:

- Claude Code hooks: common `session_id`, `transcript_path`, `cwd`, event-specific tool fields,
  `hookSpecificOutput`, `additionalContext`, permission decisions, and `stop_hook_active`. Local
  project hooks live in `.claude/settings.local.json`.
- Claude Code MCP: local scope is private and stored under the repository entry in
  `~/.claude.json`; the installed stdio command is restored byte-for-byte on leave.
- Claude Code OpenTelemetry: `CLAUDE_CODE_ENABLE_TELEMETRY`, `OTEL_METRICS_EXPORTER`,
  `OTEL_LOGS_EXPORTER`, `OTEL_EXPORTER_OTLP_PROTOCOL`, and `OTEL_EXPORTER_OTLP_ENDPOINT`.
- Claude Code headless mode: `-p` / `--print`, `--model`, and `--output-format` (`text`, `json`, or
  `stream-json`). Used by the M3 duel milestone, not M1.
- MCP TypeScript SDK 1.30.0: low-level `Server` request handlers with `StdioServerTransport`.
- Electron 38.8.6: secure `BrowserWindow` with context isolation, sandboxing, no Node integration,
  a narrow preload boundary, CSP, native Mica/vibrancy backdrops, and standard application lifecycle.
- Codex hooks: project `.codex/hooks.json`, command hooks for lifecycle/tool events, and the current
  `PreToolUse` permission-decision contract. Codex requires the generated hooks to be trusted.
- Pear/Holepunch modules: Hyperswarm 4.17.1, Corestore 7.12.5, Protomux 3.12.0 and
  compact-encoding 3.5.0. The full Pear runtime is not required.
- `@parcel/watcher` 2.6.0 for native recursive worktree observation.

The hook payload fixtures are secret-free representations of the documented current shapes, not
payloads captured from a live Claude Code session (capturing real ones is still open).

## Integration with Parts 1 and 3

- **Symbols:** `SymbolReader` (`src/symbol-reader.ts`) keeps one `@agentigram/analysis` `Indexer` per
  repo and turns a Read into symbol keys. The index is warmed at `SessionStart`, so a hook never pays for
  a cold TypeScript program; a repo with no `tsconfig.json` degrades to FILE_READ without symbols.
- **`apiDelta`** is still Part 3's M2 stub; the watcher logs it as unavailable and emits no `API_DELTA`.
- **Authority:** the room creator is the sole sequencer and lease authority. A capability-bearing
  invite authenticates peers; authority loss is a read-only safe pause.
- **Heartbeats** are events stamped `source: system`; the coordinator accepts that for `HEARTBEAT` only.
- **Platforms:** macOS and Linux use a Unix socket at `~/.agentigram/<repo-hash>.sock`; Windows uses a
  named pipe (`agentigram-<repo-hash>`), since Node cannot listen on a `.sock` file there.
- **Hook timeouts** in `.claude/settings.local.json` are whole seconds (the docs list integers); the
  300 ms PreToolUse budget is enforced by the hook process's own IPC timeout.

See `CLAUDE.md` (repo layout, hard rules) and `spec.md` (source of truth).
