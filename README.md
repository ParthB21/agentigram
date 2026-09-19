# Clankergram

> Git knows what changed. Clankergram knows what everyone is trying to change — and what would break if it all landed right now.

Clankergram is a coordination layer for coding agents running on different engineers' laptops. It
observes what each agent reads and writes, computes which uncommitted changes would break each other
(up to a speculative merge + typecheck), makes the agents negotiate a contract, compiles that contract
into a check, and enforces it. A dashboard shows it all as live dialogue, tracks model performance and
runs a play-money prediction league.

- `spec.md` — the source of truth. Read it first.
- `CLAUDE.md` — repo layout, hard rules, conventions, who owns what.
- `docs/decisions.md` — every choice the spec did not make, with versions checked.
- `00-bootstrap.md` … `04-experience-metrics.md` — the prompts for M0 and for each of the four parts.

## Status

**M0 (bootstrap) is done; M1 has not started.** The scaffold, the protocol package (v0), a reducer
that handles session lifecycle, the simulator with the canonical scenario, and the OpenAgents-derived
daemon/adapter utilities all exist and are tested. Leases, collisions, negotiation, analysis,
contracts, the coordinator, the league, stats, personas and the real dashboard are stubs or
skipped-test checklists for Parts 1–4.

## Quick start

Needs Node 22 (`.nvmrc`) and pnpm 10. No Turborepo or Nx.

```bash
pnpm install
pnpm -r typecheck && pnpm lint && pnpm -r test

pnpm sim                                # mock coordinator on ws://localhost:8787, plays "user-id-uuid" into room "hackathon"
pnpm sim --scenario user-id-uuid --speed 4
pnpm clankergram dev-connect --session payments     # daemon side: connect and log events
pnpm --filter @clankergram/web dev      # dashboard: http://localhost:3000/team/hackathon
```

`pnpm sim` flags: `--scenario`, `--port` (8787), `--room` (`hackathon`), `--speed`, `--no-play`, `--list`.

## Repo map

| Path | Part | What |
| --- | --- | --- |
| `packages/protocol` | 1 | Zod schemas: event envelope, 42 payload types, wire messages, `RoomState`, symbol keys, visibility rules, MCP tool schemas. Shared contract. |
| `packages/reducer` | 1 | Pure `reduce(state, event) → { state, effects }`. Sessions, heartbeat and intent are implemented; the rest is a skipped-test checklist. |
| `packages/simulator` | 1 | Scenarios + mock coordinator (`/room/:roomId`). The `user-id-uuid` demo lives here. |
| `packages/adapters` | 2 | Agent-host adapter registry, health tracking, secret redaction, peer-data wrapper. |
| `packages/mcp` | 2 | MCP tool definitions and input validation, generated from protocol schemas. |
| `apps/daemon` | 2 | `clankergram` CLI, reconnecting room client, cursor persistence, process supervisor. |
| `packages/analysis`, `packages/contracts`, `apps/specmerge`, `apps/github`, `demo-repo` | 3 | Stubs with agreed signatures. |
| `packages/league`, `packages/stats`, `packages/personas`, `apps/web` | 4 | Stubs, plus a dashboard shell that prints the raw event stream. |
| `apps/coordinator` | 1 | Stub. The Durable Object lands here. |

## Prior art: OpenAgents

We studied [OpenAgents](https://github.com/openagents-org/openagents) (Apache 2.0), an open-source
"workspace" where many agents share threads, files and a browser. It solves a different problem —
agents talking to each other and to humans — and has no notion of code impact, leases or contracts.
Its architecture is still the best worked example we found of the plumbing Clankergram also needs:

| OpenAgents | Idea | In Clankergram |
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

## Known gaps

- Bootstrapped on Node 20 (no Node 22 on the machine); CI uses Node 22. See `docs/decisions.md`.
- The Claude Code adapter, Durable Objects/Wrangler usage and the MCP SDK integration are **not** written:
  their external APIs must be verified against current docs first (CLAUDE.md rule 10).
- `openagents-develop/` is a read-only reference checkout and should not be committed.
