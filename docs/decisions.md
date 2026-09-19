# Decisions

One line per decision the spec did not make: `date · part · decision · why`. Newest last.

## M0 bootstrap (2026-09-19)

### Versions (checked with `npm view` on 2026-09-19)

| Tool | Latest | Pinned | Note |
| --- | --- | --- | --- |
| pnpm | 12.5.1 | 10.34.5 (`packageManager`) | Run through `corepack pnpm@10.34.5`; pnpm was not installed on the bootstrap machine. |
| Zod | 4.6.5 | ^4.6.5 | Native `z.toJSONSchema` is used, so `zod-to-json-schema` is not a dependency. |
| TypeScript | 7.0.2 | ~5.9.3 | Part 3 needs the TS compiler/language-service JS API; 7.x is the native port and its JS API is not a safe assumption. Revisit when Part 3 starts. |
| Vitest | 5.0.1 | ^4.1.11 | 5.x needs Node ≥ 22.12; the bootstrap machine has Node 20.20.2. Works on 22 too. |
| Biome | 2.5.14 | 2.5.14 | |
| Next.js / React | 16.3.5 / 19.3.0 | ^16.3.5 / ^19.3.0 | |
| ws | 8.21.3 | ^8.21.3 | |
| commander | 15.0.0 | ^14.0.3 | 15 needs Node ≥ 22.12; 14 needs ≥ 20. |
| pino | 10.3.1 | ^10.3.1 | |
| tsx | 4.23.13 | ^4.23.13 | Runs TypeScript for the simulator and the daemon dev launcher. |
| Wrangler | 4.135.0 | 4.135.0 (`apps/coordinator`) | Added in Part 1 M1; the Durable Objects SQLite and WebSocket Hibernation APIs were checked against the current docs then (see `apps/coordinator/README.md`). Needs Node ≥ 22. |
| `@modelcontextprotocol/sdk` | 1.30.0 | not installed | Part 2 adds it. `packages/mcp` has tool definitions and validation only. |

- 2026-09-19 · all · `.nvmrc` and `engines` say Node 22, but the bootstrap ran on Node 20.20.2 · Node 22 was not installed and the dependency choices above run on both. CI uses `.nvmrc`, so CI runs Node 22.
- 2026-09-19 · all · Internal packages export TypeScript source (`exports` → `./src/index.ts`) and `build` is `tsc --noEmit` · no build step between packages, so `pnpm sim`, Vitest and Next all see source directly. Publishing `npx clankergram` needs a bundled build; that is Part 2's job.
- 2026-09-19 · all · Root `pnpm-lock.yaml` is committed · CI needs a lockfile and CLAUDE.md only exempts the demo repo's; treat the root lockfile as the exception to flag in review.
- 2026-09-19 · part 4 · `apps/web` builds and runs with webpack (`next dev/build --webpack`) plus `extensionAlias` · Turbopack (Next 16 default) failed to resolve NodeNext `./x.js` imports to `./x.ts` in workspace packages.
- 2026-09-19 · all · `openagents-develop/` (reference checkout, ~2.9k files) is excluded from Biome and is not in the pnpm workspace globs · it is read-only reference material, not part of this repo's code.

### Protocol

- 2026-09-19 · part 1 · `COLLISION.tier` is `FILE_OVERLAP | PREDICTED | SEMANTIC | CONFIRMED | TEXTUAL` · the spec names the first four; "textual conflicts are reported as their own collision type" adds `TEXTUAL`.
- 2026-09-19 · part 1 · Wire messages are discriminated on `type` · the bootstrap prompt named the messages but not the field.
- 2026-09-19 · part 1 · `WELCOME.roomState` is state at head; `fromSeq` echoes the client's `lastSeq` and the `EVENTS` that follow are the gap after it · a fresh client gets state and full history, which the raw stream view wants.
- 2026-09-19 · part 1 · Payloads strip unknown keys instead of rejecting them · adding an optional field mid-milestone must not break older clients.
- 2026-09-19 · part 1 · `symbolKey(path, exportName, member?, kind)` is overloaded: `(path, name, kind)` and `(path, name, member, kind)` · TypeScript cannot put an optional parameter before a required one. Keys are validated on parse and build; paths are normalised to `/`.
- 2026-09-19 · part 1 · `SPEC_MERGE_RESULT.notRun` is `string[]` (tests skipped by the wall-time cap) · the spec says "report not run honestly".
- 2026-09-19 · part 1 · `MESSAGE.to` is a session id or `"all"`; `SESSION_STARTED` carries an optional `role` · the demo needs Frontend/Backend/Payments/Security labels.
- 2026-09-19 · part 1 · `MCP` tool inputs have length caps (text ≤ 2000 chars, ≤ 100 files/symbols) · peer-facing free text must be length-capped (rule 6).

