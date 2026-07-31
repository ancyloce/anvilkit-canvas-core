/**
 * @file `component-instance.set-variant` (plan 0021 T-026, TD 0016 §11.5).
 *
 * ## One variant change, one Undo entry, orphans retained
 *
 * A variant change can move where an advertised Property binds
 * (`propertyTargetMap`), so an override written against a property id may or
 * may not still apply afterwards. The command classifies each override, keeps
 * everything that transfers, and **retains** what does not rather than dropping
 * it — so switching to a variant and back returns the user's data.
 *
 * ## Why it stores the selection the user made, not the normalized one
 *
 * The persisted `variantSelection` is exactly what was chosen. Normalizing it
 * first (filling every axis from today's defaults) would freeze those defaults
 * into the document, so a component author later changing an axis default would
 * never reach existing instances. Normalization happens at resolve time.
 *
 * Registered through the extension seam for the same rank-4 reason as the other
 * library commands.
 */

import { CanvasCommandError } from "../../commands/runtime.js";
import type {
	CommandApplyOptions,
	CommandApplyResult,
} from "../../commands/types.js";
import { resolveComponentVariant } from "../../components/variant-resolution.js";
import type { CanvasComponentVariantSelection } from "../../ir/component-variants.js";
import { updateNode } from "../../ir/mutations.js";
import type {
	CanvasComponentDefinition,
	CanvasComponentInstanceNode,
	CanvasComponentOverrideMap,
	CanvasIR,
} from "../../ir/types.js";
import type { CanvasDocumentLocation } from "../../ir/walkers.js";
import { findNode } from "../../ir/walkers.js";

export const SET_VARIANT_COMMAND = "component-instance.set-variant";

export interface CanvasComponentSetVariantCommand {
	readonly type: typeof SET_VARIANT_COMMAND;
	readonly instanceId: string;
	/**
	 * The selection to store. Partial is fine and expected — unspecified axes
	 * resolve from their defaults.
	 */
	readonly selection: CanvasComponentVariantSelection;
	readonly location?: CanvasDocumentLocation;
	/**
	 * Discard overrides that no longer apply instead of retaining them.
	 *
	 * Default `false`. Retention is the safe default because the alternative
	 * silently destroys user content on a reversible-looking UI action; a caller
	 * must ask for the destructive behaviour explicitly.
	 */
	readonly discardOrphans?: boolean;
}

/** How one override fared across a variant change (surfaced for the preview). */
export interface CanvasVariantOverrideOutcome {
	readonly propertyId: string;
	readonly outcome: "preserved" | "orphaned";
	readonly reason?: string;
}

export interface CanvasVariantChangeSummary {
	readonly resolvedVariantId: string | undefined;
	readonly outcomes: readonly CanvasVariantOverrideOutcome[];
}

export interface CanvasComponentRestoreVariantCommand {
	readonly type: typeof SET_VARIANT_COMMAND;
	readonly instanceId: string;
	readonly selection: CanvasComponentVariantSelection;
	readonly location?: CanvasDocumentLocation;
	readonly discardOrphans?: boolean;
	/** Overrides to restore verbatim — set only by an inverse. */
	readonly restoreOverrides?: CanvasComponentOverrideMap;
}

function definitionFor(
	ir: CanvasIR,
	instance: CanvasComponentInstanceNode,
): CanvasComponentDefinition | undefined {
	if (instance.source.kind === "local") {
		return ir.components?.[instance.source.componentId];
	}
	// External: the snapshot registry is the render authority (T-016).
	for (const snapshot of Object.values(ir.externalComponentSnapshots ?? {})) {
		if (
			snapshot.ref.libraryId === instance.source.libraryId &&
			snapshot.ref.componentId === instance.source.componentId &&
			snapshot.ref.version === instance.source.version &&
			snapshot.ref.integrity === instance.source.integrity
		) {
			return snapshot.definition;
		}
	}
	return undefined;
}

/**
 * Classify every override against the target variant.
 *
 * An override survives when the target variant still resolves its property to
 * some node. `propertyTargetMap` only lists properties that MOVE, so a property
 * the map does not mention keeps the definition's own binding and is preserved.
 */
function classifyOverrides(
	definition: CanvasComponentDefinition,
	overrides: CanvasComponentOverrideMap | undefined,
	targetVariantId: string | undefined,
): CanvasVariantOverrideOutcome[] {
	if (!overrides) return [];
	const variant = definition.variants?.variants.find(
		(v) => v.id === targetVariantId,
	);
	const declared = new Set(definition.properties.map((p) => p.id));

	return Object.keys(overrides)
		.sort()
		.map((propertyId) => {
			if (!declared.has(propertyId)) {
				// Already an orphan before this change — the definition does not
				// advertise this property at all.
				return {
					propertyId,
					outcome: "orphaned" as const,
					reason: `Property "${propertyId}" is not advertised by this component.`,
				};
			}
			const remapped = variant?.propertyTargetMap?.[propertyId];
			if (remapped !== undefined && remapped.length === 0) {
				return {
					propertyId,
					outcome: "orphaned" as const,
					reason: `Variant "${targetVariantId}" does not bind property "${propertyId}".`,
				};
			}
			return { propertyId, outcome: "preserved" as const };
		});
}

