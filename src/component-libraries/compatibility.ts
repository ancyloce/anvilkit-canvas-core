/**
 * @file Structural compatibility between two component definitions
 * (plan 0021 T-028/T-029, TD 0016 §12.1/§12.3/§12.4).
 *
 * ## Structural, never fuzzy
 *
 * Everything here compares IDs, types, and declared semantic keys. There is no
 * display-name matching, no string similarity, no "looks like the same field"
 * heuristic — because the output drives an *irreversible-looking* operation
 * (update/swap) whose preview a user is asked to trust. A fuzzy match that is
 * right 95% of the time silently corrupts one document in twenty, and the user
 * has no way to tell which. Anything not provably the same slot is reported as
 * orphaned and the data is retained.
 *
 * ## Deterministic ordering
 *
 * Every list is sorted by a stable key, so two runs over the same inputs
 * produce byte-identical reports and a preview diff is reviewable (T-029 DoD).
 *
 * ## Placement
 *
 * Rank 4, as the plan specifies. It imports only `ir/` (rank 1) and its only
 * consumers are the update/swap commands and the editor dialogs — nothing in
 * the resolver needs it. Keeping it here rather than in `components/` (rank 2)
 * also keeps it OFF the 80 KB root barrel, which no consumer of compatibility
 * reporting has to pay for.
 */

import { canonicalVariantKey } from "../ir/component-variants.js";
import type {
	CanvasComponentDefinition,
	CanvasComponentOverride,
	CanvasComponentOverrideMap,
	CanvasComponentProperty,
} from "../ir/types.js";

/* ── Semantic keys (T-028) ───────────────────────────────────────────────── */

/**
 * `ns:name` — a namespace, a colon, then a name.
 *
 * The namespace requirement is the whole point: it makes a semantic key read as
 * an identifier a component author chose deliberately, not as a label that got
 * reused. A bare word like `Title` is rejected because it is exactly what a
 * localized display string looks like, and migration keyed on a localized
 * string would behave differently per authoring language.
 */
const SEMANTIC_KEY_RE = /^[a-z0-9][a-z0-9._-]*:[A-Za-z0-9][A-Za-z0-9._-]*$/;

export type CanvasSemanticKeyIssueCode =
	| "semantic-key-malformed"
	| "semantic-key-duplicate";

export interface CanvasSemanticKeyIssue {
	readonly code: CanvasSemanticKeyIssueCode;
	readonly propertyId: string;
	readonly semanticKey: string;
	readonly message: string;
}

/**
 * Validate the semantic keys declared by one definition.
 *
 * Uniqueness is enforced **per property kind**, not globally: a `text` and an
 * `image` property may legitimately share the key `card:hero` because they
 * describe the same slot in different media, and migration matches on
 * (key, kind) anyway. Two `text` properties sharing a key is ambiguous and is
 * rejected.
 */
export function validateSemanticKeys(
	properties: readonly CanvasComponentProperty[],
): readonly CanvasSemanticKeyIssue[] {
	const issues: CanvasSemanticKeyIssue[] = [];
	const seen = new Map<string, string>();

	for (const property of properties) {
		const key = property.semanticKey;
		if (key === undefined) continue;

		if (!SEMANTIC_KEY_RE.test(key)) {
			issues.push({
				code: "semantic-key-malformed",
				propertyId: property.id,
				semanticKey: key,
				message: `Semantic key "${key}" on property "${property.id}" must be namespaced, e.g. "acme.card:title". An un-namespaced value is indistinguishable from a display label.`,
			});
			continue;
		}
		// NUL separator written as an ESCAPE, never a literal byte (repo
		// convention, review 0022): a raw control character makes the file
		// non-text. NUL is safe here because a property kind is a closed enum
		// and a semantic key is `ns:name` — neither can contain one.
		const scoped = `${property.kind}\u0000${key}`;
		const owner = seen.get(scoped);
		if (owner !== undefined) {
			issues.push({
				code: "semantic-key-duplicate",
				propertyId: property.id,
				semanticKey: key,
				message: `Semantic key "${key}" is declared by both "${owner}" and "${property.id}" for kind "${property.kind}"; it cannot identify a slot.`,
			});
			continue;
		}
		seen.set(scoped, property.id);
	}
	return issues;
}

/* ── Compatibility report (TD §12.3) ─────────────────────────────────────── */

/** How an override on `from` maps onto `to`. */
export type CanvasPropertyMappingKind =
	/** Same property id, same kind — the unambiguous case. */
	| "exact"
	/** Different id, but one property on each side shares a semantic key + kind. */
	| "semantic"
	/** The semantic key matches more than one candidate; refuse to guess. */
	| "ambiguous"
	/** A match exists but the kinds differ, so the value cannot transfer. */
	| "blocked"
	/** No counterpart at all. */
	| "orphaned";

