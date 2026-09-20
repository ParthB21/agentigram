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
- 2026-09-19 · all · Internal packages export TypeScript source (`exports` → `./src/index.ts`) and `build` is `tsc --noEmit` · no build step between packages, so `pnpm sim`, Vitest and Next all see source directly. Publishing `npx agentigram` needs a bundled build; that is Part 2's job.
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
- 2026-09-19 · part 1 · **Superseded by Half 1:** the simulator now consumes the reducer's deterministic session routing; workers and explicit session-less observers still receive every agent-visible event.
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
- 2026-09-20 · half 1 · Each laptop renders only its local coding agent's fresh speech by default; QVAC stays invisible and remote voices are opt-in · prevents duplicate room audio while preserving per-agent attribution.
- 2026-09-20 · half 1 · The authority voices the whole roster, a peer still only its own agent · the orchestrator negotiates on behalf of agents whose laptop is not in the room, so the local-only default made the debate it was conducting inaudible on the one machine running it; duplicate audio is still impossible because exactly one laptop is the authority.
- 2026-09-20 · half 1 · Speech is attributed to the session id, and to `agentigram` where the line has no session · the speaker is both the mute key and the voice hash seed, so the persona role made a line unmutable from its own agent row and gave it a different voice on each laptop.
- 2026-09-20 · half 1 · The TUI claims the next speaker when synthesis starts, not when audio does, and loads the voice model at launch · synthesis takes seconds, so an indicator driven by playback names a speaker who is already mid-sentence.
- 2026-09-20 · half 1 · Presence is speakable, in the arriving agent's own voice, and deduplicated against the room state before the event · an arrival means that agent's writes can now collide with yours, while its reads and tool calls remain telemetry; a session ends twice whenever its farewell is followed by the authority noticing the socket close.
- 2026-09-20 · half 1 · "Voice the whole room" is a flag on the authority, not a set of known sessions · an agent's first event is its own arrival, which reaches the view before the room state listing it, so a roster would silence every agent exactly as it joined.
- 2026-09-20 · half 1 · Continuous Codex/Claude wakeups require the explicit `agg run --autonomous` process · keeps unattended execution opt-in and independently stoppable from the room view.
- 2026-09-19 · part 1 · Events are capped at 64 KiB (ingest and SUBMIT) and frames at 128 KiB · untrusted input.
- 2026-09-19 · part 1 · Not done in M1: a timeout for sockets that never send HELLO; the `/export` endpoint (M4); alarms (M2).
- 2026-09-19 · part 1 · `apps/coordinator` tsconfig loads `@cloudflare/workers-types` alongside `node` · needed for `DurableObject` and `WebSocketPair`; no type clashes appeared.

## Agentigram Half 1 · P2P authority (2026-09-19)

- 2026-09-19 · half 1 · Clean-break rename from the former project name to Agentigram, including package scope, CLI, runtime directory, hook names, UI and Pages base path · no aliases or migration layer are carried.
- 2026-09-19 · half 1 · A designated authority laptop is the only event writer and human escalation authority · leases require a stable total order; automatic election would allow split-brain writes.
- 2026-09-19 · half 1 · Hyperswarm/Protomux is the encrypted control plane and Corestore/Hypercore is the replicated history plane · Pear modules are useful independently, so the Electron daemon does not migrate to the full Pear runtime.
- 2026-09-19 · half 1 · Autobase is not used for v1 authority state · eventual multi-writer reordering is incompatible with fencing-token and first-claim semantics.
- 2026-09-19 · half 1 · Authority loss moves peers to `read-only`; no lease, human action or event submission is accepted until reconnect · safe pause is preferable to silent divergence.
- 2026-09-19 · half 1 · Room invites include repository fingerprint, authority Noise key, event-core key and a random 256-bit capability · the fingerprint prevents accidental cross-repository joins and the capability gates the control channel.
- 2026-09-19 · half 1 · Claude Code and Codex are both hook-native adapters; Codex uses project `hooks.json` plus project `config.toml` MCP config and requires explicit `/hooks` trust · matches current official Codex hook behavior.
- 2026-09-19 · half 1 · Protocol changes are additive only: optional write fencing token, lease grantee/TTL, session read/write sets and negotiation deadline · existing scenario fixtures and other-half packages continue to parse.
- 2026-09-19 · half 1 · The Cloudflare Durable Object remains an optional adapter over the same `RoomCore` · preserves the existing tested hosted path without making it the primary architecture.
- 2026-09-19 · half 1 · The macOS Electron window exposes only five narrow preload methods; renderer Node integration stays disabled and sandboxing/context isolation remain enabled · live local status does not justify a privileged renderer.

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

