# Agentigram

> Git knows what changed. Agentigram knows what everyone is trying to change — and what would break if it all landed right now.

Agentigram is a coordination layer for coding agents running on different engineers' laptops. It
observes what each agent reads and writes, computes which uncommitted changes would break each other
(up to a speculative merge + typecheck), makes the agents negotiate a contract, compiles that contract
into a check, and enforces it. A dashboard shows it all as live dialogue, tracks model performance and
runs a play-money prediction league.

- `spec.md` — the source of truth. Read it first.
- `CLAUDE.md` — repo layout, hard rules, conventions, who owns what.
- `docs/decisions.md` — every choice the spec did not make, with versions checked.
- `00-bootstrap.md` … `04-experience-metrics.md` — the prompts for M0 and for each of the four parts.

## Status

The Half 1 vertical slice is implemented: clean Agentigram naming, encrypted P2P rooms, a
single-writer replicated event history, authoritative leases and fencing, negotiation state,
deterministic routing, Claude Code, Codex, and Gemini CLI hooks, MCP tools, and a live macOS control
window.
The Durable Object/WebSocket coordinator remains available as an optional hosted transport.

## Quick start

Needs Node 22 (`.nvmrc`). If `pnpm` is not installed, use the pinned version through `npx`:

```bash
npx pnpm@10.34.5 install
npx pnpm@10.34.5 typecheck
npx pnpm@10.34.5 test

# One-laptop P2P smoke test
npx pnpm@10.34.5 agentigram demo --scenario user-id-uuid --peers 4

# Authority laptop (prints an agentigram:// invite)
npx pnpm@10.34.5 agentigram create --root . --session backend --host claude

# Second laptop, in a clone of the same Git repository
npx pnpm@10.34.5 agentigram join '<invite>' --root . --session payments --host codex

# Third laptop, using Gemini CLI (installs project hooks + Agentigram MCP automatically)
npx pnpm@10.34.5 agentigram join '<invite>' --root . --session frontend --host gemini --engineer alex

# Local transparent macOS window
npx pnpm@10.34.5 agentigram ui --root .
```

`pnpm sim` flags: `--scenario`, `--port` (8787), `--room` (`hackathon`), `--speed`, `--no-play`, `--list`.

## Repo map

| Path | Part | What |
| --- | --- | --- |
| `packages/protocol` | 1 | Zod schemas: event envelope, 42 payload types, wire messages, `RoomState`, symbol keys, visibility rules, MCP tool schemas. Shared contract. |
| `packages/reducer` | 1 | Pure `reduce(state, event) → { state, effects }`. Sessions, heartbeat and intent are implemented; the rest is a skipped-test checklist. |
| `packages/simulator` | 1 | Scenarios + mock coordinator (`/room/:roomId`). The `user-id-uuid` demo lives here. |
| `packages/p2p` | 1 | Hyperswarm discovery, Protomux control channel, Corestore/Hypercore event replication, room invites. |
| `packages/adapters` | 2 | Agent-host adapter registry, health tracking, secret redaction, peer-data wrapper. |
| `packages/mcp` | 2 | MCP tool definitions and input validation, generated from protocol schemas. |
| `apps/daemon` | 2 | `agentigram` CLI, P2P authority/peer runtime, Claude/Codex/Gemini hooks, MCP, watcher, secure Electron bridge. |
| `packages/analysis`, `packages/contracts`, `apps/specmerge`, `apps/github`, `demo-repo` | 3 | Stubs with agreed signatures. |
| `packages/league`, `packages/stats`, `packages/personas`, `apps/web` | 4 | Stubs, plus a dashboard shell that prints the raw event stream. |
| `apps/coordinator` | 1 | Shared authority core plus the optional Cloudflare Durable Object/WebSocket transport. |

## Prior art: OpenAgents

We studied [OpenAgents](https://github.com/openagents-org/openagents) (Apache 2.0), an open-source
"workspace" where many agents share threads, files and a browser. It solves a different problem —
agents talking to each other and to humans — and has no notion of code impact, leases or contracts.
Its architecture is still the best worked example we found of the plumbing Agentigram also needs:

| OpenAgents | Idea | In Agentigram |
| --- | --- | --- |
| Event model: hierarchical names, wildcard subscriptions, visibility levels | Everything is an event; delivery is filtered by pattern *and* visibility | `matchesEventPattern`, `subscriptionMatches`, `isAgentVisible` (`packages/protocol`) |
| Adapter registry (`adapters/index.js`, `registry/*.json`) | One adapter per agent host, looked up by name | `createAdapter`, `HOST_CATALOG`, degraded mode (`packages/adapters`) |
| `BaseAdapter` heartbeat threshold | Don't flap red on one blip | `HealthTracker` |
| `redactSecrets` | Scrub credentials from anything quoted or sent | `redactSecrets`, `redactPayload` (tightened for structured payloads) |
| Pinned decision log truncation | Fit context into a budget without cutting lines | `truncateLines`, `wrapPeerData` (labelled, capped, breakout-proof peer content) |
| `daemon.js` restart loop | Exponential backoff, give up after 10 crashes | `Supervisor` (counter resets after a healthy run) |
| Adapter cursor persistence and stale-message skipping | Resume after downtime without acting on old instructions | `CursorStore`, `partitionStale`, `RoomClient` resume via `HELLO.lastSeq` |
| `buildToolDefs` in `mcp-server.js` | Tool definitions as data, individually switchable | `buildToolDefs`, `parseToolCall` (`packages/mcp`) |

We did **not** copy OpenAgents source wholesale. The redaction patterns and the truncation approach
are adapted and rewritten in TypeScript; attribution: OpenAgents © its contributors, Apache-2.0.
Deliberately left out: its workspace REST API, channels/forum/wiki mods, Studio UI, launcher TUI,
per-host CLI subprocess bridges and Python SDK. Full mapping and deviations: `docs/decisions.md`.

## Operational notes

- The authority laptop is the only writer. If it disappears, peers keep their replicated history
  but become read-only; v1 does not elect a replacement automatically.
- Codex project hooks require review. Run `/hooks` in Codex after `create` or `join` and trust the
  generated Agentigram hook definitions.
- Gemini CLI hooks and the `agentigram` MCP server are merged into `.gemini/settings.json`. Start
  Gemini from the repository, trust the workspace, then verify them with `/hooks list` and
  `/mcp list`.
- Source and transcripts stay local. Outbound structured payloads are validated and redacted.
- `openagents-develop/` is a read-only reference checkout and is never committed.