### Reducer, simulator

- 2026-09-19 · part 1 · Reducing an event whose `seq` ≤ `state.lastSeq` is a no-op · replay from any offset is safe.
- 2026-09-19 · part 1 · The mock coordinator sends every agent-visible event to every daemon and worker · the reducer's routing is a TODO, and this keeps dashboard-only events away from agents until it lands. Replace with reducer routing.
- 2026-09-19 · part 1 · Workers get agent-visible events only; dashboards get everything · workers are not dashboards and never need markets or dialogue.
- 2026-09-19 · part 1 · The mock accepts any non-empty HELLO token · auth is Part 1's real coordinator.
- 2026-09-19 · part 1 · `pnpm sim` plays into room `hackathon` at server start (not on first connect) · late joiners get it through replay, which is what the reconnect behaviour must handle anyway.
- 2026-09-19 · part 1 · Scenario models are fixtures (`claude-opus-5`, `claude-sonnet-5`, `gpt-5`, `gemini-3-pro`); hosts are `claude-code`, `codex`, `gemini-cli` · four distinct models were required, not specific ones.

## OpenAgents port (2026-09-19)

Reference: `openagents-develop/` (OpenAgents, Apache 2.0). We took architecture and small algorithms, not code wholesale; see README → "Prior art: OpenAgents".

- 2026-09-19 · part 1 · Pattern matching and subscriptions (`matchesEventPattern`, `subscriptionMatches`) ported from `Event.matches_pattern` / `EventSubscription.matches_event` · visibility is checked before the pattern, so a `*` subscription cannot widen an agent's view to dashboard-only events.
- 2026-09-19 · part 1 · OpenAgents' six visibility levels collapse to two audiences (`agent`, `dashboard`) · that is the only distinction hard rule 5 needs.
- 2026-09-19 · part 2 · Adapter registry with degraded fallback (`createAdapter`, `HOST_CATALOG`) from `adapters/index.js` and `registry/*.json` · matches the spec's "a host with no hooks still works in degraded mode".
- 2026-09-19 · part 2 · `ClaudeCodeAdapter` is a stub that throws `NotImplementedError` · hook payload shapes must be verified against current docs first (rule 10) and were not. **Superseded:** implemented in Part 2 M1 (see below).
- 2026-09-19 · part 2 · `HealthTracker` reports an error only after 2 consecutive failures and reports recovery once · from `HEARTBEAT_ERROR_THRESHOLD` in `adapters/base.js`.
- 2026-09-19 · part 2 · `redactSecrets` ported from `adapters/utils.js` with the long-token catch-all made opt-in, `key=value` rules requiring `:`/`=` and not matching inside symbol keys, and structural fields (`path`, `symbols`, commit ids…) skipped · the original would redact 40-char commit SHAs and signature hashes that must leave the laptop.
- 2026-09-19 · part 2 · `wrapPeerData` truncates by whole lines, head and tail, and escapes `<peer-data` inside content · head/tail truncation is from `renderPinnedDecisions`; the escape closes a breakout hole the original did not have to consider.
- 2026-09-19 · part 2 · `Supervisor` follows the `daemon.js` restart loop (2 s → 60 s backoff, give up at 10) and resets the crash counter after a run stays up 60 s · the original never resets, so ten crashes over days would permanently stop the daemon.
- 2026-09-19 · part 2 · `CursorStore` persists `lastSeq` per room and `partitionStale` skips events older than 1 h when acting on a replay · from cursor persistence and `STALE_MESSAGE_MAX_AGE_MS`. The 24 h "ignore an old cursor" rule was not ported: WELCOME already carries current state.
- 2026-09-19 · part 2 · `buildToolDefs(disabled)` generates MCP tool definitions from protocol schemas · pattern from `mcp-server.js`; we do not hand-roll JSON-RPC, the official SDK will carry the transport.
- Not ported, on purpose: the workspace REST client, channels/threads/forum/wiki mods, Studio UI, launcher/TUI, per-host CLI subprocess adapters, and the Python SDK. They solve chat and agent hosting, not coordination.

