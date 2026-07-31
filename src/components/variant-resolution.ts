/**
 * @file Component variant validation and resolution (plan 0021 T-024/T-025, TD §11).
 *
 * The persisted SHAPES live in `ir/component-variants.ts` (rank 1), because
 * `variants` is a field on `CanvasComponentDefinition` and `ir/` cannot import
 * upward. This module is the logic over them, and it lives at rank 2 with the
 * resolver that consumes it — variant selection is applied BEFORE instance
 * overrides (T-025 step 3), which is resolver work.
 *
 * The public `@anvilkit/canvas-core/component-libraries` subpath re-exports
 * both halves, so the surface the plan describes is unchanged.
 */

import {
	canonicalVariantKey,
	type CanvasComponentVariantAxis,
	type CanvasComponentVariantDefinition,
	type CanvasComponentVariantSelection,
	type CanvasComponentVariantSet,
} from "../ir/component-variants.js";
import type {
	CanvasComponentDefinition,
	CanvasComponentProperty,
} from "../ir/types.js";
import {
	MAX_COMPONENT_VARIANT_AXES,
	MAX_COMPONENT_VARIANT_VALUES_PER_AXIS,
	MAX_COMPONENT_VARIANTS_PER_COMPONENT,
} from "../limits.js";

export type CanvasComponentVariantIssueCode =
	| "variant-duplicate-axis"
	| "variant-duplicate-value"
	| "variant-duplicate-id"
	| "variant-duplicate-selection"
	| "variant-unknown-axis"
	| "variant-unknown-value"
	| "variant-missing-default"
	| "variant-property-unresolved"
	| "variant-limit-exceeded";

export interface CanvasComponentVariantIssue {
	readonly code: CanvasComponentVariantIssueCode;
	readonly message: string;
	readonly variantId?: string;
	readonly axisId?: string;
}

function propertyIds(
	properties: readonly CanvasComponentProperty[],
): ReadonlySet<string> {
	return new Set(properties.map((p) => p.id));
}

/**
 * Validate a variant set against the definition that carries it.
 *
 * Reports every issue rather than throwing on the first: a definition arriving
 * from a Provider is validated once, and an author fixing it wants the whole
 * list. Ordering is deterministic (axes then variants, both in declared order)
 * so a diagnostic diff is stable.
 */
export function validateComponentVariantSet(
	set: CanvasComponentVariantSet,
	properties: readonly CanvasComponentProperty[] = [],
): readonly CanvasComponentVariantIssue[] {
	const issues: CanvasComponentVariantIssue[] = [];
	const known = propertyIds(properties);

	if (set.axes.length > MAX_COMPONENT_VARIANT_AXES) {
		issues.push({
			code: "variant-limit-exceeded",
			message: `Variant set declares ${set.axes.length} axes (max ${MAX_COMPONENT_VARIANT_AXES}).`,
		});
	}
	if (set.variants.length > MAX_COMPONENT_VARIANTS_PER_COMPONENT) {
		issues.push({
			code: "variant-limit-exceeded",
			message: `Variant set declares ${set.variants.length} variants (max ${MAX_COMPONENT_VARIANTS_PER_COMPONENT}).`,
		});
	}

	const axisById = new Map<string, CanvasComponentVariantAxis>();
	for (const axis of set.axes) {
		if (axisById.has(axis.id)) {
			issues.push({
				code: "variant-duplicate-axis",
				message: `Axis "${axis.id}" is declared more than once.`,
				axisId: axis.id,
			});
			continue;
		}
		axisById.set(axis.id, axis);

		if (axis.values.length > MAX_COMPONENT_VARIANT_VALUES_PER_AXIS) {
			issues.push({
				code: "variant-limit-exceeded",
				message: `Axis "${axis.id}" declares ${axis.values.length} values (max ${MAX_COMPONENT_VARIANT_VALUES_PER_AXIS}).`,
				axisId: axis.id,
			});
		}
		const seenValues = new Set<string>();
		for (const value of axis.values) {
			if (seenValues.has(value.id)) {
				issues.push({
					code: "variant-duplicate-value",
					message: `Axis "${axis.id}" declares value "${value.id}" more than once.`,
					axisId: axis.id,
				});
			}
			seenValues.add(value.id);
		}
		if (!seenValues.has(axis.defaultValueId)) {
			issues.push({
				code: "variant-missing-default",
				message: `Axis "${axis.id}" defaults to "${axis.defaultValueId}", which is not one of its values.`,
				axisId: axis.id,
			});
		}
	}

	const seenVariantIds = new Set<string>();
	const seenSelections = new Set<string>();
	for (const variant of set.variants) {
		if (seenVariantIds.has(variant.id)) {
			issues.push({
				code: "variant-duplicate-id",
				message: `Variant id "${variant.id}" is declared more than once.`,
				variantId: variant.id,
			});
		}
		seenVariantIds.add(variant.id);

		for (const [axisId, valueId] of Object.entries(variant.selection)) {
			const axis = axisById.get(axisId);
			if (!axis) {
				issues.push({
					code: "variant-unknown-axis",
					message: `Variant "${variant.id}" selects unknown axis "${axisId}".`,
					variantId: variant.id,
					axisId,
				});
				continue;
			}
			if (!axis.values.some((v) => v.id === valueId)) {
				issues.push({
					code: "variant-unknown-value",
					message: `Variant "${variant.id}" selects "${valueId}" on axis "${axisId}", which is not a declared value.`,
					variantId: variant.id,
					axisId,
				});
			}
		}

		// Canonical, so two selections that differ only in key order collide.
		const key = canonicalVariantKey(variant.selection);
		if (seenSelections.has(key)) {
			issues.push({
				code: "variant-duplicate-selection",
				message: `More than one variant resolves to the same combination (${key || "the empty selection"}).`,
				variantId: variant.id,
			});
		}
		seenSelections.add(key);

		// Every ADVERTISED property must resolve in every variant (TD §11.2):
		// a variant that silently drops a property would make an override
		// disappear on selection rather than be reported.
		for (const [propertyId, nodeId] of Object.entries(
			variant.propertyTargetMap ?? {},
		)) {
			if (!known.has(propertyId)) {
				issues.push({
					code: "variant-property-unresolved",
					message: `Variant "${variant.id}" maps unknown property "${propertyId}".`,
					variantId: variant.id,
				});
			}
			if (typeof nodeId !== "string" || nodeId.length === 0) {
				issues.push({
					code: "variant-property-unresolved",
					message: `Variant "${variant.id}" maps property "${propertyId}" to an empty node id.`,
					variantId: variant.id,
				});
			}
		}
	}

	if (!seenVariantIds.has(set.defaultVariantId)) {
		issues.push({
			code: "variant-missing-default",
			message: `Variant set defaults to "${set.defaultVariantId}", which is not one of its variants.`,
		});
	}

	return issues;
}

