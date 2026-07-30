/**
 * @file Public barrel of `component-ops/` (plan 0023, TD §22, decision D-1).
 *
 * Rank 4, FOLDED INTO the `templates` layering domain rather than a separate
 * equal-rank domain: TD §16.3 makes `templates/instantiate.ts` ↔
 * component-import coupling inevitable, and equal-rank cross-domain imports
 * are layering violations — same-domain membership is what keeps that edge
 * legal. Holds create/detach/clipboard/template document operations (M3).
 */
export {
	type CanvasForeignComponentRef,
	findForeignComponentRefs,
} from "./clipboard.js";
export {
	type BuildDetachAllAndDeleteOptions,
	buildDetachAllAndDeleteCommand,
	type CanvasDetachAllAndDeletePlan,
} from "./delete.js";
export {
	type BuildDetachCommandOptions,
	buildDetachCommand,
	type CanvasDetachPlan,
} from "./detach.js";
export {
	type MaterializeExportVariantOptions,
	materializeExportVariant,
} from "./export-variant.js";
