# demo-repo

**Owner:** Part 3

A small TypeScript app the demo is performed on and the other parts test against. Modules:

| Path | What |
| --- | --- |
| `src/types/user.ts` | `User` (`id: number`), `Role`, `NewUser` |
| `src/users/` | `UserRepository` (in-memory), `UserService` |
| `src/auth/` | `login`, demo-only tokens (`issueToken` / `verifyToken`), `AuthResponse` (includes `userId`) |
| `src/checkout/` | `checkout`, `FakeStripe` / `customerRef`, `CheckoutResponse`, `view-model.ts` (Frontend's UI type) |
| `src/security/` | `requireAuth`, `requireRole` middleware |
| `src/collaboration-lab/` | Multi-domain sandbox with 22 small files for multi-agent collision testing |

Each module has colocated Vitest tests (15 tests). Nothing here is production code: the tokens are not secure.

## Budgets (measured on the bootstrap machine, Node 22)

| | Budget | Measured |
| --- | --- | --- |
| `tsc --noEmit`, cold | < 10 s | ~1.0 s |
| `tsc --noEmit --incremental`, warm | < 3 s | ~0.8 s |
| `indexRepo` (analysis), cold / update + re-index | < 2 s warm | ~0.3 s / ~0.05 s |

```bash
pnpm --filter @agentigram/demo-repo typecheck   # incremental; cache in .cache/ (gitignored)
pnpm --filter @agentigram/demo-repo test
```

## Scripted demo tasks and the collision each produces

These claims are checked by `packages/analysis/src/demo-repo.test.ts` against the real code, not
written from memory. Line numbers below are today's; the tests find them by content.

### Backend: migrate `User.id` from `number` to a UUID `string`

Edits `src/types/user.ts` (and, to finish the job, `users/` and `auth/`).

- **Tier 1 (PREDICTED), on `INTENT` before any edit:** Payments, whose read set holds
  `src/types/user.ts#User.id:property` because `checkout.ts` references it.
- **Tier 2 (SEMANTIC), after the edit:** `User.id` `number → string`, breaking.
- **Tier 3 (CONFIRMED), speculative merge with only `User.id` changed:** 3 type errors in
  `src/checkout/checkout.ts`, one per use of `user.id`:
  - line 20 `chargeCustomer(user.id, …)` — TS2345, `string` is not assignable to `number`
  - line 21 `user.id * 1_000_000 + …` — TS2362, arithmetic on a `string`
  - line 24 `userId: user.id` — TS2322, `string` is not assignable to `number`

  Backend's own files break as well (`auth/login.ts` ×3, `users/repository.ts` ×2) plus 4 tests,
  which is why Backend must finish the migration inside its lease.
- Not flagged: Security. `middleware.ts` does not reference `User.id`.

### Payments: implement checkout for the authenticated user

Works in `src/checkout/checkout.ts`, `stripe.ts`, `types.ts`; has read `user.ts` and `checkout.ts`.

- Affected by Backend's change (above); its write to `src/types/user.ts` is denied by the lease.
- **Tier 2 against Frontend**, if Payments renames `CheckoutResponse.userId` (e.g. to `user_id`):
  `src/checkout/view-model.ts` line 14 (`response.userId`) breaks, and so does `checkout.ts` itself.
  Security is not affected.

### Frontend: checkout UI types

Owns `src/checkout/view-model.ts`, which reads `CheckoutResponse`.

- Collides only when `CheckoutResponse` changes (above). It never references `User.id`.

### Security: auth middleware review

Reads `src/security/middleware.ts` and `src/auth/token.ts`.

- Not touched by the `User.id` intent itself.
- **Tier 2** if Backend changes `verifyToken`'s return type or `issueToken`'s parameter (both are
  `number` today): `middleware.ts` calls `verifyToken`.

## Known gaps

- The simulator's `user-id-uuid` scenario has Frontend read `src/ui/profile.tsx`, which does not
  exist here. Part 3 does not own the simulator; the owner should point it at
  `src/checkout/view-model.ts`.
- The repo is a member of the root pnpm workspace and has no lockfile of its own. If the speculative-merge
  worker needs a standalone clone with a pinned lockfile, generate one then (CLAUDE.md allows this one).
