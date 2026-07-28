/**
 * Public face of the `layout/` domain — imported only by the root barrel.
 *
 * Curated, never `export *` (the `serialize/index.ts` pattern). The domain now
 * holds a solver, an axis adapter, a measurement pass, a sizing graph, a
 * signature cache and a materializer, and every one of them exports internals
 * for its own tests; an `export *` here would put all of that in
 * `@anvilkit/canvas-core`'s public surface and in `check:api-snapshot`, where
 * it would then be a breaking change to remove. Adding a name below is a
 * deliberate API decision.
 *
 * **Deliberately NOT exported** — these are how the resolver works, not what it
 * promises: `axisFor`/`AxisAdapter`, `buildSizingGraph`, `subtreeSignature` and
 * the whole cache layer, `measureIntrinsicSize`/`measurementKey`, `quantise`,
 * `computeInputHash`, `orderLayoutIssues`/`buildDocumentOrder`, and
 * `createLayoutIssue`. A host that needed one of these would be reimplementing
 * a piece of the solver, which is exactly what "one layout algorithm" forbids.
 */

// --- the five public entry points (plan §4.5) --------------------------------
export {
	type CanvasLayoutFlattenOptions,
	type CanvasLayoutMaterializeOptions,
	flattenCanvasLayout,
	materializeCanvasLayout,
} from "./materialize.js";
export { resolveCanvasLayout } from "./resolve.js";
// --- resolved-tree contracts -------------------------------------------------
export type {
	CanvasLayoutMeasurementProvider,
	CanvasLayoutResolveOptions,
	CanvasResolvedDocument,
	CanvasResolvedGeometry,
	CanvasResolvedNodeId,
	CanvasResolvedNodeRecord,
	CanvasResolvedView,
} from "./types.js";
export { createResolvedView, toResolvedNodeId } from "./types.js";
// --- diagnostics -------------------------------------------------------------
export type {
	CanvasLayoutIssue,
	CanvasLayoutIssueCode,
	CanvasLayoutIssueFallback,
	CanvasLayoutIssueSeverity,
} from "./validate.js";
export {
	assertLayoutInvariants,
	CanvasLayoutInvariantError,
	validateLayoutInvariants,
} from "./validate.js";