## Part 1 · M1 Spine (2026-09-19)

- 2026-09-19 · part 1 · Workers tests use `@cloudflare/vitest-plugin` 1.1.13, not `@cloudflare/vitest-pool-workers` · the current Cloudflare docs name the plugin package; the prompt's package is the older name.
- 2026-09-19 · part 1 · Node 22.23.2 installed with nvm-windows; commands were run with it first on PATH, the machine's active Node stays 20 · Wrangler needs Node ≥ 22.
- 2026-09-19 · part 1 · `RoomCore` holds all room logic and is transport-free; the Durable Object is a thin adapter · most behaviour is testable in plain Node, and the same core can host the LAN fallback in M4.
- 2026-09-19 · part 1 · Wire `HEARTBEAT` becomes a logged `HEARTBEAT` event, throttled to one per session per 10 s · presence must be replayable and visible to dashboards, and hibernation loses in-memory state; the cost is at most 6 log rows/min/session.
- 2026-09-19 · part 1 · Stale = no heartbeat for 30 s (`sessionPresence`, pure, time passed in) · spec/prompt value.
- 2026-09-19 · part 1 · Daemons and workers get `markets: {}` in WELCOME · rule 5: agents never see markets, and `RoomState` includes them.
- 2026-09-19 · part 1 · Authorisation on submit (daemon / dashboard / worker allow and deny lists) beyond the prompt's stub auth · a daemon must not be able to forge `LEASE_GRANTED`, results, trades or system events. A daemon bound to a session in HELLO can only speak for it; multi-session daemons omit `sessionId` until M3 signing keys.
- 2026-09-19 · part 1 · Worker ingest also accepts `COLLISION` and `CONTRACT_COMPILED` · spec says workers post collisions (tier 3) and compile results; the prompt's list named only verification results.
- 2026-09-19 · part 1 · HELLO secret and ingest secret are separate (`ROOM_SECRET`, `WORKER_SECRET`) · a leaked daemon token must not allow posting CI or spec-merge results.
- 2026-09-19 · part 1 · Snapshot every 100 events, keeping only the latest · bounds wake-up replay; older snapshots have no use.
- 2026-09-19 · part 1 · Events are capped at 64 KiB (ingest and SUBMIT) and frames at 128 KiB · untrusted input.
- 2026-09-19 · part 1 · Not done in M1: a timeout for sockets that never send HELLO; the `/export` endpoint (M4); alarms (M2).
- 2026-09-19 · part 1 · `apps/coordinator` tsconfig loads `@cloudflare/workers-types` alongside `node` · needed for `DurableObject` and `WebSocketPair`; no type clashes appeared.

## Part 3 · M0/M1 Demo repo and symbol index (2026-09-19)

