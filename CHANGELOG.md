# @anvilkit/canvas-core

<!--
RELEASE CONVENTION — settled by PLAN-0035 `cp6-005`, 2026-08-11.

This package is versioned by CHANGESETS, like every other published
`@anvilkit/*` package (`@anvilkit/core`, `@anvilkit/ui` and the plugins all
carry `changeset version` output). Every user-visible change ships a file in
the SUPERPROJECT's `.changeset/`; that file is what bumps the version and what
becomes the released entry. ADR 0008 mandates the same, twice (decision 2 and
decision 3 item 10).

The prose under `## Unreleased` is the LONG-FORM NARRATIVE for those same
changes. It is not release metadata and it is not a substitute for a changeset.
Two operational rules follow, because the two mechanisms collide if nobody
does anything:

  1. `changeset version` inserts its generated `## <version>` block
     IMMEDIATELY UNDER THE `#` TITLE — i.e. ABOVE this section. The releaser
     must then retitle `## Unreleased` to the version just cut and open a
     fresh empty `## Unreleased`, or the narrative for shipped work goes on
     claiming to be unreleased. `packages/runtime/core/CHANGELOG.md` shows
     what a skipped retitle looks like: an `## Unreleased` heading stranded
     below three released versions. The block lands above THIS COMMENT too —
     `@changesets/apply-release-plan`'s `prependFile` splices at the file's
     first newline — so move the comment back under the `#` title in the
     same pass, or the next editor never sees the rule.
  2. `.changeset/` lives in the SUPERPROJECT while this package is a
     SUBMODULE. `changeset version` therefore edits this file and
     `package.json` inside the submodule working tree, which the superproject
     records only as a gitlink — the submodule must be committed and pushed
     on its own before the superproject's release commit.
-->

## Unreleased

### AI image workflow contracts (PLAN-0039 E7)

- Added provider-neutral capability discovery, normalized input limits, job
  progress, idempotent cancellation, retry, stable error categories, safety
  outcomes, cost details, and result metadata.
- Added selected image asset identity to `AiLayerContext` so a host can build
  editing requests and verify an accepted replacement against the live node.

### Collaboration anchors (PLAN-0039 E6)

- Added versioned document anchors alongside page, coordinate, node, and
  selection anchors for comment storage outside Canvas IR.
- Node and selection resolution now follows stable node IDs across page moves,
  reports current page identity, and archives/restores deterministically when
  targets disappear or return.

### Interactive preview performance (PLAN-0039 E4-T1–T3)

- Added non-load-bearing phase observation for component resolution and Auto
  Layout so hosts can attribute interactive preview cost without recording
  document content.
- Added conservative dirty-page and dirty-node resolution hints that retain
  untouched page records, widen Auto Layout dependency closures, and preserve
  component provenance across incremental passes.

### Document input safety (PLAN-0039 E1)

- Added one iterative document-budget validator for transport bytes, pages,
  nodes, depth, container width, assets, components, strings, and expanded
  component nodes, with stable diagnostics and recovery actions.
- Bounded built-in and extension migrations before recursive schema parsing and
  after normalization, including rejection of recursive component graphs.
- Added default-boundary and adversarial fixtures for deep, wide, string-heavy,
  recursive, page-heavy, and asset-heavy documents.

### Live release controls and rollback ownership (PLAN-0039 E0-T6)

- Added host-supplied live feature and operational flag snapshots with
  dependency-aware capability evaluation, so incident switches take effect
  without a new package release.
- Added tested kill switches for every P0 capability and each supported IR
  migration step.
- Assigned disable authority, fallback behavior, and verification ownership
  for collaboration, both AI providers, high-resolution export, and new
  migrations.

### Release dashboard and alert policy (PLAN-0039 E0-T4)

- Added deterministic aggregation for load, save, export, collaboration, AI,
  cancellation, crash, resource rejection, and interaction-latency signals.
- Added owned warning and critical thresholds with minimum sample sizes, plus
  zero-tolerance collaboration convergence alerts.

### Privacy-safe operational telemetry contract (PLAN-0039 E0-T3)

- Added versioned, typed events for load, save, recovery, export,
  collaboration, AI jobs, performance phases, and classified errors.
- Added a runtime privacy gate that drops raw content, binary/media data,
  prompts, tokens, URLs, and personal identifiers before a host sink runs.
- Telemetry delivery is non-load-bearing: absent or throwing sinks cannot break
  an editor operation.

### Executable release capability registry (PLAN-0039 E0-T1)

- Added `CANVAS_RELEASE_CAPABILITIES`, stable capability and feature-flag IDs,
  provider requirements, dependency declarations, supported export formats,
  release ownership, maturity, priority, and public descriptions.
- Added `CANVAS_RELEASE_FEATURE_FLAG_DEFAULTS` and
  `getCanvasReleaseCapability()` so host configuration, release gates, and
  generated documentation can consume the same registry.
- The print-PDF row is explicitly experimental and disabled by default until
  its editor type, default registration, UI, preflight, and documentation are
  reconciled by E2-T4; the registry does not promote the existing headless
  format vocabulary into a false editor availability claim.

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

### Frame clip shapes — `CanvasFrameNode.shape` and one resolver (PLAN-0035 cp4-001)

Non-rectangular masking, expressed on the **container** rather than on the
image, per ADR 0008 (`docs/adr/0008-canvas-masking.md`) decision 2. Before this
change both clip paths were closed over rect and rounded-rect, so no ellipse,
polygon, star or path mask could be expressed at all — the capability gap that
`CanvasImageNode.maskAssetId` had been standing in for without ever rendering.

