/**
 * @file Persisted brand policy shapes (plan 0021 T-036, TD 0016 §14.1).
 *
 * ## Why this is in `ir/` and not `brand-governance/`
 *
 * A policy is part of a component's **canonical payload**: it rides inside the
 * snapshot, is covered by the integrity digest, and is replicated to every peer
 * (T-036 step 2). So it is a field on `CanvasComponentDefinition`, which lives
 * here at rank 1 — and rank 1 cannot import `brand-governance/` at rank 5. The
 * command-time half (capabilities, context, validation) stays there and
 * re-exports these, exactly as `ir/component-source.ts`,
 * `ir/component-variants.ts` and `ir/snapshot-key.ts` already do.
 *
 * ## Portable means "carries no identity"
 *
 * These shapes describe **what may be edited**, never **who may edit it**: no
 * user, role, tenant, token or credential field exists, and
 * `validateBrandComponentPolicy` rejects a policy carrying one. Identity is the
 * host's and reaches Core only as a boolean capability snapshot. That split is
 * what makes a document shareable — two users with different permissions open
 * the same bytes and get different *capabilities*, not different *documents*.
 */

import { z } from "zod";

import type { BrandTokenType } from "./brand-tokens.js";

/** Which token values a property may take. */
export interface CanvasBrandTokenConstraint {
	readonly tokenType: BrandTokenType;
	/**
	 * Token ids the property may use. Absent means "any token of this type".
	 * An EMPTY array means "none" — the two are deliberately different.
	 */
	readonly allowedTokenIds?: readonly string[];
	/**
	 * Whether a literal (non-token) value is allowed at all. Default `true`, so
	 * a policy that only lists tokens does not silently forbid literals.
	 */
	readonly allowLiteral?: boolean;
}

/** What a component permits inside instances of itself. */
export interface CanvasBrandComponentPolicy {
	/**
	 * Property ids an instance may override. Absent = all advertised
	 * properties; empty array = none.
	 */
	readonly editablePropertyIds?: readonly string[];
	/** Per-property token constraints, keyed by Property ID. */
	readonly tokenConstraints?: Readonly<
		Record<string, CanvasBrandTokenConstraint>
	>;
	/**
	 * Forbid structural edits inside the instance (reorder, insert, delete).
	 * A `true` anywhere on the instance path wins — see the intersection rule
	 * in `command-policy.ts`.
	 */
	readonly lockStructure?: boolean;
	/** Whether the instance may be detached from its Source. Default `true`. */
	readonly allowDetach?: boolean;
	/** Whether the instance may be flattened during export. Default `true`. */
	readonly allowFlatten?: boolean;
	/** Whether a variant selection may be changed. Default `true`. */
	readonly allowVariantChange?: boolean;
	/**
	 * Whether instances may be moved to a different VERSION of this same
	 * component. Default `true`.
	 *
	 * TD §15.1 lists "Update/swap" as governed by portable policy; these are the
	 * fields that make it so.
	 */
	readonly allowSourceUpdate?: boolean;
	/**
	 * Whether instances may be replaced by a DIFFERENT component. Default `true`.
	 *
	 * Separate from {@link allowSourceUpdate} because the two are different
	 * risks and a brand owner may reasonably want opposite answers: "take my bug
	 * fixes, but do not let anyone substitute a different component for our logo
	 * lockup" is `allowSourceUpdate: true` with `allowSourceSwap: false`. One
	 * combined field would force those together — the same reason `allowDetach`
	 * and `allowFlatten` are separate despite sharing a row in that table.
	 */
	readonly allowSourceSwap?: boolean;
	/**
	 * What the component AUTHOR recommends when the host is enforcing.
	 *
	 * Only a recommendation: the host's `enforcement` mode is what decides
	 * whether a violation blocks (OD-10). A component cannot escalate itself
	 * into blocking a host that is only warning.
	 */
	readonly recommendedEnforcement?: "warning" | "blocking";
}


/* ── Schemas ─────────────────────────────────────────────────────────────── */

const PolicyId = z.string().min(1);

export const CanvasBrandTokenConstraintSchema = z.looseObject({
	tokenType: z.enum(["color", "font", "spacing", "asset", "logo"]),
	allowedTokenIds: z.array(PolicyId).optional(),
	allowLiteral: z.boolean().optional(),
});

/**
 * Loose, like every persisted shape (CON-5): a policy authored by a newer build
 * must round-trip through this one rather than have its unknown fields deleted.
 * The identity-field scan in `validateBrandComponentPolicy` is what stops that
 * looseness being abused — it inspects unknown keys precisely because they
 * survive here.
 */
export const CanvasBrandComponentPolicySchema: z.ZodType<CanvasBrandComponentPolicy> =
	z.looseObject({
		editablePropertyIds: z.array(PolicyId).optional(),
		tokenConstraints: z
			.record(PolicyId, CanvasBrandTokenConstraintSchema)
			.optional(),
		lockStructure: z.boolean().optional(),
		allowDetach: z.boolean().optional(),
		allowFlatten: z.boolean().optional(),
		allowVariantChange: z.boolean().optional(),
		allowSourceUpdate: z.boolean().optional(),
		allowSourceSwap: z.boolean().optional(),
		recommendedEnforcement: z.enum(["warning", "blocking"]).optional(),
	}) as unknown as z.ZodType<CanvasBrandComponentPolicy>;