export interface CanvasPropertyMapping {
	readonly fromPropertyId: string;
	readonly toPropertyId?: string;
	readonly kind: CanvasPropertyMappingKind;
	readonly reason?: string;
}

export interface CanvasVariantMapping {
	readonly axisId: string;
	/** `true` when the target declares the same axis id. */
	readonly retained: boolean;
	/** Value ids present on `from` but not on `to`. Sorted. */
	readonly droppedValueIds: readonly string[];
}

export interface CanvasDependencyChange {
	readonly componentId: string;
	readonly change: "added" | "removed";
}

export type CanvasComponentCompatibilityClass =
	| "compatible"
	| "review-required"
	| "incompatible";

export interface CanvasComponentCompatibilityReport {
	readonly classification: CanvasComponentCompatibilityClass;
	readonly properties: readonly CanvasPropertyMapping[];
	readonly variants: readonly CanvasVariantMapping[];
	readonly dependencies: readonly CanvasDependencyChange[];
	/** Property ids on `to` that have no counterpart on `from`. Sorted. */
	readonly addedPropertyIds: readonly string[];
}

function byFromPropertyId(
	a: CanvasPropertyMapping,
	b: CanvasPropertyMapping,
): number {
	return a.fromPropertyId < b.fromPropertyId ? -1 : 1;
}

/**
 * Compare two definitions and describe what an override migration would do.
 *
 * Pure and read-only. The classification is the *worst* outcome present:
 * anything blocked makes the whole change `incompatible`; anything ambiguous or
 * orphaned makes it `review-required`; otherwise `compatible`.
 */
export function compareComponentDefinitions(
	from: CanvasComponentDefinition,
	to: CanvasComponentDefinition,
): CanvasComponentCompatibilityReport {
	const toById = new Map(to.properties.map((p) => [p.id, p]));

	// Semantic index, keyed by (kind, key). A key claimed by more than one
	// property on the target is AMBIGUOUS and deliberately unusable — recorded
	// as a null so the lookup below can tell "absent" from "too many".
	const toBySemantic = new Map<string, CanvasComponentProperty | null>();
	for (const property of to.properties) {
		if (property.semanticKey === undefined) continue;
		const scoped = `${property.kind}\u0000${property.semanticKey}`;
		toBySemantic.set(scoped, toBySemantic.has(scoped) ? null : property);
	}

	const properties: CanvasPropertyMapping[] = [];
	const matchedToIds = new Set<string>();

	for (const property of from.properties) {
		const exact = toById.get(property.id);
		if (exact) {
			if (exact.kind === property.kind) {
				matchedToIds.add(exact.id);
				properties.push({
					fromPropertyId: property.id,
					toPropertyId: exact.id,
					kind: "exact",
				});
			} else {
				properties.push({
					fromPropertyId: property.id,
					toPropertyId: exact.id,
					kind: "blocked",
					reason: `Property "${property.id}" is "${property.kind}" here and "${exact.kind}" in the target; the value cannot transfer.`,
				});
			}
			continue;
		}

		if (property.semanticKey !== undefined) {
			const scoped = `${property.kind}\u0000${property.semanticKey}`;
			const candidate = toBySemantic.get(scoped);
			if (candidate === null) {
				properties.push({
					fromPropertyId: property.id,
					kind: "ambiguous",
					reason: `Semantic key "${property.semanticKey}" matches more than one property in the target; refusing to guess.`,
				});
				continue;
			}
			if (candidate !== undefined) {
				matchedToIds.add(candidate.id);
				properties.push({
					fromPropertyId: property.id,
					toPropertyId: candidate.id,
					kind: "semantic",
				});
				continue;
			}
		}

		properties.push({
			fromPropertyId: property.id,
			kind: "orphaned",
			reason: `No property in the target has this id${property.semanticKey ? " or semantic key" : ""}.`,
		});
	}

	properties.sort(byFromPropertyId);

	// Variants: axis-level, matched by axis ID only (never by name).
	const fromAxes = from.variants?.axes ?? [];
	const toAxes = to.variants?.axes ?? [];
	const toAxisById = new Map(toAxes.map((a) => [a.id, a]));
	const variants: CanvasVariantMapping[] = fromAxes
		.map((axis) => {
			const target = toAxisById.get(axis.id);
			const targetValues = new Set((target?.values ?? []).map((v) => v.id));
			return {
				axisId: axis.id,
				retained: target !== undefined,
				droppedValueIds: axis.values
					.map((v) => v.id)
					.filter((id) => !targetValues.has(id))
					.sort(),
			};
		})
		.sort((a, b) => (a.axisId < b.axisId ? -1 : 1));

	// Dependencies, by the local component ids each definition's tree references.
	const dependencies = diffDependencies(from, to);

	const addedPropertyIds = to.properties
		.map((p) => p.id)
		.filter((id) => !matchedToIds.has(id))
		.sort();

	const hasBlocked = properties.some((p) => p.kind === "blocked");
	const needsReview =
		properties.some((p) => p.kind === "ambiguous" || p.kind === "orphaned") ||
		variants.some((v) => !v.retained || v.droppedValueIds.length > 0) ||
		dependencies.length > 0;

	return {
		classification: hasBlocked
			? "incompatible"
			: needsReview
				? "review-required"
				: "compatible",
		properties,
		variants,
		dependencies,
		addedPropertyIds,
	};
}

