/** Public face of the `ir/` domain — imported only by the root barrel. */
export * from "./builders.js";
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
