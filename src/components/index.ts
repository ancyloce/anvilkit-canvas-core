/**
 * @file Public barrel of the `components/` domain (plan 0023, TD §22).
 *
 * Rank 2: reads `ir/` only. Persisted component shapes (definition, registry,
 * properties, overrides) live in `ir/` following the `layout/` precedent —
 * `ir/types.ts` owns `CanvasIR.components` and `ir/validators.ts` spreads the
 * schemas, and rank 1 cannot import upward. This domain owns the
 * resolver-side surface: identity today, graph/resolve/cache in M2.
 *
 * Curated allowlist per the `serialize/index.ts` precedent — each re-export
 * below is an explicit list, so resolver/cache internals never ship through
 * the root barrel.
 */

export {
	type CanvasComponentResolutionCache,
	createComponentResolutionCache,
} from "./cache.js";
export {
	buildComponentGraph,
	type CanvasComponentGraph,
	collectNestedComponentIds,
} from "./graph.js";
export {
	type CanvasComponentIdFactories,
	type CanvasVirtualNodePath,
	createComponentIdFactories,
	decodeResolvedNodeId,
	encodeResolvedNodeId,
	findComponentProperty,
} from "./identity.js";
export { type CanvasTreeAccess, createTreeAccess } from "./location.js";
export {
	applyComponentOverrides,
	type CanvasAppliedOverrides,
} from "./overrides.js";
export {
	type CanvasComponentExpansionOptions,
	type CanvasResolvedComponentInstance,
	resolveComponentInstance,
} from "./resolve.js";
export * from "./schema.js";
export * from "./types.js";
export {
	assertComponentGraph,
	CanvasComponentGraphError,
	validateComponentGraph,
} from "./validate.js";
