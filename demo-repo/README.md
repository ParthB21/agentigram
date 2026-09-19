# demo-repo

**Owner:** Part 3

Placeholder. Part 3 builds a small TypeScript app here (auth, users, checkout) used for the demo and
for tests. It must be sized for a sub-20 s typecheck and contain the `User.id` / `checkout.ts`
dependency that the `user-id-uuid` scenario (`packages/simulator`) depends on.

The scenario already names the paths it expects:

- `src/types/user.ts` — `User.id` (`number` today, UUID `string` after the migration)
- `src/checkout/checkout.ts` — reads `user.id`; the speculative merge reports errors here

It is the only place a lockfile may be committed (CLAUDE.md, Git workflow). See `spec.md` → Team split.
