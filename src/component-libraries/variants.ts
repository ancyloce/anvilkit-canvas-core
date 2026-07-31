/**
 * Component variants — public re-export door (plan 0021 T-024/T-025).
 *
 * The persisted shapes moved to `ir/component-variants.ts` (rank 1) because
 * `variants` is a field on `CanvasComponentDefinition`; the validation and
 * resolution logic moved to `components/variant-resolution.ts` (rank 2) because
 * variant selection is applied inside the resolver, which cannot import upward
 * from this rank-4 domain.
 *
 * This module keeps `@anvilkit/canvas-core/component-libraries` exporting the
 * whole variant surface from one place, as the plan describes.
 */

export {
	canonicalVariantKey,
	type CanvasComponentVariantAxis,
	CanvasComponentVariantAxisSchema,
	type CanvasComponentVariantDefinition,
	CanvasComponentVariantDefinitionSchema,
	type CanvasComponentVariantSelection,
	type CanvasComponentVariantSet,
	CanvasComponentVariantSetSchema,
	type CanvasComponentVariantValue,
	CanvasComponentVariantValueSchema,
} from "../ir/component-variants.js";
export {
	type CanvasComponentVariantIssue,
	type CanvasComponentVariantIssueCode,
	type CanvasComponentVariantResolution,
	type CanvasComponentVariantResolutionCode,
	resolveComponentVariant,
	resolveDefinitionVariant,
	validateComponentVariantSet,
	variantPropertyTarget,
} from "../components/variant-resolution.js";
