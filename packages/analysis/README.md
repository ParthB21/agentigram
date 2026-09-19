# @clankergram/analysis

**Owner:** Part 3

The code-analysis engine: symbol index, read sets, tier 0 file overlap, and (M2) API delta, intent
resolution and impact assessment. Runs inside Part 2's daemon. Tiers 0–2 are deterministic and use
no LLM; the only LLM call allowed here is the marked fallback in `resolveIntent` (M2, not written yet).

**TypeScript 5.9.3** (LanguageService / checker API). Not 7.x: its JS API is not stable enough to
build on (see `docs/decisions.md`).

## What exists (M0/M1)

| API | Notes |
| --- | --- |
| `indexRepo(root)` | Cold index of a repo (reads its `tsconfig.json`). |
| `new Indexer(root)` | Long-lived. `update(path, text \| null)` feeds an edit or a git blob without touching disk; `refreshFromDisk(paths)` is the watcher path; `index()` re-indexes. TypeScript re-parses only touched files. |
| `readSetFromFiles(paths, index, atMs?)` | Keys defined in or referenced by those files. |
| `fileOverlap(a, b)` | Tier 0: pure path intersection. |
| `importClosure(index, paths)`, `dependentsOf(index, paths)` | Tier 1 closure; test selection for specmerge. |

`RepoIndex` = `modules`, `symbols` (key → kind, path, signature, 16-char hash, line), `imports`
(module → modules), `references` (module → `{key, line}` of external symbols it uses).

### What is a symbol

Exports *declared* in a module (re-exports and barrels are followed to the declaring module), plus:
members of classes, interfaces, object-type aliases and enums (inherited members included, since
they are part of the subtype's surface); explicit constructors (`Class.constructor`); static members
(`Class.static$name`). Left out: private / `#private` members, anything from lib or `node_modules`,
union-type aliases' members. Keys come from `symbolKey` in `@clankergram/protocol`.

### Signatures

`checker.typeToString` with fixed flags (no truncation, arrow-style signatures, single quotes), so the
text is the same on every machine and unaffected by formatting. Properties print as
`[readonly ]name[?]: type`; enum members as `Name = value`.

### References

An identifier counts when it resolves (through aliases, barrels and re-exports) to an indexed
declaration in **another** module. Also handled: object literals typed through their contextual type
(`{ id: 1 }` as `User`) and destructuring (`const { id } = user`). One declaration can carry several
keys: a use of `Base.id` is also a use of `Admin.id`.

## Interface notes for Part 2

- `readSetFromFiles` takes the index as its second argument (the stub had only `paths`); it needs one
  to resolve symbols. `atMs` defaults to `Date.now()`; pass it explicitly to stay deterministic.
- `RepoIndex` grew (`modules`, `references`, per-symbol `kind`/`path`/`line`); `symbols[key].signature`
  and `.signatureHash` are unchanged.
- `apiDelta`, `resolveIntent` and `assessImpact` still throw `NotImplementedError` (M2).

## Measured (demo repo, this machine)

Cold index ~0.3 s; edit + re-index ~0.05 s. Budgets are asserted in `demo-repo.test.ts` (2 s warm,
10 s cold) and timings are logged with `[timing]`.

## Limits

- Dynamic `import()` and `require()` are not part of the import graph.
- Extraction re-runs over the whole (small) program on each `index()`; only parsing is incremental.
  Revisit if a real repo blows the budget.
- Only TypeScript. Other languages are a degraded tree-sitter mode later (M4, if time allows).
