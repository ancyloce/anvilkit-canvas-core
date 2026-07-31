/**
 * @file Persisted component variant shapes (plan 0021 T-024/T-025, TD 0016 §11).
 *
 * ## Why this is in `ir/` and not `component-libraries/`
 *
 * `variants` is a field on `CanvasComponentDefinition`, which lives here at
 * rank 1. `component-libraries/` is rank 4 and rank 1 cannot import upward
 * (`scripts/check-layering.mjs`), so the persisted shape has to be declared
 * here — the same relocation `ir/component-source.ts` and `ir/snapshot-key.ts`
 * already made. Validation and resolution are LOGIC over these shapes and live
 * in `components/variant-resolution.ts` (rank 2), next to the resolver that
 * consumes them; the public subpath re-exports both.
 *
 * ## Sparse, not a matrix
 *
 * A component declares axes and values, then declares only the combinations
 * that actually exist. Eight axes of sixteen values is 16^8 dense combinations
 * — a number no cap on axes or values could bound — so the stored set is what
 * is capped, and a missing combination is a normal state resolved by explicit
 * fallback rather than an error.
 *
 * ## Naming
 *
 * Everything is `CanvasComponentVariant*`. `CanvasPageVariantSource` is a
 * different, older concept (page-size campaign variants); the prefix keeps the
 * two from ever being confused (T-024 DoD).
 *
 * ## OD-07: variants live on the DEFINITION
 *
 * Document-local Sources use the same `CanvasComponentDefinition`, so a local
 * Source may legally carry a variant set even though P0 ships no authoring UI
 * for it. Resolution cannot assume "variants implies external".
 */

import { z } from "zod";

import { MAX_EXTERNAL_REF_FIELD_CHARS } from "../limits.js";

/** One axis of variation, e.g. `size` with values `sm`/`md`/`lg`. */
export interface CanvasComponentVariantAxis {
	/** Stable, opaque id. Participates in the canonical key. */
	readonly id: string;
	/** Display label. NEVER participates in a key (T-025 DoD). */
	readonly name?: string;
	readonly values: readonly CanvasComponentVariantValue[];
	/**
	 * Value id used when a selection omits this axis. Must be one of `values`.
	 *
	 * Required, not inferred from the first entry: reordering the array would
	 * otherwise silently change which variant an under-specified selection
	 * resolves to.
	 */
	readonly defaultValueId: string;
}

export interface CanvasComponentVariantValue {
	readonly id: string;
	readonly name?: string;
}

/** A concrete combination: axis id → value id. */
export type CanvasComponentVariantSelection = Readonly<Record<string, string>>;

/** One stored variant — a selection plus the property mapping it implies. */
export interface CanvasComponentVariantDefinition {
	readonly id: string;
	readonly selection: CanvasComponentVariantSelection;
	/**
	 * Property id → the node id that property binds to **in this variant**
	 * (TD §11.1 `propertyTargetMap`).
	 *
	 * This is what makes a variant more than a style swap: the same advertised
	 * Property can point at a different node per variant, so an override written
	 * against the property id keeps working across a variant change.
	 */
	readonly propertyTargetMap?: Readonly<Record<string, string>>;
}

export interface CanvasComponentVariantSet {
	readonly axes: readonly CanvasComponentVariantAxis[];
	readonly variants: readonly CanvasComponentVariantDefinition[];
	/**
	 * Variant used when a selection resolves to nothing. Must exist in
	 * `variants`. Explicit rather than "the first one" for the same reason
	 * `defaultValueId` is.
	 */
	readonly defaultVariantId: string;
}

/**
 * Encode one selection as a stable string.
 *
 * Sorted by axis id and `encodeURIComponent`-escaped per field, joined with
 * reserved separators — the same approach as the snapshot-key codec (T-005),
 * for the same reason: `encodeURIComponent` escapes the separators, so no axis
 * or value id can inject one and make two different selections collide.
 *
 * **No display name participates** (T-025 DoD). Names are localizable and
 * editable; a key built from them would change when a translator edits a label,
 * silently invalidating every persisted selection.
 */
export function canonicalVariantKey(
	selection: CanvasComponentVariantSelection,
): string {
	return Object.keys(selection)
		.sort()
		.map(
			(axisId) =>
				`${encodeURIComponent(axisId)}=${encodeURIComponent(selection[axisId] as string)}`,
		)
		.join("&");
}

const VariantId = z.string().min(1).max(MAX_EXTERNAL_REF_FIELD_CHARS);

export const CanvasComponentVariantValueSchema = z.looseObject({
	id: VariantId,
	name: z.string().optional(),
});

export const CanvasComponentVariantAxisSchema = z.looseObject({
	id: VariantId,
	name: z.string().optional(),
	values: z.array(CanvasComponentVariantValueSchema).min(1),
	defaultValueId: VariantId,
});

export const CanvasComponentVariantDefinitionSchema = z.looseObject({
	id: VariantId,
	selection: z.record(VariantId, VariantId),
	propertyTargetMap: z.record(VariantId, VariantId).optional(),
});

export const CanvasComponentVariantSetSchema: z.ZodType<CanvasComponentVariantSet> =
	z.looseObject({
		axes: z.array(CanvasComponentVariantAxisSchema),
		variants: z.array(CanvasComponentVariantDefinitionSchema),
		defaultVariantId: VariantId,
	}) as unknown as z.ZodType<CanvasComponentVariantSet>;