- 2026-09-19 · part 3 · TypeScript stays at 5.9.3 for `packages/analysis` (`typescript` is a dependency, `~5.9.3`) · the engine is built on the LanguageService and checker JS API; 7.x is the native port and that API is not a safe base. Recheck when 7.x documents a stable JS API.
- 2026-09-19 · part 3 · `readSetFromFiles(paths, index, atMs?)` takes the index as a required second argument · the stub had only `paths`, but resolving symbols needs an index. Optional `atMs` (default `Date.now()`) stamps the read.
- 2026-09-19 · part 3 · `RepoIndex` gained `modules` and `references`, and each symbol gained `kind`, `path`, `line` · needed for tier 1 (import closure) and for citing `file:line` in tier 2. `signature` and `signatureHash` are unchanged.
- 2026-09-19 · part 3 · Symbols are exports *declared* in a module; barrels and re-exports are followed to the declaring module · one key per symbol, and references through barrels resolve to it.
- 2026-09-19 · part 3 · Members are indexed for classes, interfaces, object-type aliases and enums, including inherited ones; statics are keyed `static$<name>`; explicit constructors are `Class.constructor` · symbol keys allow one `.`, and a subtype's surface includes what it inherits. A declaration node may carry several keys (`Base.id` and `Admin.id`).
- 2026-09-19 · part 3 · Private and `#private` members are not indexed; protected ones are · subclasses in other modules depend on protected members.
- 2026-09-19 · part 3 · Extraction re-runs over the whole program on each `index()`; only parsing is incremental (per-file versions on the LanguageService) · measured 0.3 s cold and 0.05 s warm on the demo repo, so per-file extraction caching is not worth its risk yet.
- 2026-09-19 · part 3 · `demo-repo` is a member of the root pnpm workspace with no lockfile of its own · keeps `pnpm -r typecheck/test` covering it. CLAUDE.md lets the demo repo commit a lockfile; do that only if the speculative-merge worker needs a standalone clone.
- 2026-09-19 · part 3 · Biome ignores `**/fixtures` · analysis fixtures contain deliberately odd code (private members, namespaces) and expected line numbers.
- 2026-09-19 · part 3 · Finding for Part 1: the `user-id-uuid` scenario has Frontend read `src/ui/profile.tsx`, which the demo repo lacks; a test in `packages/analysis` pins this as the only drift.

## Part 2 · M1 Observe merged (2026-09-19)

Branch `p2/laptop-observe-electron-shell` (one commit, `23f5a56`, by Pierce Luu) was fast-forwarded into `main`. It is Part 2's M1 only; M2 (leases, PreToolUse guard, delivery, MCP forwarding results), M3 (trailers, OTel receiver, context packets, duels) and M4 (doctor) are not started. It also adds a static Electron UI shell (`apps/daemon/ui`, `electron` 38.8.6) that prompt 2 does not ask for and that is not wired to the daemon.

- 2026-09-19 · part 2 · Reads are mapped to symbols through `SymbolReader` over `@clankergram/analysis`'s `Indexer` (index warmed at SessionStart; dirty files refreshed) · `readSetFromFiles` now needs the index, and a cold TS program must not consume a hook's 1 s budget.
- 2026-09-19 · part 2 · `join --token` / `CLANKERGRAM_TOKEN` carries the coordinator room secret; it is stored only in the 0600 install state, never in repo files · the real coordinator rejects a team code as HELLO token.
- 2026-09-19 · part 1 · Coordinator authz accepts a daemon `HEARTBEAT` with `source: system` (and nothing else with that source) · the daemon stamps its own liveness beat that way and the coordinator previously rejected it.
- 2026-09-19 · part 2 · Hook `timeout` values are integer seconds (PreToolUse was `0.3`) · the hooks docs list integers; a fractional value could invalidate the settings file. The 300 ms bound is still enforced by the IPC timeout.
- 2026-09-19 · part 2 · Adapter and watcher emit POSIX repo-relative paths on every OS · protocol paths and symbol keys are `/`-separated; the adapter test failed on Windows.
- 2026-09-19 · part 2 · On Windows the daemon IPC endpoint is a named pipe · Node cannot listen on a `.sock` path there, so the branch could not run on Windows at all.
- 2026-09-19 · part 2 · Not changed, left for the owner (found in review): (1) `leave` restores whole-file snapshots of `~/.claude.json` and `.claude/settings.local.json`, so anything Claude Code wrote there since `join` is lost; it should remove only its own keys unless the file is unchanged. (2) The watcher emits a second `FILE_WRITE` for every agent edit, and it can label agent edits as human because the agent-write window is filled only on PostToolUse; record intended paths at PreToolUse. (3) `join` snapshots the whole `~/.claude.json` into the install state. (4) Hook fixtures are not captured real payloads, and there is no live Claude Code run. (5) Git hook install assumes `.git` is a directory (linked worktrees have a file). (6) Watchers are per worktree root, keyed to the first session there, and never stopped.
