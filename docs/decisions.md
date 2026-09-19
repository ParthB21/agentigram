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
| Wrangler | 4.135.0 | not installed | Part 1 adds it. **Not verified:** the Durable Objects SQLite / WebSocket hibernation APIs were not checked; do that before writing `apps/coordinator`. |
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
- 2026-09-19 · part 2 · `ClaudeCodeAdapter` is a stub that throws `NotImplementedError` · hook payload shapes must be verified against current docs first (rule 10) and were not.
- 2026-09-19 · part 2 · `HealthTracker` reports an error only after 2 consecutive failures and reports recovery once · from `HEARTBEAT_ERROR_THRESHOLD` in `adapters/base.js`.
- 2026-09-19 · part 2 · `redactSecrets` ported from `adapters/utils.js` with the long-token catch-all made opt-in, `key=value` rules requiring `:`/`=` and not matching inside symbol keys, and structural fields (`path`, `symbols`, commit ids…) skipped · the original would redact 40-char commit SHAs and signature hashes that must leave the laptop.
- 2026-09-19 · part 2 · `wrapPeerData` truncates by whole lines, head and tail, and escapes `<peer-data` inside content · head/tail truncation is from `renderPinnedDecisions`; the escape closes a breakout hole the original did not have to consider.
- 2026-09-19 · part 2 · `Supervisor` follows the `daemon.js` restart loop (2 s → 60 s backoff, give up at 10) and resets the crash counter after a run stays up 60 s · the original never resets, so ten crashes over days would permanently stop the daemon.
- 2026-09-19 · part 2 · `CursorStore` persists `lastSeq` per room and `partitionStale` skips events older than 1 h when acting on a replay · from cursor persistence and `STALE_MESSAGE_MAX_AGE_MS`. The 24 h "ignore an old cursor" rule was not ported: WELCOME already carries current state.
- 2026-09-19 · part 2 · `buildToolDefs(disabled)` generates MCP tool definitions from protocol schemas · pattern from `mcp-server.js`; we do not hand-roll JSON-RPC, the official SDK will carry the transport.
- Not ported, on purpose: the workspace REST client, channels/threads/forum/wiki mods, Studio UI, launcher/TUI, per-host CLI subprocess adapters, and the Python SDK. They solve chat and agent hosting, not coordination.
