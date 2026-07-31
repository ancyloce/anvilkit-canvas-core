# `@anvilkit/canvas-core` — `src/` layer map

**Status:** living record. This file is the companion the layering gate cites.
**Gate:** `scripts/check-layering.mjs` (`pnpm check:layering`, part of `check:all`).
**Last updated:** 2026-07-30 (PLAN 0021 M0 — `uri.ts`, `policy-contracts.ts`,
`component-libraries/`, `brand-governance/` registered; `hash.ts` added to the
rank table it had been missing from).

## Why this file exists here

`check-layering.mjs` used to cite
`docs/architecture/canvas-core-src-layout-review.md`, which lives in the
**anvilkit-studio superproject**, not in this package. Because `canvas/core` is
a git submodule, that record does not ship with the package: a consumer who
clones this repository alone gets a gate that fails with a pointer to a file
they cannot open, and there is no way to satisfy the PRD §21 architecture
review checklist from inside the package.

This is open question **OQ-2** in
`docs/plans/0022-canvas-auto-layout-implementation-plan-0727-1310.md`.

**Resolution (M1, T-M1-07).** The gate now cites *this* file, which lives
beside the code it governs, so gate, code, and record ship and version
together. The superproject document is retained unchanged as the original
point-in-time *review* (its analysis, migration table, and rejected options are
history worth keeping); it is no longer the authority on current rank
assignments, and its §4 table had already drifted — it predates `limits.ts`,
`text-contracts.ts`, `clipboard/`, `comment-contracts.ts`, and `layout/`.

Split, stated plainly:

| Document | Owns | Lives in |
| --- | --- | --- |
| `canvas-core-src-layout-review.md` | the 2026-07 review: rationale, migration history, rejected options | superproject |
| **this file** | the **current** rank table the gate enforces | this package |

## Rank table (low → high)

A module may import strictly lower ranks, or its own domain. Anything else is a
gate failure. A source file matching no row **fails on purpose** — a new
top-level file or directory must be added here and to the gate, so its layer is
a conscious decision rather than an accident.

| Rank | Domains | May import |
| --- | --- | --- |
| 0 | `clock.ts`, `limits.ts`, `hash.ts`, **`uri.ts`** | nothing |
| 1 | `ir/` | rank 0 (+ `zod`) |
| 2 | `ai-contracts.ts`, `text-contracts.ts`, `geometry/`, `clipboard/`, `export/`, `comment-contracts.ts`, `components/`, **`policy-contracts.ts`** | ranks 0–1 |
| 3 | `commands/` | ranks 0–2 |
| 4 | `extensions/`, `templates/` (incl. `component-ops/`, folded in per plan 0023 D-1), `brand/`, `layout/`, **`component-libraries/`** | ranks 0–3 |
| 5 | `serialize/`, `ai-design-contracts.ts`, **`brand-governance/`** | ranks 0–4 |
| 6 | `index.ts` (root barrel) | domain barrels only |

Same-rank domains never import each other; the gate permits only
strictly-downward edges plus intra-domain ones.

### Notes on individual rows

- **`limits.ts` at rank 0** — every resource ceiling the package enforces, in
  one reviewable place. It must rank below `ir/` because `ir/walkers.ts`
  imports `MAX_TREE_DEPTH` from it, and it imports nothing itself.
- **`hash.ts` at rank 0** — deterministic string fingerprints, shared by
  `serialize/` (rank 5) and `layout/` (rank 4). Rank 4 cannot reach rank 5, so
  the shared algorithm has to sit below both.
- **`uri.ts` at rank 0** — the URI scheme allowlist, shared by `serialize/`
  (rank 5, `<image href>`) and `component-libraries/` (rank 4, Provider-supplied
  release-notes and thumbnail URLs). Same forcing argument as `hash.ts`:
  rank 4 cannot import rank 5, so the primitive moves to the floor rather than
  being duplicated. `serialize/svg.ts` re-exports `normalizeUri` /
  `isSafeDataImageUrl` / `NormalizeUriOptions`, so no importer changed.
- **`text-contracts.ts` at rank 2** — a host-implemented port over IR types,
  exactly like `ai-contracts.ts`; it reads `ir/` and nothing above.
- **`export/` at rank 2** — the headless export *job contract*. It defines
  types and a document-resolution helper; it never calls the rank-5
  serializers.
- **`brand/` at rank 4** — raised from 2 when `applyBrandColors` began wrapping
  its edits as a reversible `commands/` batch.
- **`serialize/` → `extensions/` must stay `import type`** — exporters read
  documents, they never edit them.

