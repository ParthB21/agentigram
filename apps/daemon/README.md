# @clankergram/daemon

**Owner:** Part 2

`clankergram` CLI + local daemon. M1 installs Claude Code hooks and a private, local-scoped MCP
server, receives hook events over a fail-open Unix socket, watches worktrees, reconnects to the room
coordinator, and restores every modified file exactly on `leave`.

## Commands

```bash
pnpm clankergram join hackathon
pnpm clankergram status
pnpm clankergram daemon --root /path/to/repo
pnpm clankergram leave

# Static macOS Electron shell; intentionally not wired to the daemon yet.
pnpm --filter @clankergram/daemon ui
```

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
  a preload boundary, CSP, and the standard macOS application lifecycle.
- `@parcel/watcher` 2.6.0 for native recursive worktree observation.

The hook payload fixtures are secret-free representations of the documented current shapes. Part 3
still owns `analysis.apiDelta` and `analysis.readSetFromFiles`; until those functions land, the daemon
continues emitting filesystem events and omits symbol enrichment rather than guessing.

See `CLAUDE.md` (repo layout, hard rules) and `spec.md` (source of truth).
