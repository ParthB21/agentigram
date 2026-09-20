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
agg plan                            # who the orchestrator says owns what
agg plan --now                      # recompute and announce it immediately
agg leave
```

## Desktop meeting room

`agg ui` opens a packaged-app-style Electron room rather than a browser page. It renders each coding
agent as a stable participant tile, animates live activity and collision state, and provides dialogue,
negotiation and human-decision controls in a glass meeting interface. System speech synthesis is
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

## The orchestrator

Two parts, both authority-only, both using local Ollama with a deterministic fallback for every
answer, so a laptop with no model behaves the same way with plainer words.

- **Allocation** (`src/orchestrator/plan.ts`, `planner.ts`). Rebuilt on every change to the room's
  read and write sets: one owner per file, the contested ones leased, everyone else told to stay
  off. It publishes as `INTENT` (only for a session that has not declared one itself),
  `LEASE_REQUESTED` + `LEASE_GRANTED`, and one directed `MESSAGE` per agent at `automationDepth: 0`
  so a managed runner wakes on it. The announced intent is also what lifts a write from a tier-0
  overlap to a tier-1 `PREDICTED` collision, since `collide.ts` narrows a `FILE_WRITE` to the
  symbols that session declared.
- **Negotiation** (`src/orchestrator/orchestrator.ts`). On a tier-1+ collision it voices both sides
  through PROPOSAL / COUNTER / ACCEPT and compiles the contract. `freeze.ts` denies writes to the
  contested paths until the negotiation is `Accepted`.

The model may reorder ownership and write the prose; the file, symbol and avoid lists are
recomputed from observed state afterwards (CLAUDE.md rule 4), so a hallucinated path, session or
symbol key changes nothing.

| Variable | Effect |
| --- | --- |
| `AGENTIGRAM_ORCHESTRATOR` | `on` (default), `scripted` (no Ollama), `off` (neither part runs) |
| `AGENTIGRAM_PLANNER` | `off` keeps the collision debate but stops allocation |
| `OLLAMA_HOST` | default `http://127.0.0.1:11434` |
| `AGENTIGRAM_ORCH_MODEL` | default `llama3.2` |

## What the room sees of the shell

Hosts report their own edit tools and nothing else, so `packages/adapters/src/shell.ts` reads the
command line for writes — redirects, `tee`, `sed -i`, `mv`/`cp`/`rm`/`touch` — and names the git
subcommand that changed the tree. The repository's `prepare-commit-msg` hook calls
`agg git-event commit`, which publishes the staged paths; it is best-effort, always exits 0, and is
restored on `agg leave`.

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
