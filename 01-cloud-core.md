# Prompt 1 — Cloud core (Part 1)

**Owner:** whoever takes Part 1. Run from the repo root after the bootstrap is merged. Works through M1 → M4; paste it once, then say "continue to the next milestone" as each one lands.

---

```text
You own Part 1 of Clankergram: the cloud core. Read CLAUDE.md, then these spec.md sections closely: Architecture, Tech stack, Coordination core, Collision detection pipeline → Routing, Negotiation and the contract ledger, Messaging and shared context, Security, Data model and event schema, Team split.

Your directories: packages/protocol, packages/reducer, packages/simulator, apps/coordinator. Do not edit anything else. If another part needs a protocol change, you own that change, but it goes through a PR the whole team reviews; only optional-field additions are allowed mid-milestone.

Your job is the single source of order and truth for a room: every event gets a seq, is applied by a pure reducer, and fans out to exactly the right recipients. Correctness beats features. Treat every inbound message as untrusted.

M1 — Spine
- apps/coordinator: Cloudflare Worker routing /room/:roomId to a SQLite-backed Durable Object. Use the WebSocket Hibernation API (acceptWebSocket, webSocketMessage, webSocketClose) and store per-socket attachment data (client kind, sessionId, lastSeq).
- Event log table in DO SQLite: seq INTEGER PRIMARY KEY, id TEXT UNIQUE, ts, type, actor JSON, payload JSON, causedBy. Dedupe on client id (return the original ACK).
- On HELLO: validate token (stub auth for now: a room secret from .dev.vars), send WELCOME with current RoomState and replay events after lastSeq, then stream.
- Rehydrate RoomState on DO wake by snapshot + replay (store a snapshot every N events).
- Presence from connections + HEARTBEAT; session goes stale after 30 s without heartbeat.
- HTTP POST /room/:roomId/ingest for workers (specmerge, github), authenticated with a separate worker secret, same validation path as WebSocket SUBMIT.
- Tests: use Cloudflare's Vitest pool for Workers (@cloudflare/vitest-pool-workers) — verify its current setup first. Cover ordering, replay after reconnect, dedupe, invalid payload rejection.
- Done when: two daemons (use the bootstrap dev-connect) and the dashboard see identical ordered streams after one of them disconnects and reconnects.

M2 — Leases, routing, negotiation (all in packages/reducer, pure)
- Leases: LEASE_REQUESTED → LEASE_GRANTED or LEASE_DENIED (overlapping symbols held by another live session). TTL default 10 min, renewed by heartbeat; expiry via a ScheduleAlarm effect that the DO turns into a Durable Object alarm, which submits LEASE_EXPIRED. Fencing token = the grant's seq. Session end releases its leases. Humans can override from the dashboard (a human-actor LEASE_RELEASED).
- Export checkWrite(state, sessionId, symbols, fencingToken?) → allow | deny{owner, leaseId, expiresAt, reason} from packages/reducer; Part 2's PreToolUse guard calls it. Serve it both from RoomState (the daemon keeps a local replica) and as a WebSocket request/response for freshness.
- Routing: compute recipients per event. Two audiences on the daemon side:
  - Symbol facts (INTENT, API_DELTA, FILE_WRITE) go to every other live daemon, because tiers 1–2 run inside each daemon against its own dependency graph (spec: "Other daemons intersect them with their own dependency graph"). These carry symbol keys and signatures only, never source.
  - Directed events (COLLISION, MESSAGE, PROPOSAL, COUNTER, ACCEPT, ESCALATE, contract events, CONTEXT_*) go only to participants: sessions named in the event, plus sessions whose recorded read set (from FILE_READ symbols) contains an affected symbol.
  - The daemon, not the coordinator, decides what actually gets injected into its agent.
  Symbol-less events (DISCOVERY without symbols) emit a RequestRelevance effect instead. Dashboards get everything. Never route anything for which isAgentVisible() is false to a daemon. Write a test that proves it.
- Collisions: accept COLLISION events from daemons/workers, merge duplicates by (symbols, writer), escalate tier when a higher tier confirms, and open a negotiation.
- Negotiation state machine exactly as in the spec diagram: Open → Proposed → Countered ↔ Proposed → Accepted → Compiled → Verified; Escalated on 3 rounds or 5 min. Participants = lease owner + affected sessions. Accepted requires every participant's ACCEPT. On Accepted emit RequestContractCompile; CONTRACT_COMPILED moves to Compiled; a passing SPEC_MERGE_RESULT/CONTRACT_RESULT moves to Verified.
- Contract ledger: versioned; a new accepted contract on the same symbol supersedes the old one.
- sync() view: a compact team-state projection (owners, leases, open collisions, contracts, discoveries) under ~2k tokens. Put the projection function in the reducer package so the daemon can render it locally.
- Tests: extend the user-id-uuid scenario so it asserts the whole flow: PREDICTED → SEMANTIC → Payments' write denied → PROPOSAL → ACCEPT ×2 → compile requested → Compiled → Verified. Add adversarial scenarios: stale owner with an old fencing token, duplicate ACCEPT, ACCEPT from a non-participant, lease expiry mid-negotiation, reconnect during negotiation.

M3 — Persistence, runs, auth
- PersistBatch effect → DO flushes to Supabase Postgres every few seconds (or on N events), idempotent on (room, seq). Write the SQL migrations for every table in spec.md "Postgres tables" under apps/coordinator/migrations. Postgres must never block the event path; failures retry with backoff and are visible in logs.
- ModelRun lifecycle in the reducer: created on SESSION_STARTED with a task, updated by COMPLETE_CLAIMED, CI_RESULT, CONTRACT_RESULT, human-intervention signals; emit RUN_VERIFIED when verifyRun(evidence) from @clankergram/contracts (Part 3) says so. Don't reimplement the definition.
- Import @clankergram/league (Part 4) to apply MARKET_* and TRADE events: validate trades against balances and close times inside the reducer, and auto-open markets on the triggering events listed in the spec. Coordinate the function signatures with Part 4 early.
- Auth: Supabase Auth JWT for dashboards and daemon join; the DO verifies the JWT and issues a per-session signing key at HELLO; daemons sign SUBMITs; the DO rejects events for sessions it didn't issue.
- Done when: the scenario runs end to end on deployed Cloudflare + Supabase and every event appears in Postgres exactly once.

M4 — Demo hardening
- Venue fallback: package the reducer + mock coordinator so one laptop can host the room on the LAN if Wi-Fi fails, with the same wire protocol. Document the switch in apps/coordinator/README.md.
- Load test: 4 daemons + 2 dashboards + 50 events/s for 10 minutes on one DO. Report p50/p99 fan-out latency.
- A /room/:roomId/export endpoint returning the event log as NDJSON (used for timeline replay and seeding demo data).

Throughout
- Keep the reducer pure; if you need time, it comes from the event's ts. Randomness is not allowed.
- Before coding against Durable Objects, Wrangler, or the Workers Vitest pool, check the current official docs and pin versions.
- After each milestone: run pnpm -r typecheck, pnpm lint, pnpm -r test, replay user-id-uuid against the deployed coordinator, then give me a short report of what works, what you tested, and any interface changes other parts must know about.

Start with M1. Show me a short plan first, then build.
```
