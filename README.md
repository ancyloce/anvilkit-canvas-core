# @anvilkit/canvas-core

Headless Canvas IR, Zod validators, tree walkers, immutable mutations, an
undoable command runtime, geometry/snap math, an extension runtime, and SVG/PDF
serializers for **AnvilKit Canvas Studio**.

This package is the React-free, Konva-free **data layer**. Its only dependencies
are [`zod`](https://zod.dev) (validation) and [`pdf-lib`](https://pdf-lib.js.org)
(PDF output). The visual editor (`@anvilkit/canvas-editor`) renders this IR to a
Konva stage; this package never imports React, Konva, or `@anvilkit/core`, so the
same logic powers the editor, server-side export, headless tests, and
collaborative sync.

```bash
pnpm add @anvilkit/canvas-core
```

**Status.** Pre-1.0 (`0.x`, currently shipping release-candidate versions —
see `package.json`'s `version`). The public API can still change between
minor versions; breaking changes are called out in `CHANGELOG.md`.

**Development model.** This package is developed inside the `anvilkit-studio`
monorepo as a git submodule with its own independent version line and publish
lifecycle (see `docs/architecture/repository-structure.md`'s Submodule
Policy). `devDependencies` on `@anvilkit/biome-config`/`typescript-config`/
`vitest-config` and any in-repo cross-package linkage resolve via
`workspace:*` — a bare `git clone` of just this submodule plus `pnpm install`
does **not** build or test standalone; check it out inside the parent
workspace for local development. Consuming it as a published npm dependency
(`pnpm add @anvilkit/canvas-core`, above) is unaffected — that resolves a real
published version and needs no workspace context.

## Core features

- **Typed, versioned IR** — a `CanvasIR` document tree validated by Zod schemas
  that preserve unknown keys (`looseObject`) for forward/backward compatibility.
- **Immutable, single-pass mutations** — `insertNode` / `updateNode` /
  `moveNode` / … rebuild only the spine to the touched node and reuse every
  unchanged subtree by reference (structural sharing).
- **Undoable command runtime** — `applyCommand` returns the next IR *plus* a
  compact `inverse` command; `applyCommands` runs many as one all-or-nothing
  transaction and derives granular change records. Opt-in `enforceLocked`
  rejects mutations of locked nodes with a typed error.
- **Editing-feature vocabulary (PRD 0012)** — reparent/apply-style/page
  duplicate + resize commands, clipboard payload validation with hostile-input
  caps, public ID remapping (`regenerateNodeIds`), stroke styling +
  arrowheads, per-corner radii, image fit modes + one-color-matrix
  adjustments, ordered `effects[]` (drop-shadow `spread`, blur), rich-text
  strikethrough/auto-width/`verticalAlign`, image·svg `alt` text, and page
  layout aids — every capability with schema, inverse, migration-free optional
  fields, and serializer warnings.
- **Geometry without a renderer** — affine matrices, viewport pan/zoom,
  rotation-aware hit-testing/marquee, and Figma-style snap/align/distribute, all
  over plain world-space numbers.
- **Serializers** — `serializePageToSvg` (async, inlines remote images) and
  `serializeDocumentToPdf` (raster-embed), both reporting fidelity `warnings`
  instead of throwing.
- **Extension runtime** — register custom node kinds, command handlers, and
  schema migrations; `createCanvasRuntime` folds them into the validators,
  dispatcher, and SVG output. Custom container node kinds are rejected at
  registration (leaf kinds only today — see below).
- **Semantic invariant validation** — `validateCanvasIRInvariants`/
  `assertCanvasIRInvariants` check whole-document facts a Zod schema can't
  (duplicate ids, dangling asset references, invalid page roots, excessive
  tree depth), separate from and complementary to schema validation.

## Core Architecture

Canvas Core is a strict stack of layers. Each layer uses only the layers beneath
it; nothing low-level depends on anything above it, so the IR and geometry can be
consumed à la carte without pulling in commands or serializers.

```
   ^ higher layers depend on lower layers (never the reverse)
+-------------+--------------------------------------------------+
| Serialize   | serializePageToSvg, serializeDocumentToPdf       |
+-------------+--------------------------------------------------+
| Runtime/Ext | createCanvasRuntime, kind/cmd/migration regs     |
+-------------+--------------------------------------------------+
| Commands    | applyCommand, applyCommands, commandToChange     |
+-------------+--------------------------------------------------+
| Mutations   | insertNode, removeNode, updateNode, moveNode     |
+-------------+--------------------------------------------------+
| Geometry    | toAffineMatrix, hitTest, computeSnap             |
+-------------+--------------------------------------------------+
| Walkers     | walk, findNode, parentOf, pageOf                 |
+-------------+--------------------------------------------------+
| IR + Schema | CanvasIR, CanvasNode union, CanvasIRSchema       |
+-------------+--------------------------------------------------+
   React-free, Konva-free, deps: zod + pdf-lib
```

**Layer responsibilities**

- **IR + Schema** (`types.ts`, `ir-validators.ts`, `ir-builders.ts`) — the data
  model: a discriminated `CanvasNode` union, the page/document tree, the Zod
  schemas that decode untrusted input, and factory builders.
- **Walkers** (`ir-walkers.ts`) — read-only traversal and lookup with a depth
  guard (`MAX_TREE_DEPTH`): `walk`, `findNode`, `parentOf`, `pageOf`, type guards.
- **Geometry** (`geometry.ts`, `viewport.ts`, `hit-test.ts`, `snap.ts`) — pure
  math over world-space coordinates: affine transforms, world↔screen viewport
  mapping, rotation-aware hit/marquee testing, and snap/align/distribute.
- **Mutations** (`ir-mutations.ts`) — immutable, single-pass structural edits to
  the IR tree (the only place the tree is rewritten).
- **Commands** (`commands/`) — the undoable façade over mutations: a `CanvasCommand`
  union, `applyCommand`/`applyCommands`, inverse generation, and change events.
- **Runtime/Ext** (`extensions/`) — registries that fold custom node kinds,
  command handlers, and migrations into the schemas + dispatcher.
- **Serialize** (`serialize/`) — turn an IR page/document into SVG or PDF bytes,
  honoring any extension `toSvg` hooks.

**Data flow of one edit** — a host builds a command; `applyCommand` dispatches it
through a single-pass mutation to a new immutable IR, and simultaneously yields an
`inverse` (for the caller's history stack) and a change record (for listeners):

```
  UI / host
     |  builds a CanvasCommand  (node.move, node.update, batch, ...)
     v
  +---------------+   dispatch    +-----------------------------+
  | applyCommand  | ------------> | ir-mutations  (single-pass) |
  | applyCommands |               | updateNode, insertNode, ... |
  +-------+-------+               +--------------+--------------+
          |                                      v
          |                          new CanvasIR  (immutable,
          |                          structural sharing)
          |
          +--> inverse command -----> caller-managed undo / redo stack
          |
          +--> commandToChange -----> CanvasChangeEmitter
                                          +--> autosave / persistence
                                          +--> collaboration sync
                                          +--> editor re-render
```

## The Canvas IR

A document is a `CanvasIR`: a version-tagged tree of pages, each with a root
group whose `children` are one of 15 built-in node kinds (or a nested `group`
itself) — `group`, `frame`, `rect`, `ellipse`, `polygon`, `star`, `line`,
`path`, `text`, `rich-text`, `image`, `svg`, `ai-placeholder`, `video`,
`audio`. Only `group` and `frame` are **containers** (hold `children`); every
other kind is a leaf.

```
CanvasIR
|-- version: "2"                          (v1 documents migrate on read — see below)
|-- documentKind?: "design" | "template-instance" | "export-variant"
|-- id, title
|-- pages: CanvasPage[]                   (>= 1, enforced by schema AND by page.delete)
|   |-- id, name?, size { width, height, unit, dpi? }, background
|   |-- variantSource?    (campaign-resize provenance)
|   |-- animation?        (page-level enter/exit motion metadata)
|   `-- root: CanvasGroupNode
|           `-- children: CanvasNode[]
|               (group | frame | rect | ellipse | polygon | star | line | path
|                | text | rich-text | image | svg | ai-placeholder | video | audio)
|-- assets: Record<id, CanvasAssetRef>
`-- metadata { createdAt, updatedAt, ownerId?, brandId? }
```

Every node carries `transform` (translate/rotate/scale/skew), `bounds`, `zIndex`,
and optional `opacity`/`visible`/`locked`/`blendMode`/`meta` (AI-source
provenance + per-node animation metadata). Props are serializable only — no
functions or refs. The node union is a Zod `discriminatedUnion` on `type` for
O(1) decoding. Fills (`CanvasFill`) and font families accept either a literal
value or a `BrandTokenRef` — an unresolved pointer into an external brand kit
that a consumer (the SVG serializer's `resolveBrandToken` option, or the
editor's brand kit) resolves; core never resolves one itself. `video`/`audio`
are asset-reference-only (no inline media bytes, no playback) — see
[Media support](#media-support-video--audio) below.

## Entry points

| Area | Exports |
|------|---------|
| **Builders** | `createCanvasIR`, `createPage`, `createGroup`, `createFrame`, `createRect`, `createEllipse`, `createPolygon`, `createStar`, `createLine`, `createPath`, `createText`, `createRichText`, `createImage`, `createSvg`, `createVideo`, `createAudio` |
| **Walkers** | `walk`, `walkPage`, `findNode`, `parentOf`, `pageOf`, `isContainerNode`, `isGroupNode`, `isFrameNode`, `isLeafNode`, `isNodeOfKind`, `MAX_TREE_DEPTH`, `CanvasIRDepthError` |
| **Mutations** (immutable) | `insertNode`, `removeNode`, `updateNode`, `moveNode`, `reorderChildren`, `replaceChildrenInParent`, `CanvasIRMutationError` |
| **Commands** (undoable) | `applyCommand(ir, cmd) → { ir, inverse }`, `CanvasCommand`, `CanvasCommandError` — see the full command list below |
| **Transactions** | `applyCommands(ir, cmds) → { ir, inverse, changes, records }` |
| **Change events** | `commandToChange`, `commandToChangeRecord`, `replayChanges`, `createChangeEmitter`, `CanvasChange`, `CanvasChangeRecord`, `CanvasChangeEmitter` |
| **Semantic invariants** | `validateCanvasIRInvariants(ir) → issues[]`, `assertCanvasIRInvariants`, `CanvasIRInvariantError` — whole-document checks (duplicate ids, dangling asset refs, invalid page roots, excessive depth) a Zod schema can't express; not run automatically on every command, call explicitly at a trust boundary |
| **Geometry** | `toAffineMatrix`, `applyMatrix`, `multiplyMatrix`, `invertMatrix`, `decomposeMatrix`, `transformedBoundsExtent`, `AffineMatrix` |
| **Viewport** | `viewportMatrix`, `worldToScreen`, `screenToWorld`, `ViewportDescriptor` |
| **Hit-testing** | `hitTest`, `marqueeHits`, `pointInNode`, `nodeWorldAabb`, `Aabb` |
| **Snap & align** | `computeSnap`, `alignRects`, `distributeRects`, `SnapInput`, `SnapResult`, `SmartGuide`, `DEFAULT_SNAP_THRESHOLD` |
| **Validators** | `CanvasIRSchema`, per-node schemas, `migrateCanvasIR`, `CANVAS_IR_VERSION` (`"2"`) |
| **Serializers** | `serializePageToSvg`, `serializeDocumentToPdf` |
| **Extensions** | `createCanvasRuntime`, `createNodeKindRegistry`, `createCommandRegistry`, `createMigrationRegistry`, `CanvasExtension`, `CanvasRuntime`, `CanvasNodeKindDefinition`, `CanvasCommandHandler`, `CanvasExtensionError` |
| **Brand** | `applyBrandColors`/etc. (FR-032) — reversible brand-kit apply transforms; `BrandTokenRef`, `resolveBrandToken` seam types |
| **Templates** | `@anvilkit/canvas-templates`-compatible instantiation/resize helpers (`instantiateTemplate`, `resizeToVariants`, `CANVAS_SIZE_PRESETS`) |
| **AI contracts** | `AiImageJobRequest`, `AiImageProvider`, `AiDesignJobRequest`, … (types) |
| **Comment anchors** | `CanvasCommentAnchor` resolver types (FR-072) |
| **Text contracts** | `CanvasTextMeasurer` port — a host-implemented text measurement contract core itself never implements |

All mutations and commands are **pure and immutable**: they return a new `CanvasIR`
with structural sharing (unchanged subtrees are reused by reference). Timestamps
come from an injectable `now?: () => string` (deterministic in tests).

## Quick start

```ts
import {
  createCanvasIR,
  createRect,
  applyCommand,
  serializePageToSvg,
} from "@anvilkit/canvas-core";

// 1. Build a document (one default 1080x1080 page).
let ir = createCanvasIR({ title: "Hello" });
const pageId = ir.pages[0].id;

// 2. Mutate it through the undoable command runtime.
const { ir: next, inverse } = applyCommand(ir, {
  type: "node.create",
  pageId,
  node: createRect({ bounds: { width: 200, height: 120 }, fill: "#38bdf8" }),
});
ir = next;
// `inverse` is the command that undoes this (here, a `node.delete`).

// 3. Serialize a page to SVG (by index or page id).
const { svg, warnings } = await serializePageToSvg(ir, 0);
```

### Commands & history

`applyCommand(ir, cmd)` returns the next IR plus a compact `inverse` command —
push inverses onto a stack for undo, and re-applying an inverse yields a redo
inverse. Supported: `node.create/delete/move/resize/reorder/rotate/update`,
`image.replace`, `node.group/ungroup`, `page.create/delete/reorder/rename`, and
`batch` (a composite of any of the above, itself invertible).

`page.delete` refuses to remove a document's last remaining page — a
`CanvasIR` must always have >= 1 page (also enforced by `CanvasIRSchema`) — and
throws a `CanvasCommandError` (code `"invariant-violated"`) instead of leaving
an invalid document. This is enforced by the command itself, not only by an
editor-level UI guard: a batch, undo/redo replay, or a host calling
`applyCommand` directly are all protected.

History is **caller-managed**: core hands you the inverse, but it keeps no stack
of its own — the editor (or any host) owns the undo/redo stacks.

For multi-step edits, `applyCommands` runs a list as one reversible transaction
(all-or-nothing) and also returns the granular change records:

```ts
import { applyCommands } from "@anvilkit/canvas-core";

const { ir: next, inverse, changes } = applyCommands(ir, [
  { type: "node.move", nodeId, from, to },
  { type: "node.update", nodeId, kind: "rect", patch: { fill: "#f43f5e" } },
]);
// `inverse` is a single composite `batch`; `changes` feed autosave/collab/UI.
```

### Custom node kinds & commands

`createCanvasRuntime(extensions)` folds custom node kinds, command handlers, and
migrations into the schemas and the command dispatcher. With no extensions the
returned `nodeSchema`/`irSchema` are identity-equal to the static module schemas,
so the zero-extension runtime behaves exactly like the built-ins. The
extension-aware schema validates every built-in field (`variantSource`,
`animation`, etc.) identically to the static one — both are built from the
same shared shape constants, so registering a custom kind can never silently
loosen validation of built-in fields.

```ts
import { createCanvasRuntime } from "@anvilkit/canvas-core";

const runtime = createCanvasRuntime([myExtension]);
const { ir, inverse } = runtime.apply(ir, myCustomCommand); // built-ins unshadowable
const decoded = runtime.migrate(rawUntrustedDoc);           // migrate -> validate
const { svg } = await serializePageToSvg(ir, 0, { nodeKinds: runtime.nodeKinds });
```

A custom command handler is `CanvasCommandHandler<C, Inverse = C | CanvasCommand>`
— its `apply` can return a genuinely custom `Inverse` command type (not just
the built-in `CanvasCommand` union) with no unsafe cast, and `runtime.apply<C>`
mirrors that: called with no type argument it behaves exactly like
`applyCommand`, called with an explicit `C` it types `inverse` as `C |
CanvasCommand`. A `batch` command containing a custom sub-command dispatched
through `runtime.apply` resolves that sub-command via the registry too — not
just at the top level.

**Container kinds are not extensible today.** `CanvasNodeKindDefinition.isContainer`
exists on the type, but core's walkers/mutations only ever recurse into the
static built-in containers (`group`, `frame`) — `createNodeKindRegistry`
rejects `isContainer: true` on an extension kind outright (`CanvasExtensionError`,
code `"container-kind-unsupported"`) rather than silently accepting a
definition that would never actually be walked. Model containment today by
nesting your custom leaf kind inside a built-in `group`/`frame`.

### Validation & decoding untrusted IR

Schemas use `looseObject` (unknown keys are preserved, not stripped) so a
versioned document round-trips through an older build without data loss. When
decoding persisted or peer-supplied IR, prefer `migrateCanvasIR(raw)` (or
`runtime.migrate(raw)`) over a bare `CanvasIRSchema.parse` — it gates on
`version` and is the seam for future schema migrations.

Migration is deliberately **non-structural** for the legacy `shadow` field:
decode preserves it verbatim and read-time precedence via
`resolveNodeEffects` (a present `effects` array — including an empty one —
wins; otherwise `shadow` applies) keeps old documents rendering identically
without an IR version bump. Nodes upgrade to `effects[]` lazily when edited.
Never read `node.shadow` directly — always resolve through
`resolveNodeEffects`. Rationale and guarantees: the workspace decision record
`docs/architecture/shadow-effects-normalization-decision.md`; contract tests:
`src/ir/__tests__/shadow-effects-decode.test.ts` and
`src/serialize/__tests__/effects.test.ts`.

### Serializers

- `serializePageToSvg(ir, pageSelector, options?)` → `{ svg, warnings }`. Async
  (it can fetch + inline remote images). `pageSelector` is a page index or id.
  Pass `validate: true` to reject a non-finite/malformed IR up front, and
  `nodeKinds` (typically `runtime.nodeKinds`) to serialize extension nodes via
  their `toSvg` hook. Emits an accessible `<title>` + `role="img"`.
- `serializeDocumentToPdf(ir, options)` → `{ pdf, warnings }`. PDF is
  raster-embed (the caller supplies pre-rendered page rasters); page geometry is
  taken from each `CanvasPage`.

Both report fidelity caveats (unsupported background, missing asset, blocked URI,
unknown node kind, …) as `warnings` rather than throwing.

## Notes

- **Immutable & pure.** Every mutation/command returns a new `CanvasIR` with
  structural sharing; your input is never mutated. Inject `now?: () => string`
  for deterministic timestamps in tests.
- **Headless.** No React, Konva, or `@anvilkit/core` imports — safe to run on a
  server, in a worker, or in unit tests. The editor renders this IR separately.
- **SVG is async and lossy-by-report.** It may fetch/inline remote images and
  flags fidelity gaps as `warnings`; it never throws on a renderable-but-imperfect
  node (enable `validate` to fail fast on malformed input instead).
- **PDF is raster-embed.** Output is one rasterized page per `CanvasPage` — no
  vector geometry or selectable text (the caller provides the rasters).
- **Single entry point.** Everything is exported from the package root (`.`);
  there are no subpath exports.

## Release gates

`pnpm check:all` runs the release-gate chain: `check:publint` (packed-tarball publint), `check:circular` (madge), `check:react-free-runtime` (React/Konva-free source scan), `check:peer-deps` (dependency-cone rules: zero peers, no React/Konva anywhere in the runtime cone), and `check:bundle-budget` (esbuild-based, budget and externals read from `.size-limit.json` so the two size gates cannot drift). `check:api-snapshot` (typedoc JSON diff of the public API; regenerate with `pnpm update:api-snapshot` and commit the result).

Gates assume a **full package build** first — run `pnpm build` before `pnpm check:all`.

## License

MIT