### `layout/` at rank 4 (PLAN 0022)

Registered in M1. The rank is forced by what the resolver needs (`ir/`,
`geometry/`, `text-contracts.ts`), and it forces four consequences the design
depends on:

1. **Layout commands stay in `commands/` (rank 3).** Rank 3 cannot import rank
   4, so `commands/` never calls the resolver — the composite layout commands
   take *caller-computed* geometry in their payload instead.
2. **`export/` (rank 2) cannot import layout diagnostics.** Export warnings are
   therefore mapped caller-side into the deliberately open
   `CanvasExportWarning.code` (`string`).
3. **`templates/` (rank 4) cannot import it either** — a same-rank sibling. A
   layout-aware `resizeToVariants` would need a renumber, so it is explicitly
   deferred rather than attempted.
4. **Persisted shapes do NOT live here.** `CanvasAutoLayout`,
   `CanvasLayoutItem`, `CanvasDocumentCompatibility`,
   `CanvasKnownCapability` and `CanvasLayoutMaterialization` are declared in
   `ir/types.ts` (rank 1), because `ir/validators.ts` must type the shape
   objects it spreads and `clipboard/` (rank 2) needs the capability type.
   Only *resolved-tree* contracts and the algorithm belong in `layout/`.

   The rule of thumb: **`layout/` owns the algorithm and its outputs; `ir/`
   owns the persisted shape.**

### `policy-contracts.ts` (2), `component-libraries/` (4), `brand-governance/` (5) — PLAN 0021

Registered in M0 (T-003, decision D-3), ahead of the first symbol in any of
them, so the ranks are a reviewed decision rather than a consequence of
whatever got written first.

- **`policy-contracts.ts` at rank 2** — the brand-policy decision *port*, a
  host-implemented contract over `ir/` types, exactly like `text-contracts.ts`.
  The rank is chosen for what it permits and what it forbids:
  `commands/` (rank 3) **can** import it, which is the only way a policy deny
  can be atomic with the mutation it blocks; `clipboard/` (rank 2) **cannot**,
  being a same-rank sibling, so clipboard/paste policy is enforced in the
  caller and `clipboard/payload.ts` stays policy-free by construction. Putting
  the port inside `brand-governance/` (5) instead would make it unreachable
  from `commands/` — the design would not work at all.
- **`component-libraries/` at rank 4** — canonicalization, integrity, the
  snapshot-key codec, admission, external resolution, and the six library
  commands. Forced upward by needing `ir/` (1), `components/` (2) for the local
  definition shapes, and `commands/` (3) for reversible batches.

  Two consequences, both pinned by `--self-test` cases:

  1. **`ir/` (rank 1) cannot import the snapshot-key Zod schema.** So the
     persisted registry shapes — `externalComponentSnapshots` and the
     validation asserting each key equals `snapshotKey(entry.ref)` — must be
     declared in `ir/` itself, precisely as `layout/` and `components/` already
     do for their persisted shapes. This is a real constraint on M1/T-014,
     which as written assigns that key schema to `component-libraries/`.
  2. **`clipboard/` (rank 2) cannot import it either**, so M2's optional
     `snapshotRefs` carry is validated caller-side.
- **`brand-governance/` at rank 5** — the shared command policy gateway and the
  component-aware compliance extensions. It composes `brand/` (4) and
  `component-libraries/` (4), two same-rank siblings that cannot reach each
  other, plus the rank-2 port — so it must outrank all three. Rank 5 alongside
  `serialize/`, with no dependency either way between them.

  Same rule of thumb as `layout/`: the gateway owns the *decision*, `commands/`
  owns the *rejection*, and `ir/` owns the persisted policy shape.

## Conventions

- **Cross-domain imports go direct-to-file, not through sibling barrels.** A
  domain's `index.ts` is its public face for the root barrel; keeping internal
  edges file-granular keeps the madge graph precise and makes barrel cycles
  impossible.
- **Domain barrels are curated where the domain has internals.**
  `serialize/index.ts` and `layout/index.ts` list names explicitly rather than
  `export *`, so a module exporting helpers for its own tests cannot leak them
  into the package's public API. `check:api-snapshot` reviews the result.
- `__tests__/` and `*.test.ts` are exempt importers.

## Changing a rank

1. Edit `LAYERS` in `scripts/check-layering.mjs`.
2. Update the table above in the same change.
3. Run `pnpm check:layering`, then `pnpm check:all`.

A rank change that is not reflected here will pass the gate and silently
invalidate this document — which is the failure mode OQ-2 was raised about, so
please do not reintroduce it.
