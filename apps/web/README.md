# @clankergram/web

**Owner:** Part 4

Next.js dashboard. At M0 it is a shell: `/team/[teamId]` connects to the coordinator as a
`dashboard` client and prints the raw event stream.

- Next.js 16.3.5 (App Router), React 19.3, checked 2026-09-19.
- Coordinator URL: `NEXT_PUBLIC_COORDINATOR_URL` (default `ws://localhost:8787`); see `.env.example`.
- Every frame is parsed with `ServerMessageSchema` before use; malformed frames are dropped.

```bash
pnpm sim                                  # mock coordinator + scenario, in another terminal
pnpm --filter @clankergram/web dev        # http://localhost:3000/team/hackathon
```

See `CLAUDE.md` (repo layout, hard rules) and `spec.md` (source of truth).
