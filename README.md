# Agentigram

> Git knows what changed. Agentigram knows what everyone is trying to change — and what would break if it all landed right now.

**🏆 Winner: Best Use of Tether — Best Sovereign App** (Hack the North)

Coding agents are fast, and when several engineers each run one, they collide: one agent changes
`User.id` from `number` to a UUID string while another, on a different laptop, is still writing
checkout code against the old type. Nothing conflicts in Git until the damage is done.

Agentigram is a coordination layer for coding agents running on different engineers' laptops. It
observes what each agent reads and writes, works out which uncommitted changes would break each
other, has the agents negotiate a contract, compiles that contract into a check, and enforces it.

## Sovereign by design

There is no server to trust, rent or lose. Everything runs on the laptops in the room.

- **Peer-to-peer.** Laptops find each other over Hyperswarm using an encrypted invite. Room history is
  a single-writer Hypercore replicated to every peer. No cloud coordinator is needed.
- **On-device AI.** The room view is a [Pear](https://docs.pears.com) app built on Bare and
  [QVAC](https://qvac.tether.io). A local model drafts contracts, explains collisions and even speaks
  the room's messages aloud, with no API key and no network round-trip. Nothing to switch off when the
  venue wifi dies.
- **Your code stays yours.** Source and transcripts never leave the laptop. Only symbol keys, signature
  hashes and short signature text are shared, and every outbound payload passes a secret redactor.
- **Works with no model at all.** Every generated artefact has a deterministic fallback, so a laptop
  that never downloaded weights still sees and negotiates every collision.

## How it works

1. **Observe.** Hooks for Claude Code, Codex and Gemini CLI, plus MCP tools and a file watcher, record
   what each agent reads and writes, indexed by symbol.
2. **Detect.** Deterministic set intersection over the symbol index (no LLM) finds collisions:
   tier 0 same file, tier 1 same symbol, tier 2 semantic breakage such as a changed signature that
   another agent depends on.
3. **Allocate.** An orchestrator on the authority laptop assigns one owner per file, puts leases on
   contested ones, and briefs each agent on what it owns and must not touch. The second agent to reach
   a shared file is stopped at its own PreToolUse hook instead of discovered later in a merge. With
   local Ollama it writes the prose; without one it falls back to a deterministic allocation. Files,
   symbols and avoid-lists are always recomputed from what the room observed, so a hallucinated path
   changes nothing.
4. **Negotiate.** QVAC drafts a contract (`User.id: number → string (UUID v4)`, grammar-constrained so
   the JSON always parses). A proposal is only sent when a human presses <kbd>enter</kbd>, because
   it lands in a teammate's agent context on another machine.
5. **Enforce.** The accepted contract is compiled into a check and verified.
6. **Watch.** A native meeting-room UI and a web dashboard show the whole thing as live dialogue.

Content from other agents is always injected as labelled, length-capped peer data, never as
instructions, and agents never see presentation or market events.

## Quick start

Requires Node 22 or newer.

```bash
npm run setup          # install workspace + Pear deps, download the local model, link `agg`
```

Use `npm run setup -- --skip-model` to defer the ~0.74 GB model download. Run npm *scripts* at the
root, not `npm install`, which does not link the workspace packages.

```bash
agg create backend --host claude            # authority laptop; prints an invite
agg join '<invite>' payments --host codex   # every other laptop
agg start                                   # terminal room view (also `agg tui`)
agg run --autonomous --prompt 'Work on the assigned task'   # wake the coding agent on room messages
agg plan                                    # who owns what
agg status                                  # room/daemon health
agg speech-test                             # test on-device speech
agg leave                                   # stop and restore local host configuration
```

Every laptop must be a clone of the same Git repository; the invite carries a fingerprint of
`remote.origin.url`, and a clone with a different remote is refused. Codex hooks need a one-time
`/hooks` trust after `create` or `join`; for Gemini, trust the workspace and check `/hooks list`.

### Try it on one laptop

```bash
agg demo --scenario user-id-uuid --peers 4   # 4 peers, a plan, a lease denial, a tier-1 collision
agg ui                                       # native desktop meeting room
npx pnpm@10.34.5 dev                         # simulator + dashboard at localhost:3000
npx pnpm@10.34.5 check                       # typecheck, lint, tests
```

## Repo map

| Path | What |
| --- | --- |
| `apps/tui` | Bare/Pear room view: QVAC negotiation and speech, bare-tui, peer-to-peer OTA updates. Installs with npm. |
| `apps/daemon` | The `agg` CLI, P2P authority/peer runtime, agent hooks, MCP, watcher, collision detection, orchestrator, desktop room. |
| `apps/coordinator` | Transport-free room core, plus an optional Cloudflare Durable Object/WebSocket host. |
| `apps/web` | Next.js dashboard. |
| `apps/specmerge`, `apps/github` | Speculative-merge worker and GitHub App checks. |
| `packages/protocol` | Zod schemas for events, wire messages and room state; symbol keys; visibility rules. |
| `packages/reducer` | Pure `(state, event) → { state, effects }`. |
| `packages/p2p` | Hyperswarm discovery, Protomux control channel, Hypercore replication, invites. |
| `packages/adapters`, `packages/mcp` | Agent-host adapters, redaction, peer-data wrapping, MCP tools. |
| `packages/analysis`, `packages/contracts` | Symbol index, API deltas, contract compiler. |
| `packages/league`, `packages/stats`, `packages/personas` | Prediction league, model statistics, persona dialogue. |
| `packages/simulator`, `demo-repo` | Scripted scenarios with a mock coordinator, and the demo app they run against. |

## Operational notes

- The authority laptop is the only writer. If it disappears, peers keep their replicated history but
  become read-only; there is no automatic failover yet.
- An optional hosted Durable Object/WebSocket coordinator exists for setups that prefer a server.

## Credits

The room view is a fork of [`holepunchto/hello-pear-qvac-tui`](https://github.com/holepunchto/hello-pear-qvac-tui).
Several plumbing patterns (event visibility, adapter registry, redaction, restart supervision) were
adapted from [OpenAgents](https://github.com/openagents-org/openagents) (Apache 2.0); see
`docs/decisions.md`.
