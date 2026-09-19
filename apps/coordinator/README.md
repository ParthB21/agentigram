# @agentigram/coordinator

**Owner:** Part 1

Cloudflare Worker routing `/room/:roomId` to one SQLite-backed Durable Object per room. **M1 (Spine) is
implemented**; leases, routing, negotiation (M2), persistence and auth (M3) and the LAN fallback (M4) are not.

## Versions (checked against the official docs and npm on 2026-09-19)

| Thing | Version | Note |
| --- | --- | --- |
| Wrangler | 4.135.0 | Needs Node ≥ 22. |
| `@cloudflare/vitest-plugin` | 1.1.13 | Replaces `@cloudflare/vitest-pool-workers` in the Cloudflare docs. Needs Vitest ≥ 4.1. |
| `@cloudflare/workers-types` | ^5.20260919.1 | |
| workerd (via Wrangler) | 1.20260918.1 | `compatibility_date` is `2026-09-01`. |

APIs used, per the current docs: `ctx.acceptWebSocket` + `webSocketMessage/Close/Error` (Hibernation),
`serializeAttachment` / `deserializeAttachment` (16 KiB), `ctx.getWebSockets()`, `ctx.storage.sql.exec`,
and `new_sqlite_classes` in the migration. Not used yet: alarms (`setAlarm`, needed for M2 lease expiry).

## Layout

| File | Role |
| --- | --- |
| `src/room-core.ts` | The room without the transport: seq, dedupe, authz, reducer, persistence, HELLO/replay, presence. Pure of Cloudflare, so it is tested in plain Node. |
| `src/room-do.ts` | Hibernation adapter over `RoomCore`; HTTP ingest; fan-out. |
| `src/worker.ts` | Routes `/room/:roomId[/ingest]`, `/health`. |
| `src/store.ts` | `EventStore`: in-memory, and SQLite (`events` with `seq` PK + `id` UNIQUE, and `snapshots`). |
| `src/authz.ts` | Who may submit what; constant-time secret compare. |
| `src/routing.ts` | Recipients per event (M1: audience filter only). |

## Run

```bash
cp .dev.vars.example .dev.vars      # gitignored; set real secrets for anything but local dev
pnpm --filter @agentigram/coordinator dev          # wrangler dev, http://localhost:8787
pnpm agentigram dev-connect --token dev-room-secret --room hackathon
```

`dev-connect`'s default token (`dev`) works only against the simulator. Against this coordinator pass
`--token <ROOM_SECRET>`.

## Test

Two Vitest projects: `core` (Node, fast) and `workers` (`*.do.test.ts`, runs inside workerd against the
real Durable Object). Both need Node 22 because of Wrangler.

## Protocol behaviour other parts rely on

- **HELLO** needs `token === ROOM_SECRET` (stub auth until M3). A bad token gets `ERROR UNAUTHORIZED` and a close.
- **WELCOME** carries state at head; `fromSeq` echoes the client's `lastSeq`; the gap follows in `EVENTS` batches of ≤ 200. A `lastSeq` ahead of the room replays from 0.
- **Daemons and workers never receive dashboard-only events, and their WELCOME state has `markets: {}`.**
- **Wire `HEARTBEAT`** is not an event; the coordinator logs a `HEARTBEAT` event for the session at most once per 10 s. A session is stale after 30 s without one.
- **Submit rules** (`authz.ts`): daemons cannot send `LEASE_GRANTED/DENIED/EXPIRED`, `RUN_VERIFIED`, `PERSONA_LINES`, `MARKET_*`, `TRADE`, worker results, or system-actor events; a daemon that named a session in HELLO can only speak for it. Dashboards may send only `TRADE`, `MARKET_OPENED`, `LEASE_RELEASED`, `ACCEPT`, `ESCALATE`, `TASK_CREATED`, as a human actor.
- **`POST /room/:roomId/ingest`** needs `Authorization: Bearer <WORKER_SECRET>` and accepts `SPEC_MERGE_RESULT`, `CI_RESULT`, `REVIEW_RESULT`, `CONTRACT_RESULT`, `CONTRACT_COMPILED`, `COLLISION` as system-actor events. Limit 64 KiB.
