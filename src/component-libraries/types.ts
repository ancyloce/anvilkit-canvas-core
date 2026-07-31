/**
 * External Component Library reference types (plan 0021 T-010/T-012, TD 0016 §5.1).
 *
 * ## These moved to `ir/` in M1 — this module is the subpath's public door
 *
 * M0 declared them here because nothing in `ir/` needed them yet. T-012 put
 * `source` on the `component-instance` node, which made them a **persisted**
 * shape — and `ir/` is rank 1 while this domain is rank 4, so `ir/types.ts`
 * cannot import them upward from here (`scripts/check-layering.mjs`; a
 * self-test pins that edge as illegal).
 *
 * They therefore live in `../ir/component-source.js` now, and this module
 * re-exports them so `@anvilkit/canvas-core/component-libraries` keeps the
 * exact surface M0 published. Re-export, not redeclaration: two declarations
 * of one persisted shape is precisely the drift this package's layer map
 * exists to prevent.
 */

export type {
	CanvasExternalComponentSnapshot,
	CanvasExternalComponentSnapshotRegistry,
} from "../ir/types.js";
export {
	type CanvasComponentSourceRef,
	type CanvasExternalComponentRef,
	type CanvasLocalComponentSourceRef,
	componentSourceLabel,
	componentSourceRefsEqual,
	isExternalSourceRef,
	isLocalSourceRef,
	localComponentIdOf,
} from "../ir/component-source.js";