Historical section; the Half 1 P2P implementation above supersedes its remaining-work statements and wires the Electron shell to the daemon.

Branch `p2/laptop-observe-electron-shell` (one commit, `23f5a56`, by Pierce Luu) was fast-forwarded into `main`. It is Part 2's M1 only; M2 (leases, PreToolUse guard, delivery, MCP forwarding results), M3 (trailers, OTel receiver, context packets, duels) and M4 (doctor) are not started. It also adds a static Electron UI shell (`apps/daemon/ui`, `electron` 38.8.6) that prompt 2 does not ask for and that is not wired to the daemon.

- 2026-09-19 · part 2 · Reads are mapped to symbols through `SymbolReader` over `@agentigram/analysis`'s `Indexer` (index warmed at SessionStart; dirty files refreshed) · `readSetFromFiles` now needs the index, and a cold TS program must not consume a hook's 1 s budget.
- 2026-09-19 · part 2 · `join --token` / `AGENTIGRAM_TOKEN` carries the coordinator room secret; it is stored only in the 0600 install state, never in repo files · the real coordinator rejects a team code as HELLO token.
- 2026-09-19 · part 1 · Coordinator authz accepts a daemon `HEARTBEAT` with `source: system` (and nothing else with that source) · the daemon stamps its own liveness beat that way and the coordinator previously rejected it.
- 2026-09-19 · part 2 · Hook `timeout` values are integer seconds (PreToolUse was `0.3`) · the hooks docs list integers; a fractional value could invalidate the settings file. The 300 ms bound is still enforced by the IPC timeout.
- 2026-09-19 · part 2 · Adapter and watcher emit POSIX repo-relative paths on every OS · protocol paths and symbol keys are `/`-separated; the adapter test failed on Windows.
- 2026-09-19 · part 2 · On Windows the daemon IPC endpoint is a named pipe · Node cannot listen on a `.sock` path there, so the branch could not run on Windows at all.
- 2026-09-19 · part 2 · Not changed, left for the owner (found in review): (1) `leave` restores whole-file snapshots of `~/.claude.json` and `.claude/settings.local.json`, so anything Claude Code wrote there since `join` is lost; it should remove only its own keys unless the file is unchanged. (2) The watcher emits a second `FILE_WRITE` for every agent edit, and it can label agent edits as human because the agent-write window is filled only on PostToolUse; record intended paths at PreToolUse. (3) `join` snapshots the whole `~/.claude.json` into the install state. (4) Hook fixtures are not captured real payloads, and there is no live Claude Code run. (5) Git hook install assumes `.git` is a directory (linked worktrees have a file). (6) Watchers are per worktree root, keyed to the first session there, and never stopped.

## Pear / QVAC (Tether track)

- 2026-09-19 · half 1 · **Reverses the 2026-09-19 decision above not to adopt the Pear runtime.** The room view is now a Bare/Pear app (`apps/tui`) forked from `holepunchto/hello-pear-qvac-tui`, and on-device QVAC inference is how collisions are explained and contracts drafted · the Tether track requires that repository as a core part of the app, and a coordination layer whose only intelligence is a cloud agent is not a sovereign app.
- 2026-09-19 · half 1 · Hybrid split: Bare hosts the TUI, the QVAC worker and the Pear OTA updater; the Node daemon keeps Hyperswarm, Hypercore, the agent hooks and the TypeScript analysis, and the two talk over the existing local IPC socket · `packages/analysis` is built on the TypeScript compiler API, which does not run under Bare; porting it would have cost the whole detection tier for no gain.
- 2026-09-19 · half 1 · `apps/tui` installs with npm and is excluded from the pnpm workspace (`!apps/tui`) and from Biome · `bare-pack`/`bare-build` resolve modules and native addons by statically traversing `require()` and `require.addon.resolve()`, which pnpm's symlinked store breaks.
- 2026-09-19 · half 1 · `bare-runtime` moved from the boilerplate's pinned 1.29.4 to `^1.33.4` · `@qvac/inference` declares `engines.bare ^1.30.3`, and 1.29.4's bundled `bare-semver` throws on a caret range rather than reporting a mismatch.
- 2026-09-19 · half 1 · The contract is generated before the explanation, and the explanation is prompted with the contract · asked to explain a collision cold, `LLAMA_3_2_1B` invents a mechanism (databases, caches, columns that were never mentioned); given the contract it only has to rephrase. Every artefact keeps a deterministic fallback, so a laptop with no weights still negotiates.
- 2026-09-19 · half 1 · Contract generation uses QVAC's `json_schema` response format, with `additionalProperties: false` and `required` written out · llama.cpp compiles the schema to GBNF and enforces it during generation; the SDK accepts `strict` only for OpenAI compatibility and does not apply its auto-tightening semantics.
- 2026-09-19 · half 1 · `PROPOSAL` from the on-device model is sent only on a keypress; the explanation travels as dashboard-only `PERSONA_LINES` · a proposal lands in a teammate's agent context on another laptop, and a 1B model's prose is not something to inject into an agent unreviewed (hard rule 6).