function applySetVariant(
	ir: CanvasIR,
	cmd: CanvasComponentSetVariantCommand & {
		readonly restoreOverrides?: CanvasComponentOverrideMap;
	},
	options: CommandApplyOptions,
): CommandApplyResult<CanvasComponentRestoreVariantCommand> {
	const found = findNode(ir, cmd.instanceId);
	if (!found || found.node.type !== "component-instance") {
		throw new CanvasCommandError(
			"node-not-found",
			`No component instance "${cmd.instanceId}" in this document.`,
		);
	}
	const instance = found.node as CanvasComponentInstanceNode;
	const definition = definitionFor(ir, instance);
	if (!definition) {
		// Setting a variant on an unresolvable Source would write a selection
		// nothing can interpret; refusing keeps the document honest.
		throw new CanvasCommandError(
			"component-snapshot-missing",
			`Instance "${cmd.instanceId}" has no resolvable Source, so its variant cannot be set.`,
		);
	}
	if (!definition.variants) {
		throw new CanvasCommandError(
			"invariant-violated",
			`Component "${definition.id}" declares no variants.`,
		);
	}

	const resolution = resolveComponentVariant(
		definition.variants,
		cmd.selection,
	);
	const outcomes = classifyOverrides(
		definition,
		instance.overrides,
		resolution?.variant.id,
	);

	const previousSelection = instance.variantSelection;
	const previousOverrides = instance.overrides;

	// An inverse restores overrides verbatim; a forward command keeps whatever
	// survived (or everything, when retaining).
	let nextOverrides = cmd.restoreOverrides ?? instance.overrides;
	if (cmd.restoreOverrides === undefined && cmd.discardOrphans === true) {
		const kept: Record<string, CanvasComponentOverrideMap[string]> = {};
		for (const outcome of outcomes) {
			if (outcome.outcome !== "preserved") continue;
			const value = instance.overrides?.[outcome.propertyId];
			if (value) kept[outcome.propertyId] = value;
		}
		nextOverrides = kept;
	}

	// Explicit type argument: `updateNode` infers the node kind from `K`, and
	// without it the patch is checked against the whole node union rather than
	// against `component-instance`.
	const next = updateNode<"component-instance">(ir, {
		id: cmd.instanceId,
		patch: {
			// Stored as CHOSEN, not normalized — see the module header.
			//
			// An EMPTY selection is stored as ABSENT, not as `{}`: the two are
			// indistinguishable in meaning, and `mergeNodePatch` deletes a key
			// whose patch value is `undefined`. Without this, undoing back to
			// "no selection" would leave `variantSelection: {}` behind and the
			// document would not equal its pre-change self (the same omit-empty
			// rule `components` and the snapshot registry follow, INV-10).
			variantSelection:
				Object.keys(cmd.selection).length > 0 ? cmd.selection : undefined,
			...(nextOverrides !== undefined ? { overrides: nextOverrides } : {}),
		},
		...(cmd.location !== undefined ? { location: cmd.location } : {}),
		now: options.now,
	});

	return {
		ir: next,
		inverse: {
			type: SET_VARIANT_COMMAND,
			instanceId: cmd.instanceId,
			selection: previousSelection ?? {},
			...(cmd.location !== undefined ? { location: cmd.location } : {}),
			// Restore the exact prior override map, so undoing a discard returns
			// the discarded data.
			...(previousOverrides !== undefined
				? { restoreOverrides: previousOverrides }
				: {}),
		},
	};
}

/**
 * Preview a variant change without touching the document.
 *
 * The dialog/inspector calls this to show what would be preserved and what
 * would be orphaned BEFORE committing (T-026 step 4).
 */
export function previewVariantChange(
	ir: CanvasIR,
	instanceId: string,
	selection: CanvasComponentVariantSelection,
): CanvasVariantChangeSummary | undefined {
	const found = findNode(ir, instanceId);
	if (!found || found.node.type !== "component-instance") return undefined;
	const instance = found.node as CanvasComponentInstanceNode;
	const definition = definitionFor(ir, instance);
	if (!definition?.variants) return undefined;
	const resolution = resolveComponentVariant(definition.variants, selection);
	return {
		resolvedVariantId: resolution?.variant.id,
		outcomes: classifyOverrides(
			definition,
			instance.overrides,
			resolution?.variant.id,
		),
	};
}

/** The handler, for registration through `createCanvasRuntime`. */
export function createSetVariantCommandHandlers() {
	return [{ type: SET_VARIANT_COMMAND, apply: applySetVariant }] as const;
}
