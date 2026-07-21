# Decision record — legacy `shadow` → `effects[]` without an IR version bump

Status: accepted (2026-07-18). Reconciles PRD 0012 §7.8 FR-077 / §9.4 with the
shipped implementation in `@anvilkit/canvas-core` and `@anvilkit/canvas-editor`.

## Decision

`CANVAS_IR_VERSION` stays at `"2"`. Legacy `shadow` fields are **not**
structurally rewritten to `effects[]` at the decode boundary. Instead the
packages use an explicit, tested **read-time normalization strategy**:

1. **One resolver.** `resolveNodeEffects(node)` in `src/ir/effects.ts` is the
   single source of effect truth. Every consumer — the SVG serializer, the
   editor's Konva renderer, thumbnails, and the inspector — resolves through
   it, so canvas, export, and UI can never disagree.
2. **Precedence.** A present `effects` array wins outright, including an
   *empty* one (`effects: []` means "explicitly no effects" — that is how an
   edit removes a legacy shadow without deleting history). Only when
   `effects` is absent does `shadow` apply, interpreted as a single
   spread-less drop shadow.
3. **Lazy per-node upgrade on write.** Any edit that touches a node's shadow
   writes the `effects` model and clears `shadow` (in `@anvilkit/canvas-editor`
   `src/panels/fill-shadow-fields.tsx`; in this package,
   `src/commands/apply-style.ts`). Documents therefore migrate per node, as
   they are touched, undoably.
4. **Decode stays non-structural.** `migrateCanvasIR` / `runtime.migrate` gate
   on `version` and validate; they do not rewrite nodes. Unknown keys are
   preserved (`looseObject` schemas).

## Why no version bump

- PRD 0012 §9.4 sanctions exactly this: "…or the new model must be introduced
  alongside it with a documented precedence — the existing shadow capability
  must not regress."
- PRD 0012 §15.11: "Canvas IR version must not change unless persisted
  structure requires migration (new optional fields use the existing
  loose-schema path)." `effects` is an additive optional field; every valid
  shadow-bearing v2 document remains valid.
- Version 2 documents with `shadow`-only nodes already exist in host storage
  (studio localStorage namespaces, IndexedDB recovery snapshots, collab
  payloads). A structural rewrite would require a 2→3 bump and would have to
  chase every decode-bypass path (hosts call `JSON.parse` on their own
  storage; `initialIR` is accepted pre-typed). Read-time resolution keeps all
  of those documents readable with no coordination.

## Behavior guarantees (all tested)

| Document state | Render/serialize behavior | Round trip |
| --- | --- | --- |
| only `shadow` | resolved as one spread-less drop shadow; SVG output byte-identical to the pre-effects serializer | `shadow` preserved verbatim; no `effects` injected |
| only `effects` | effects list rendered/serialized | preserved |
| both fields | `effects` wins; `shadow` ignored (never double-applied) | both fields preserved; precedence resolved at read time |
| `effects: []` | no effects (legacy shadow suppressed) | preserved |

Test anchors: `src/serialize/__tests__/effects.test.ts` (resolver precedence +
serializer for all four states, legacy byte-identical markup),
`src/ir/__tests__/shadow-effects-decode.test.ts` (decode-boundary stability,
non-structural migration, unknown-key preservation). In `@anvilkit/canvas-editor`:
`src/stage/__tests__/CanvasNodeRenderer.test.tsx` (Konva precedence),
`src/collab/__tests__/encode.test.ts` (encode/decode round trip).

## Consequences

- `CanvasShadow` stays in the schema indefinitely; new consumers must go
  through `resolveNodeEffects` and must not read `node.shadow` directly.
- A future structural migration (if ever needed, e.g. removing `shadow` from
  the schema) requires a 2→3 bump plus a node-walking migration step and an
  audit of decode-bypass paths (`plugin-canvas-studio` localStorage adapter,
  `@anvilkit/canvas-editor`'s `src/persistence/recovery.ts`, `initialIR`).
- `@anvilkit/canvas-editor`'s migration guide (`docs/migration.md`) documents
  the precedence for host developers.
