# @anvilkit/canvas-core

## Unreleased

### `CanvasImageNode.maskAssetId` deprecated — removal scheduled for `1.0.0` (PLAN-0035 cp4-007)

**No runtime behaviour is removed.** ADR 0008
(`docs/adr/0008-canvas-masking.md`) decision 3 disposes of the image node's
alpha-mask hook by deprecating it rather than finishing it. Masking lives on
the **container**: `CanvasFrameNode.shape` (`cp4-001`, `cp4-002`) is the
supported mask, and it is honoured identically by the editor's Konva `clipFunc`
and by SVG export because both read the one `resolveFrameClipShape`.

The field had never been rendered by anything — the Konva stage does not read
it, and `serializePageToSvg` has always refused it with
`IMAGE_MASK_UNSUPPORTED`. Setting it changed no pixel on any path. The problem
this entry closes is that the *documentation* implied otherwise: the
serializer's header rationale promised that "a future vector-mask
implementation can start emitting real markup", and the warning message said
only that masks "are not represented in SVG", both of which read as *not yet*.
Neither is true — the vector mask landed on the frame.

- **Deprecated:** `CanvasImageNode.maskAssetId` and
  `CreateImageOptions.maskAssetId`, both now carrying `@deprecated` TSDoc that
  names ADR 0008, states the migration, and names the removal version.
  **Removal is scheduled for `@anvilkit/canvas-core@1.0.0`** — a named major,
  not an open-ended intention. A tombstone table now lives in the README under
  **Deprecated surface (scheduled removals)**.
- **Migration:** wrap the image in a clipping `CanvasFrameNode` — `clip: true`
  plus a `shape` — with the image as its child. That composes with everything a
  frame already does (background, placeholder/image-well, Auto Layout,
  reposition-within-mask) and exports losslessly.
- **Nothing is unwired.** All six live consumers keep reading the field for the
  whole deprecation window: the declaration, the builder's write-through, the
  Zod schema (including its `min(1)` check — dropping the declaration would
  silently downgrade a typed field to a `looseObject` unknown key), the
  reference-preservation invariant (a deprecated reference is still a
  reference — drop it and a live asset starts looking dangling or
  garbage-collectable), the cross-document paste re-key, and
  `@anvilkit/canvas-editor`'s clipboard asset-ref collection. A document
  carrying `maskAssetId` parses, round-trips through parse → serialize → parse
  unchanged, and survives a paste with its reference rewritten — pinned by a
  new suite in `src/__tests__/mask-asset-id-deprecation.test.ts`.
- **`IMAGE_MASK_UNSUPPORTED` is retained permanently**, code and all —
  `SvgWarningCode` only ever grows, so a consumer switching on it is never
  broken. Its **message changed** to name the clipping-frame replacement and
  the `1.0.0` removal, and to state plainly that image masks *will not be*
  represented, rather than implying support is pending. The serializer's header
  rationale was corrected for the same reason. The warning still fires, the
  node still serializes, and the image is still never flattened to hide the
  gap.
- **No alpha-mask path exists or is planned.** No `<mask>` element is emitted,
  and no Konva `cache()` + `destination-in` composite was introduced — which is
  also why this change carries no drag-performance risk.

### SVG export honours frame clip shapes (PLAN-0035 cp4-002)

`cp4-001` added `CanvasFrameNode.shape` and `resolveFrameClipShape`; nothing
rendered them. The SVG serializer now does, so a shape-clipping frame exports as
the shape it clips to rather than a rectangle. Masking lives on the **frame**,
per ADR 0008 (`docs/adr/0008-canvas-masking.md`) decision 2 — the image node is
untouched.

- **No new clipping mechanism.** A shaped frame emits the same `<clipPath>` over
  the same `<g>`, under the same `frame-clip-<node-id>` id, that a rectangular
  `clip` has emitted since canvas-m1-003. Only the child of that `<clipPath>`
  changes, and every kind reuses geometry that already shipped: the frame box
  for `rect`, `emitEllipse`'s inscribed radii for `ellipse`,
  `computePolygonVertices`/`computeStarVertices` for `polygon`/`star`, and — for
  `path` — a `d` that must pass `PATH_D_RE`, the same allowlist `emitPath`
  applies. `cp4-001` deliberately left path data uncharacter-checked in `ir/`
  (rank 1 cannot import the rank-5 guard), so this is where it runs.
- **Byte-identical for every existing document.** An absent `shape` and an
  explicit `{ kind: "rect" }` both emit exactly what this serializer emitted
  before, rounding included. The pre-existing frame golden did not move.
- **Geometry comes from the ONE resolver**, so the SVG `<clipPath>` and the
  editor's Konva `clipFunc` cannot disagree. One consequence: `clip` is honoured
  as `clip === true` rather than merely truthy, which is the resolver's
  definition and what `CanvasFrameNodeShape` already validates.
- **An honoured shape carries no fidelity warning**, for the same reason a
  rectangular clip never has — it is losslessly representable. A shape on an
  unclipped frame stays inert, background included; it is not a second, silent
  clip trigger.
- **`SvgWarningCode` gains `"FRAME_CLIP_SHAPE_DEGRADED"`** (the union only ever
  grows, so no consumer switching on it breaks). It fires only for residue that
  genuinely cannot be drawn — a `kind` this build does not implement, numbers
  describing no outline, or rejected `path` data — after which the frame still
  clips to its box and the document keeps its field.
- **`IMAGE_MASK_UNSUPPORTED` and `CanvasImageNode.maskAssetId` are unchanged.**
  ADR 0008 decision 3 deprecates that field rather than implementing it, so no
  `<mask>` element is emitted and the warning survives this program.
- The PDF path needs no change: it embeds a raster the caller produced, so frame
  clipping is already baked into those pixels by the editor's rasterizer.

### Documentation — motion and media labelled contract-only (PLAN-0035 cp0-001)

**No behaviour change.** Nothing in this entry alters runtime behaviour, the
public API surface, the schemas, or any output. It documents what the package
has always done, because the published surface advertised capability the build
does not have: `video`/`audio` sit in `CanvasNodeKind` beside `rect`/`text`/
`image`, and `CanvasAnimation` describes seven motion kinds with timing —
while nothing in this repository plays or exports either. That gap was
disclosed only in TSDoc on an internal base interface, where no README reader
would find it.

- **README** — new **Built-in node-kind capability matrix** section covering
  all 16 built-in kinds, marking `video`/`audio` **contract-only (no playback;
  static poster at best)** and animation metadata **metadata-only (never
  played, never exported)**, with `Media support (video & audio)` and
  `Motion (animation is metadata-only)` subsections naming the exact warning
  codes (`VIDEO_UNSUPPORTED`, `AUDIO_UNSUPPORTED`, `ANIMATION_IGNORED`) a
  consumer can grep for. This also repairs a dead link: the IR section already
  pointed at `#media-support-video--audio`, an anchor that did not exist until
  now.
- **README** — the IR section said "15 built-in node kinds"; it is 16
  (`component-instance` was added by Local Components and never reflected in
  the prose or the ASCII tree). Corrected, with no API change.
- **`CanvasAnimation` TSDoc** — carries the metadata-only disclosure at the
  type a consumer actually touches, mirroring the wording
  `CanvasMediaNodeBase` has always carried, and records that the drop is
  warned on the SVG (per node and per page) and PDF (per page) paths but is
  **silent** on the PNG/JPEG/WebP raster paths.

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