function collectComponentIds(
	definition: CanvasComponentDefinition,
): ReadonlySet<string> {
	const ids = new Set<string>();
	const stack: unknown[] = [definition.root];
	while (stack.length > 0) {
		const node = stack.pop();
		if (!node || typeof node !== "object") continue;
		const typed = node as {
			type?: string;
			source?: { kind?: string; componentId?: string };
			children?: unknown[];
		};
		if (typed.type === "component-instance" && typed.source?.componentId) {
			ids.add(typed.source.componentId);
		}
		if (Array.isArray(typed.children)) stack.push(...typed.children);
	}
	return ids;
}

function diffDependencies(
	from: CanvasComponentDefinition,
	to: CanvasComponentDefinition,
): readonly CanvasDependencyChange[] {
	const before = collectComponentIds(from);
	const after = collectComponentIds(to);
	const changes: CanvasDependencyChange[] = [];
	for (const id of after) {
		if (!before.has(id)) changes.push({ componentId: id, change: "added" });
	}
	for (const id of before) {
		if (!after.has(id)) changes.push({ componentId: id, change: "removed" });
	}
	return changes.sort((a, b) =>
		a.componentId === b.componentId
			? a.change < b.change
				? -1
				: 1
			: a.componentId < b.componentId
				? -1
				: 1,
	);
}

/* ── Override migration (TD §12.4) ───────────────────────────────────────── */

export interface CanvasOverrideMigrationResult {
	/** Overrides that transferred, keyed by TARGET property id. */
	readonly overrides: CanvasComponentOverrideMap;
	/**
	 * Overrides that did not transfer, keyed by their ORIGINAL property id.
	 *
	 * Retained verbatim, never dropped and never reassigned (INV-6): a user who
	 * undoes, or who swaps back, gets their data. Orphans are also what the
	 * preview counts.
	 */
	readonly orphaned: CanvasComponentOverrideMap;
	readonly mappings: readonly CanvasPropertyMapping[];
}

/**
 * Carry an instance's overrides from one definition to another.
 *
 * Precedence, per §12.4: **exact property id + kind → unique semantic key +
 * kind → ambiguous → blocked → orphaned**. Everything that is not a provable
 * match is orphaned with its value retained.
 *
 * Never invents a value: an override appears in the output only if it appeared
 * in the input. A target property with no incoming override is simply absent,
 * so it renders its own default.
 */
export function migrateComponentOverrides(
	overrides: CanvasComponentOverrideMap | undefined,
	report: CanvasComponentCompatibilityReport,
): CanvasOverrideMigrationResult {
	const migrated: Record<string, CanvasComponentOverride> = {};
	const orphaned: Record<string, CanvasComponentOverride> = {};
	if (!overrides) {
		return { overrides: migrated, orphaned, mappings: report.properties };
	}

	const byFrom = new Map(report.properties.map((m) => [m.fromPropertyId, m]));

	for (const propertyId of Object.keys(overrides).sort()) {
		const value = overrides[propertyId];
		if (!value) continue;
		const mapping = byFrom.get(propertyId);

		if (
			mapping &&
			(mapping.kind === "exact" || mapping.kind === "semantic") &&
			mapping.toPropertyId !== undefined
		) {
			migrated[mapping.toPropertyId] = value;
			continue;
		}
		// ambiguous / blocked / orphaned, and any override whose property the
		// source definition no longer declares (already an orphan before this
		// migration) all land here with their data intact.
		orphaned[propertyId] = value;
	}

	return { overrides: migrated, orphaned, mappings: report.properties };
}

/** Convenience: does this report describe a change safe to apply unattended? */
export function isCompatible(
	report: CanvasComponentCompatibilityReport,
): boolean {
	return report.classification === "compatible";
}

/** Stable digest of a selection, re-exported so callers need one import. */
export { canonicalVariantKey };
