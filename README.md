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

## Core features

- **Typed, versioned IR** — a `CanvasIR` document tree validated by Zod schemas
  that preserve unknown keys (`looseObject`) for forward/backward compatibility.
- **Immutable, single-pass mutations** — `insertNode` / `updateNode` /
  `moveNode` / … rebuild only the spine to the touched node and reuse every
  unchanged subtree by reference (structural sharing).
- **Undoable command runtime** — `applyCommand` returns the next IR *plus* a
  compact `inverse` command; `applyCommands` runs many as one all-or-nothing
  transaction and derives granular change records.
- **Geometry without a renderer** — affine matrices, viewport pan/zoom,
  rotation-aware hit-testing/marquee, and Figma-style snap/align/distribute, all
  over plain world-space numbers.
- **Serializers** — `serializePageToSvg` (async, inlines remote images) and
  `serializeDocumentToPdf` (raster-embed), both reporting fidelity `warnings`
  instead of throwing.
- **Extension runtime** — register custom node kinds, command handlers, and
  schema migrations; `createCanvasRuntime` folds them into the validators,
  dispatcher, and SVG output.

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
group whose `children` are shapes (`rect`, `ellipse`, `line`, `path`, `text`,
`image`, `ai-placeholder`) or nested `group`s.

```
CanvasIR
|-- version: "1"
|-- id, title
|-- pages: CanvasPage[]
|   |-- id, name?, size { width, height, unit, dpi? }, background
|   `-- root: CanvasGroupNode
|           `-- children: CanvasNode[]  (rect | ellipse | line | path | text | image | ai-placeholder | group)
|-- assets: Record<id, CanvasAssetRef>
`-- metadata { createdAt, updatedAt, ownerId?, brandId? }
```

Every node carries `transform` (translate/rotate/scale/skew), `bounds`, `zIndex`,
and optional `opacity`/`visible`/`locked`/`blendMode`. Props are serializable
only — no functions or refs. The node union is a Zod `discriminatedUnion` on
`type` for O(1) decoding.

## Entry points

| Area | Exports |
|------|---------|
| **Builders** | `createCanvasIR`, `createPage`, `createGroup`, `createRect`, `createEllipse`, `createLine`, `createPath`, `createText`, `createImage` |
| **Walkers** | `walk`, `walkPage`, `findNode`, `parentOf`, `pageOf`, `isGroupNode`, `isLeafNode`, `isNodeOfKind`, `MAX_TREE_DEPTH`, `CanvasIRDepthError` |
| **Mutations** (immutable) | `insertNode`, `removeNode`, `updateNode`, `moveNode`, `reorderChildren`, `replaceChildrenInParent`, `CanvasIRMutationError` |
| **Commands** (undoable) | `applyCommand(ir, cmd) → { ir, inverse }`, `CanvasCommand`, `CanvasCommandError` |
| **Transactions** | `applyCommands(ir, cmds) → { ir, inverse, changes }` |
| **Change events** | `commandToChange`, `createChangeEmitter`, `CanvasChange`, `CanvasChangeEmitter` |
| **Geometry** | `toAffineMatrix`, `applyMatrix`, `multiplyMatrix`, `invertMatrix`, `decomposeMatrix`, `transformedBoundsExtent`, `AffineMatrix` |
| **Viewport** | `viewportMatrix`, `worldToScreen`, `screenToWorld`, `ViewportDescriptor` |
| **Hit-testing** | `hitTest`, `marqueeHits`, `pointInNode`, `nodeWorldAabb`, `Aabb` |
| **Snap & align** | `computeSnap`, `alignRects`, `distributeRects`, `SnapInput`, `SnapResult`, `SmartGuide`, `DEFAULT_SNAP_THRESHOLD` |
| **Validators** | `CanvasIRSchema`, per-node schemas, `migrateCanvasIR`, `CANVAS_IR_VERSION` |
| **Serializers** | `serializePageToSvg`, `serializeDocumentToPdf` |
| **Extensions** | `createCanvasRuntime`, `createNodeKindRegistry`, `createCommandRegistry`, `createMigrationRegistry`, `CanvasExtension`, `CanvasRuntime`, `CanvasNodeKindDefinition` |
| **AI contracts** | `AiImageJobRequest`, `AiImageProvider`, … (types) |

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
inverse. Supported: `node.create/delete/move/resize/rotate/update`,
`image.replace`, `node.group/ungroup`, and `page.create/delete/reorder/rename`.

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
so the zero-extension runtime behaves exactly like the built-ins.

```ts
import { createCanvasRuntime } from "@anvilkit/canvas-core";

const runtime = createCanvasRuntime([myExtension]);
const { ir, inverse } = runtime.apply(ir, myCustomCommand); // built-ins unshadowable
const decoded = runtime.migrate(rawUntrustedDoc);           // migrate -> validate
const { svg } = await serializePageToSvg(ir, 0, { nodeKinds: runtime.nodeKinds });
```

### Validation & decoding untrusted IR

Schemas use `looseObject` (unknown keys are preserved, not stripped) so a
versioned document round-trips through an older build without data loss. When
decoding persisted or peer-supplied IR, prefer `migrateCanvasIR(raw)` (or
`runtime.migrate(raw)`) over a bare `CanvasIRSchema.parse` — it gates on
`version` and is the seam for future schema migrations.

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