- **New optional field: `CanvasFrameNode.shape?: CanvasFrameShape`**, declared
  beside `clip`. `CanvasFrameShape` is a **closed** union —
  `{ kind: "rect" }`, `{ kind: "ellipse" }`,
  `{ kind: "polygon", sides }`, `{ kind: "star", points, innerRadiusRatio }`,
  `{ kind: "path", d }`. Absent by default, and validated by the new
  `CanvasFrameShapeSchema`, which `CanvasFrameNodeShape` now carries.
- **`clip` remains the only on/off switch.** A `shape` on a frame with
  `clip !== true` is **inert** — it is not a second, silent clip trigger, and
  it does not reach the frame's background rounding either. Adding a shape to
  an existing document therefore changes nothing until `clip` is turned on.
- **New resolver: `resolveFrameClipShape(frame)` → `ResolvedFrameClipShape`.**
  This is the single place the rules live, and both render paths read it (SVG
  in `cp4-002`, the editor's Konva `clipFunc` in `@anvilkit/canvas-editor`'s
  `cp4-003`), so the two cannot disagree about geometry, about rounding
  normalization, or about whether a frame clips at all. An absent `shape`
  resolves to the rectangle with the frame's own rounding and
  `source: "default"`; a declared shape wins outright with
  `source: "declared"` — **including `{ kind: "rect" }`, which means
  "deliberately no shape mask" and stays distinguishable from absent**.
  `radius` / `cornerRadii` reach the result for `kind: "rect"` only.
- **Unhonourable geometry degrades, it never throws.** A `kind` this build does
  not implement, numbers describing no outline, or empty path data all fall
  back to the frame's rectangle and are reported on
  `ResolvedFrameClipShape` as a `FrameClipDegradation`.
- **New invariant `"unsupported-frame-clip-shape"`** joins
  `validateCanvasIRInvariants`, matching the reporting posture of
  `dangling-asset-reference` — it names the problem, it does not reject the
  document.
- **Backward and forward compatible.** No `requiredCapabilities` string was
  added: an older reader keeps the field (the IR schemas are `looseObject`) and
  simply clips to the rectangle, so there is no data loss and nothing to guard
  against destructive editing.
- **Path data is not character-validated here.** `ir/` cannot reach the
  serializer's `PATH_D_RE` allowlist, so the resolver rejects only an empty
  `d`; the allowlist runs on the way out, in `cp4-002`.
- **New public surface (13 declarations, 0 removed):** `CanvasFrameShape`,
  `CanvasFrameShapeSchema`, `CanvasFrameNode.shape`, `resolveFrameClipShape`,
  `ResolvedFrameClipShape` (and its members), `FrameClipDegradation`,
  `FrameClipShapeSource`.
- **⚠️ Known divergence, open and unowned (`D-1`).** A `{ kind: "path" }` whose
  `d` passes the character allowlist but draws nothing — `d: "Z"` is the worked
  example — is handled differently by the two paths: **SVG emits
  `<path d="Z" />` inside the `<clipPath>`, which is an empty clip region and
  therefore erases the frame's entire content, and it emits no warning**, while
  the editor's Konva path degrades to the frame box. Both are non-crashing;
  only one is a usable render. The recommended fix is for the SVG emitter to
  adopt a drawability oracle alongside the sanitizer and degrade with the
  existing `FRAME_CLIP_SHAPE_DEGRADED` warning; that is an ADR-level call and
  has not been made. It is pinned by an `it.fails` tripwire in
  `@anvilkit/canvas-editor`'s `frame-clip-parity` suite, so it will report
  loudly the day it is fixed.

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

### SVG export can reach browser-local images (PLAN-0035 cp1-006)

`@anvilkit/canvas-editor`'s zero-config asset fallback stores uploaded bytes in
the browser and references them from `ir.assets` by `blob:` URI. Those
documents used to export as SVG with **no `<image>` element at all**.

- **Root cause, now fixed:** `resolveImageHref` ran the URI scheme allowlist
  *before* the embed branch, so a browser-minted handle was rejected as
  `UNSAFE_URI` and the image was dropped — in **every** `images` mode, and the
  caller-supplied `fetchAsset` seam was never consulted. Supplying a fetcher
  could not have helped.
- **What happens now:** when `fetchAsset` is supplied, `images` is not
  `"reference"`, and the URI is a browser-local object URI, the bytes are
  fetched and embedded through the existing `embedRemote` path — the same
  base64 encoding and the same MIME sanitization every other embedded image
  gets. **The `blob:` URI itself never reaches the output**; what is emitted is
  a `data:` URI. Referencing `blob:` from an exported SVG remains impossible.
- **The allowlist is not weakened.** Exactly two schemes qualify — `blob:` and
  `filesystem:`, the complete set of opaque, same-origin, non-executable,
  browser-minted handles. `javascript:`, `file:`, `ftp:` and everything else
  still drop unconditionally, fetcher or not.
- **It is purely a recovery path.** It fires only where the previous behaviour
  was "drop the image entirely", so no export that worked before changes: with
  `images: "auto"` and a fetcher, a remote URI is still referenced and the
  fetcher is not called.
- **Better diagnosis.** A local URI the fetcher cannot resolve now warns
  `MISSING_ASSET` ("the image is omitted") instead of `UNSAFE_URI` ("blocked
  scheme"), which was a misdiagnosis, and it is not warned twice.
  `resolveImageHref` is the single choke point for `image`, `svg` and `video`
  poster emission, so one change covers all three. **No `SvgWarningCode` was
  added or removed.**
- **New public export: `isLocalObjectUri(uri)`** — the one predicate a consumer
  needs to tell a browser-local handle from an address it can resolve.

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
