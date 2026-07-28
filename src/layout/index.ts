/**
 * Public face of the `layout/` domain — imported only by the root barrel.
 *
 * Curated, never `export *` (the `serialize/index.ts` pattern). `layout/`
 * will grow a solver, a measurement cache, and materialize/flatten passes in
 * M2, and those modules export their internals for their own tests; an
 * `export *` here would leak every one of them into
 * `@anvilkit/canvas-core`'s public surface the moment they land. Adding a
 * name below is therefore a deliberate API decision, reviewed against
 * `check:api-snapshot`.
 */
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
