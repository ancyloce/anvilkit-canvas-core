# @anvilkit/canvas-core

## Unreleased

### PRD 0012 completion pass

- **shadow→effects reconciliation (§9.4)**: the read-time normalization
  strategy is now an explicit, recorded decision — `CANVAS_IR_VERSION` stays
  `"2"`, decode never rewrites `shadow` structurally, `resolveNodeEffects`
  precedence (`effects[]` wins, empty array suppresses) is the single source
  of truth, and nodes upgrade lazily on edit. Decision record:
  `docs/architecture/shadow-effects-normalization-decision.md`; new
  decode-boundary contract tests in
  `src/ir/__tests__/shadow-effects-decode.test.ts` (verbatim round trips for
  shadow-only / effects-only / both / empty-effects documents, node-level
  unknown-key preservation across v1→v2).
- The decision record above is now committed inside this package (`docs/`
  is published via `files`) instead of only existing as an external,
  untracked workspace note — README/CHANGELOG/test references to it now
  resolve for anyone consuming this package standalone.
- **Unit/DPI export-only decision formalized (FR-063, OD-1)**: added
  `docs/architecture/unit-dpi-export-only-decision.md` recording that
  `CanvasPageSize.unit`/`.dpi` are export-time-only (consumed only by the
  SVG/PDF serializers), with no schema, command, or public API change — the
  decision was already in effect, this documents it durably.
- **`CanvasPageBackground` contract narrowed (FR-063)**: `solid` is
  documented as the only kind with first-class rendering; `image`/`gradient`
  are reserved (undefined `value` format) — serializer keeps warning
  `BACKGROUND_UNSUPPORTED`, and the editor now renders a neutral fallback
  for them instead of interpreting the raw string.
### PRD 0012 editing features (Phases 1a/1b/2)

All additive; existing documents need no migration (new fields are optional
with legacy-equivalent defaults).

- **Commands**: `node.reparent` (with inverse, cycle/page-root guards),
  `node.applyStyle` (FR-121 compatible-property matrix + ignored-field
  reporting), `page.duplicate`, `page.resize` (all four FR-063 modes incl.
  scale-content), `page.set-layout-aids`.
- **`enforceLocked` option** on `applyCommand`/`applyBatch`: locked targets
  raise a typed `CanvasCommandError` (default off; opt-in by the editor's
  action layer).
- **Public ID-remap utility** `regenerateNodeIds` (templates and page cloning
  consume it; no duplicate implementations).
- **Clipboard payload schema** (`CanvasClipboardPayload`): depth/count/
  byte-size caps, version check, hostile-payload validation.
- **IR fields**: stroke opacity/dash/cap/join + line/path arrowheads (SVG
  `<marker>`), per-corner radii, image `fitMode` + non-destructive
  `adjustments` (one shared color matrix), `effects[]`
  (drop-shadow with `spread`, blur) with documented precedence over legacy
  `shadow`, rich-text `strikethrough` + `auto-width` sizing, page layout aids
  (guides/margin/bleed/safe-area).
- **Export**: `json` added to `CanvasExportFormat`; serializer warnings for
  every new capability; `tidyUpRects` geometry helper.

### Gap-closure follow-up

All additive/optional — no migration needed.

- **Rich-text `verticalAlign`** (`top`/`middle`/`bottom`, FR-081): the SVG
  serializer offsets the block within its box when a content height is known
  (measurer or explicit `height`), else warns
  `RICH_TEXT_VERTICAL_ALIGN_APPROXIMATED`.
- **Image/SVG `alt`** (§12 item 11): the SVG serializer emits it as a
  `<title>` child + `role="img"` on the `<image>` element.
- Builders (`createRichText`/`createImage`/`createSvg`) accept the new fields
  plus rich-text `sizing`.

### Fixed

- SVG serializer emitted duplicate stroke-style attributes
  (`stroke-opacity`/`stroke-dasharray`/`stroke-linecap`/`stroke-linejoin`)
  on `rect` and `path` nodes — strict XML parsers reject such documents. Now
  emitted once; the golden-snapshot well-formedness check rejects duplicate
  attributes across all goldens.

### Earlier unreleased work

Hardening pass from the canvas-core code review (no public type changes; the IR
shape and all function signatures are unchanged).

### Performance

- IR mutations (`updateNode`/`insertNode`/`removeNode`) are now single-pass — a
  committed drag on a 1000-node scene is ~6× faster.
- `node.group` / `node.ungroup` apply a single tree rewrite (`replaceChildrenInParent`)
  instead of one immutable clone per affected child.
- The node validator uses `z.discriminatedUnion` (O(1) tag dispatch) instead of a
  plain union.

### Correctness & robustness

- Validators now preserve unknown keys (`z.looseObject`) instead of silently
  stripping them, so a versioned IR round-trips through an older build without
  data loss.
- Recursion-depth guard (`MAX_TREE_DEPTH`) added to every recursive mutation and
  to the SVG emitter, so a pathologically deep IR throws `CanvasIRDepthError`
  rather than overflowing the stack.
- The inverse of adding an optional field now restores the field's absence
  exactly (the key is deleted, not set to `undefined`).
- `node.group` bounds are transform-aware (account for rotation/scale/skew).
- Serializers accept `validate: true` to reject a non-finite/malformed IR; PDF
  output throws on non-finite page dimensions instead of emitting a broken page.
- `CANVAS_CORE_VERSION` now tracks `package.json`.

### Security

- SVG image `href` uses a scheme allowlist (http/https/relative/data:image)
  instead of a blocklist.
- `@font-face` `src` sanitisation strips `{` `}` `;` to prevent CSS-rule
  injection.

### API

- New: `replaceChildrenInParent`, `migrateCanvasIR`, `CANVAS_IR_VERSION`,
  `toAffineMatrix` (re-homed in `geometry`, same import path).
- Removed the `exports["./*"]` wildcard subpath (no consumer used it); only the
  package root and `./package.json` are exported.

## 0.1.2

- Initial published baseline of the headless Canvas IR, validators, walkers,
  mutations, command runtime, and SVG/PDF serializers.
