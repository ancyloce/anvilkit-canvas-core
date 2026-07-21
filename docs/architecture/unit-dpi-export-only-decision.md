# Decision record — Unit/DPI stay export-time-only (OD-1)

Status: accepted (2026-07-20, formalizing a decision already in effect since
the PRD 0012 Phase 1b kickoff). Resolves PRD 0012 §7.6 FR-063's open schema
question and the §12 ruler-legend dependency on it.

## Decision

`CanvasPageSize.unit` (`"px" | "mm" | "in"`) and `CanvasPageSize.dpi`
(optional) are **export-time concerns only**. They are not user-editable in
the Page Settings UI, and no command mutates them at runtime:

1. **Schema.** `unit` is a required field, `dpi` optional, both validated by
   `CanvasPageSizeSchema` (`src/ir/validators.ts`). They persist on every
   page's `size` object like `width`/`height`.
2. **Consumers.** `unitToPx` (`src/serialize/svg.ts`) and `unitToPt`
   (`src/serialize/pdf.ts`) convert `width`/`height` to output pixels/points
   at export time. No editor rendering, layout, or interaction path reads
   `unit`/`dpi`.
3. **Page Settings UI** (`@anvilkit/canvas-editor`'s
   `src/pages/PageSettingsDialog.tsx`) exposes Width/Height (always in `px`),
   Background, Orientation, Size preset, and Resize mode. It has no unit
   selector and no DPI field.
4. **`page.resize`** (`src/commands/runtime.ts`) changes `width`/`height`
   only; it explicitly preserves the page's existing `unit` unchanged and
   never touches `dpi`. There is no `page.set-unit` or `page.set-dpi`
   command, so this is not an undo/redo gap — there is nothing for undo/redo
   to cover.

## Why

- PRD 0012 §7.6 FR-063 itself sanctions this narrowing: "If unit/DPI are
  decided to be export-time concerns only (they already exist in
  print-export metadata), this FR must be narrowed accordingly before
  implementation." That condition is true — `unit`/`dpi` predate the PRD as
  print-export metadata — so the narrowing applies.
- Every current consumer of `unit`/`dpi` is a serializer producing a final
  export artifact (SVG viewBox/dimensions, PDF page size in points). Nothing
  in the live editing surface (stage, inspector, snapping, layout) needs to
  know a page's physical unit or DPI; `width`/`height` in `px` are the only
  values interaction code ever touches.
- Making unit/DPI interactively editable would require: a unit-conversion
  layer for every numeric field that reads page size (ruler legends, size
  presets, campaign-variant math), a `page.set-unit`/`page.set-dpi` command
  pair with undo/redo, and a decision on whether changing unit rescales
  `width`/`height` or is presentation-only. None of that is needed by any
  shipped export or print workflow today; adding it now would be speculative
  scope beyond what any FR or acceptance criterion currently requires.

## Consequences

- Ruler legends (PRD §12, FR-110) show raw numbers with no unit suffix — this
  is a direct, accepted consequence of this decision, not a separate gap.
- A future FR that genuinely needs interactive unit/DPI editing (e.g. a
  print-preview mode that shows physical dimensions during editing) must
  extend this decision explicitly: add the conversion layer, the mutation
  commands, and UI, and update this record rather than editing `unit`/`dpi`
  through an ad hoc path.
- `CanvasPageSize.unit`/`.dpi` must stay reachable only through `page.size`
  reads in export code; editor code must not add a new UI affordance for
  them without revisiting this record.

Test anchors: `src/commands/__tests__/page-resize.test.ts` ("preserves unit"),
`src/serialize/svg.ts`/`pdf.ts` unit-conversion tests, and
`@anvilkit/canvas-editor`'s
`src/pages/__tests__/PageSettingsDialog.test.tsx` ("no unit/DPI control").
