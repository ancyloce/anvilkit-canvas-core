/** Public face of the `ir/` domain — imported only by the root barrel. */
export * from "./builders.js";
export * from "./capabilities.js";
// Persisted policy shapes only. The command-time half (capabilities, context,
// validation) is `@anvilkit/canvas-core/brand-governance` — governance is
// opt-in and must not cost the root budget.
export type {
	CanvasBrandComponentPolicy,
	CanvasBrandTokenConstraint,
} from "./component-policy.js";
// Explicit, not `*`: the schemas are internal wiring for `ir/validators.ts`
// and would otherwise land on the root barrel. Same curation as component-source.
export {
	canonicalVariantKey,
	type CanvasComponentVariantAxis,
	type CanvasComponentVariantDefinition,
	type CanvasComponentVariantSelection,
	type CanvasComponentVariantSet,
	CanvasComponentVariantSetSchema,
	type CanvasComponentVariantValue,
} from "./component-variants.js";
// Explicit (not `*`): the ref-field factory, the version-rule helpers, and the
// digest-shape regex are shared with `component-libraries/schema.ts` so the two
// strictness variants cannot disagree — they are package-internal plumbing, not
// public API, and `export *` would put all of them (plus the inline `addIssue`
// ctx shape) on the root barrel. Same curation rationale as `regenerate-ids`.
export {
	type CanvasComponentSourceRef,
	type CanvasExternalComponentRef,
	CanvasIRComponentSourceRefSchema,
	type CanvasLocalComponentSourceRef,
	componentSourceLabel,
	componentSourceRefsEqual,
	isExternalSourceRef,
	isLocalSourceRef,
	localComponentIdOf,
} from "./component-source.js";
export * from "./effects.js";
export * from "./image-adjustments.js";
export * from "./invariants.js";
export * from "./migrations.js";
export * from "./mutations.js";
// Explicit (not `*`): `defaultIdFactory` is a module-level helper for
// internal id-allocating callers and stays OFF the public surface — pinned
// by `component-api-surface.test.ts`.
export {
	type RegenerateNodeIdsOptions,
	type RegenerateNodeIdsResult,
	regenerateNodeIds,
} from "./regenerate-ids.js";
export type * from "./types.js";
export * from "./validators.js";
export * from "./walkers.js";