/* ── Resolution (TD §11.4) ───────────────────────────────────────────────── */

export type CanvasComponentVariantResolutionCode =
	| "resolved"
	/** The selection named a combination that does not exist; default used. */
	| "fallback-unknown-combination"
	/** The selection named an axis or value the set does not declare. */
	| "fallback-invalid-selection";

export interface CanvasComponentVariantResolution {
	readonly variant: CanvasComponentVariantDefinition;
	readonly code: CanvasComponentVariantResolutionCode;
	/** The selection after axis defaults were filled in. */
	readonly normalizedSelection: CanvasComponentVariantSelection;
	/** Present when `code` is a fallback — for the `component-variant-invalid` diagnostic. */
	readonly message?: string;
}

/**
 * Resolve a (possibly partial, possibly stale) selection to a concrete variant.
 *
 * Order, per §11.4: **normalize with axis defaults → exact lookup → explicit
 * default variant**. Normalizing first is what makes a partial selection
 * meaningful — a document that persists only `{ tone: "brand" }` still resolves
 * deterministically once `size` is filled from its axis default.
 *
 * Never throws: a stale selection is a normal state for a document written
 * against an older version of a component, and it degrades to the default with
 * a diagnostic rather than taking a render down.
 */
export function resolveComponentVariant(
	set: CanvasComponentVariantSet,
	selection: CanvasComponentVariantSelection | undefined,
): CanvasComponentVariantResolution | undefined {
	const fallback = set.variants.find((v) => v.id === set.defaultVariantId);
	// A set with no valid default is malformed; validation reports it. Resolution
	// returns `undefined` so a caller renders the base definition rather than
	// inventing a variant.
	if (!fallback) return undefined;

	const normalized: Record<string, string> = {};
	let invalid: string | undefined;

	for (const axis of set.axes) {
		const requested = selection?.[axis.id];
		if (requested === undefined) {
			normalized[axis.id] = axis.defaultValueId;
			continue;
		}
		if (axis.values.some((v) => v.id === requested)) {
			normalized[axis.id] = requested;
			continue;
		}
		invalid ??= `Axis "${axis.id}" has no value "${requested}"; its default was used instead.`;
		normalized[axis.id] = axis.defaultValueId;
	}

	// An axis the set does not declare at all — a selection written against a
	// newer version. Recorded, but never fatal.
	for (const axisId of Object.keys(selection ?? {})) {
		if (!set.axes.some((a) => a.id === axisId)) {
			invalid ??= `Selection names unknown axis "${axisId}"; it was ignored.`;
		}
	}

	const wanted = canonicalVariantKey(normalized);
	const exact = set.variants.find(
		(v) => canonicalVariantKey(v.selection) === wanted,
	);

	if (exact && invalid === undefined) {
		return {
			variant: exact,
			code: "resolved",
			normalizedSelection: normalized,
		};
	}
	if (exact) {
		return {
			variant: exact,
			code: "fallback-invalid-selection",
			normalizedSelection: normalized,
			message: invalid,
		};
	}
	return {
		variant: fallback,
		code: invalid
			? "fallback-invalid-selection"
			: "fallback-unknown-combination",
		normalizedSelection: normalized,
		message:
			invalid ??
			`No variant matches ${wanted || "the empty selection"}; the default variant "${set.defaultVariantId}" was used.`,
	};
}

/**
 * The node a property binds to for a given variant.
 *
 * Falls back to the definition's own `nodeId` when the variant does not remap
 * it — the common case, since `propertyTargetMap` only lists what MOVES.
 */
export function variantPropertyTarget(
	property: CanvasComponentProperty,
	variant: CanvasComponentVariantDefinition | undefined,
): string {
	return variant?.propertyTargetMap?.[property.id] ?? property.nodeId;
}

/** Convenience: resolve against whatever variant set a definition carries. */
export function resolveDefinitionVariant(
	definition: CanvasComponentDefinition,
	selection: CanvasComponentVariantSelection | undefined,
): CanvasComponentVariantResolution | undefined {
	const set = definition.variants;
	return set ? resolveComponentVariant(set, selection) : undefined;
}

