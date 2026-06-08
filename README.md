# @anvilkit/canvas-core

Headless Canvas IR, Zod validators, tree walkers, immutable mutations, an
undoable command runtime, and SVG/PDF serializers for **AnvilKit Canvas Studio**.

This package is the React-free, Konva-free data layer. Its only dependencies are
[`zod`](https://zod.dev) (validation) and [`pdf-lib`](https://pdf-lib.js.org)
(PDF output). The visual editor (`@anvilkit/canvas-editor`) renders this IR to a
Konva stage; this package never imports React, Konva, or `@anvilkit/core`.

```bash
pnpm add @anvilkit/canvas-core
```

## The Canvas IR

A document is a `CanvasIR`: a version-tagged tree of pages, each with a root
group whose `children` are shapes (`rect`, `ellipse`, `line`, `path`, `text`,
`image`, `ai-placeholder`) or nested `group`s.

```
CanvasIR
├─ version: "1"
├─ id, title
├─ pages: CanvasPage[]
│   ├─ id, name?, size { width, height, unit, dpi? }, background
│   └─ root: CanvasGroupNode
│        └─ children: CanvasNode[]  (rect | ellipse | line | path | text | image | ai-placeholder | group)
├─ assets: Record<id, CanvasAssetRef>
└─ metadata { createdAt, updatedAt, ownerId?, brandId? }
```

Every node carries `transform` (translate/rotate/scale/skew), `bounds`, `zIndex`,
and optional `opacity`/`visible`/`locked`/`blendMode`. Props are serializable
only — no functions or refs.

## Entry points

| Area | Exports |
|------|---------|
| **Builders** | `createCanvasIR`, `createPage`, `createGroup`, `createRect`, `createEllipse`, `createLine`, `createPath`, `createText`, `createImage` |
| **Walkers** | `walk`, `walkPage`, `findNode`, `parentOf`, `pageOf`, `isGroupNode`, `isLeafNode`, `isNodeOfKind`, `MAX_TREE_DEPTH` |
| **Mutations** (immutable) | `insertNode`, `removeNode`, `updateNode`, `moveNode`, `reorderChildren`, `replaceChildrenInParent` |
| **Commands** (undoable) | `applyCommand` → `{ ir, inverse }`, `CanvasCommand`, `CanvasCommandError` |
| **Validators** | `CanvasIRSchema`, per-node schemas, `migrateCanvasIR`, `CANVAS_IR_VERSION` |
| **Serializers** | `serializePageToSvg`, `serializeDocumentToPdf` |
| **Geometry** | `toAffineMatrix` |

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

// 1. Build a document (one default 1080×1080 page).
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

// 3. Serialize a page to SVG.
const { svg, warnings } = await serializePageToSvg(ir, 0);
```

### Commands & history

`applyCommand(ir, cmd)` returns the next IR plus a compact `inverse` command —
push inverses onto a stack for undo, and re-applying an inverse yields a redo
inverse. Supported: `node.create/delete/move/resize/rotate/update`,
`image.replace`, `node.group/ungroup`, and `page.create/delete/reorder/rename`.

### Validation & decoding untrusted IR

Schemas use `looseObject` (unknown keys are preserved, not stripped) so a
versioned document round-trips through an older build without data loss. When
decoding persisted or peer-supplied IR, prefer `migrateCanvasIR(raw)` over a bare
`CanvasIRSchema.parse` — it gates on `version` and is the seam for future
schema migrations.

### Serializers

- `serializePageToSvg(ir, pageSelector, options?)` → `{ svg, warnings }`. Async
  (it can fetch + inline remote images). Pass `validate: true` to reject a
  non-finite/malformed IR up front. Emits an accessible `<title>` + `role="img"`.
- `serializeDocumentToPdf(ir, options)` → `{ pdf, warnings }`. PDF is
  raster-embed (the caller supplies pre-rendered page rasters); page geometry is
  taken from each `CanvasPage`.

Both report fidelity caveats (unsupported background, missing asset, blocked URI,
…) as `warnings` rather than throwing.

## License

MIT