## Detection, symbols and replication (found while wiring the above)

- 2026-09-19 · part 2/3 · Tier 0/1 collision detection added as `apps/daemon/src/collide.ts`, run from `AuthorityTransport.publish` · nothing in the repo emitted `COLLISION`: the reducer consumed it, the daemon routed it to agents, and `packages/analysis`'s `fileOverlap` existed, but no producer joined them. Running it at the single writer opens each collision once for the room.
- 2026-09-19 · part 2 · `collide.ts` counts only the *read* sets of other sessions for tier 0 · the reducer's `applyFileWrite` already opens a `FILE_OVERLAP` for write-vs-write, and counting it again produced two collisions for one overlap.
- 2026-09-19 · part 2 · `FILE_READ` now carries symbols, resolved through the existing `SymbolReader` · `SymbolReader.read()` was never called from anywhere, so `readSymbols` was always empty and the tier-1 `PREDICTED` path was unreachable. A `FILE_WRITE` carries no symbols of its own, so a write is narrowed to the symbols that session announced for that file.
- 2026-09-19 · part 1 · `P2PRoomTransport.replay` resets its cursor when the replicated history is shorter than the cursor · after an authority recreates a room, the persisted per-room cursor points past the end of a history that no longer exists, and the peer sits `connected` and permanently empty because every event is filtered as already seen.
- 2026-09-19 · part 2 · `verifyHost` spawns with `shell: true` on Windows · `claude`/`codex`/`gemini` install as `.cmd` shims that `CreateProcess` cannot resolve from a bare name, so every Windows laptop failed the check with the agent on its PATH.
- 2026-09-19 · part 2 · The daemon IPC line reader consumes each complete line and keeps the remainder · it previously re-fired on the first newline for every chunk without draining the buffer, which a long-lived subscriber would have turned into duplicate deliveries.
- 2026-09-19 · half 1 · `AuthorityTransport.submitAsAuthority` submits with a `system` origin for the types authz marks coordinator-authored (`COLLISION`, `PERSONA_LINES`) · the authority *is* the coordinator, and submitting its own detections as a `daemon` was rejected by its own authz. On a peer, `narrate` stays local rather than failing.
- 2026-09-19 · half 1 · `apps/tui` pins `bare-module` to `^7` with an npm `overrides` block · Bare 1.33.4 bundles bare-module 7, whose `Addon.resolve` calls `protocol.postresolve`, but `bare-worker`/`bare-sidecar`/`lunte` all resolve `bare-module ^6`, which has no such method. The npm copy shadows the bundled one inside a worker thread, so `pear-runtime.run()` died with `defaultProtocol.postresolve is not a function` — only in the worker, which is why `npm run warm` (no worker) passed and the TUI did not. Downgrading `bare-runtime` instead is not open: `@qvac/inference` requires `bare ^1.30.3`.
- 2026-09-19 · half 1 · `warm` and the TUI accept `--model-src` (a path or URL, skipping the registry) and `--fallback-src` · QVAC's model registry is peer-to-peer and fails on locked-down networks, reported as "Could not download … (File descriptor could not be locked)". Deleting `~/.qvac/registry-corestore` clears the common stale-lock case; the flags cover a network where the registry is genuinely unreachable.
- 2026-09-19 · half 1 · `scripts/bare.mjs` and the CLI's `bareBinary()` restore the exec bit on the Bare binary · it ships inside a per-platform package (`bare-runtime-darwin-arm64` and friends) as a plain file rather than a declared `bin`, so npm leaves it non-executable as a nested dependency and macOS/Linux fail the spawn with EACCES. Windows is unaffected, which is why it only appeared on a teammate's Mac.
- 2026-09-20 · part 1 (daemon) · Collision orchestrator (`apps/daemon/src/orchestrator/`) runs on the authority, voices both agents' PROPOSAL/COUNTER/ACCEPT turns from their declared intents (local Ollama, scripted fallback), and stamps them `source: 'system'` · the protocol already models the negotiation and TTS already speaks those events, so no protocol change; the agents' own live reasoning is not used.
- 2026-09-20 · part 1 (daemon) · Collision freeze is a pure check in the PreToolUse path (`freezeDenial`), lifted when the negotiation is `Accepted`, not when the collision is `resolved` · `resolved` waits for a speculative merge that may not run locally; tier 0 (`FILE_OVERLAP`) never freezes and never debates; collisions with no symbols are not debated (a contract needs a symbol).
- 2026-09-20 · part 1 (daemon) · Orchestrator turns are the LLM's drafting of a contract and its explanation, on-device, with a deterministic fallback for every turn · fits rule 4's allowance; env `AGENTIGRAM_ORCHESTRATOR=off|scripted|on`, `OLLAMA_HOST`, `AGENTIGRAM_ORCH_MODEL` (default `llama3.2`). Ollama `/api/chat` `format` (JSON schema) was written from memory of the API, not checked against current docs (rule 10).
- 2026-09-20 · part 1 (daemon) · Work allocation (`apps/daemon/src/orchestrator/plan.ts`, `planner.ts`) runs on the authority and publishes itself as existing payloads only — `INTENT` per silent session, `LEASE_REQUESTED`+`LEASE_GRANTED` on contested files, one directed `MESSAGE` per agent at `automationDepth: 0` · the protocol is frozen (rule 1) and every one of those already routes, reduces, renders and enforces; a `PLAN` payload would have needed a reducer case, a routing case, an `ACTIONABLE_TYPES` entry and a dashboard change to say the same thing.
- 2026-09-20 · part 1 (daemon) · The planner's model may reorder ownership and write the prose; `composePlan` recomputes files, symbols and the avoid list from observed state afterwards · rule 4 keeps detection deterministic, and a 1–3B local model reliably invents session ids, paths and symbol keys. A preference is honoured only for a session that has already touched the file, and never against a live lease.
- 2026-09-20 · part 1 (daemon) · The planner ignores open `FILE_OVERLAP` collisions when deciding whether the room is mid-negotiation · tier 0 is advisory and is never negotiated, so waiting on one would silence the planner exactly when two agents share a file, which is when it is needed.
- 2026-09-20 · part 1 (daemon) · The planner grants a lease as two events (`LEASE_REQUESTED` as the session, then `LEASE_GRANTED` with `leaseId` `<roomId>:<seq>` and `fencingToken` = that seq) · `RoomCore.derive` skips a `system` origin, so `submitAsAuthority` alone would never produce the grant; reproducing both events keeps a planned lease indistinguishable from a requested one for `editDenial`, `validateFencing` and specmerge.
- 2026-09-20 · part 2 · Shell commands are read for writes (`packages/adapters/src/shell.ts`): redirects, `tee`, `sed -i`, `mv`/`cp`/`rm`/`touch`, and tree-changing `git` subcommands become `FILE_WRITE` plus a named `TOOL_CALL` · an agent editing through the shell was invisible to collision detection, and `git commit` survived only as a 240-character display string. Anything with a glob, a variable or a substitution is dropped rather than guessed: a wrong path here becomes a wrong collision.
- 2026-09-20 · part 2 · The installed `prepare-commit-msg` hook now calls `agg git-event commit`, which publishes the staged paths · it was an inert passthrough, and a commit is the one change no agent host reports. It stays best-effort and always exits 0, so it can never fail a commit, and `agg leave` still restores the original byte for byte.
