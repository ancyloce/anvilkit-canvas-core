# @anvilkit/canvas-core

## Unreleased

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
