/**
 * @file Portable brand policy and the command-time capability snapshot
 * (plan 0021 T-036/T-037, TD 0016 §14).
 *
 * ## Portable means "carries no identity"
 *
 * A policy travels inside a component snapshot, is covered by its integrity
 * digest, and is replicated to every peer that opens the document. So it must
 * describe **what may be edited**, never **who may edit it**: no user, role,
 * group, tenant, token, or credential field exists here, and
 * `validateBrandComponentPolicy` rejects a policy carrying one. Identity is the
 * host's, evaluated at runtime, and reaches Core only as the boolean snapshot
 * in {@link CanvasBrandCapabilities}.
 *
 * That split is what makes a document shareable: two users with different
 * permissions open the same bytes and get different *capabilities*, not
 * different *documents*.
 *
 * ## The capability snapshot is data, never callbacks
 *
 * `CanvasBrandPolicyContext` is JSON-round-trippable by construction (T-037
 * DoD). Command application is synchronous and must be deterministic and
 * replayable — a callback would make the same command produce different results
 * on replay, on a peer, or in a worker, and would make an audit trail
 * unverifiable.
 */

import type {
	CanvasBrandComponentPolicy,
	CanvasBrandTokenConstraint,
} from "../ir/component-policy.js";

export type {
	CanvasBrandComponentPolicy,
	CanvasBrandTokenConstraint,
} from "../ir/component-policy.js";
export { CanvasBrandComponentPolicySchema } from "../ir/component-policy.js";

/* ── Policy (T-036, §14.1) ───────────────────────────────────────────────── */

/* ── Capability snapshot (T-037, §14.2/§14.3) ────────────────────────────── */

/**
 * What THIS session's user may do, as plain booleans.
 *
 * Computed by the host from its own identity model and handed to Core already
 * decided. Core never asks who the user is.
 */
export interface CanvasBrandCapabilities {
	readonly canEditOverrides: boolean;
	readonly canChangeVariant: boolean;
	readonly canDetach: boolean;
	readonly canFlatten: boolean;
	readonly canInsertExternalComponents: boolean;
	readonly canUpdateComponents: boolean;
	/**
	 * Per-instance allowlist of editable Property IDs, keyed by the
	 * **persistent page-level instance id** (OD-08).
	 *
	 * Page-level rather than per-virtual-node because a virtual id is derived
	 * from a resolution and changes when a Source or variant changes — a
	 * capability keyed on one would silently lapse on the next edit. Absent for
	 * an instance means "no per-instance narrowing"; an empty array means
	 * "nothing editable on this instance".
	 */
	readonly editablePropertyIdsByInstance?: Readonly<
		Record<string, readonly string[]>
	>;
}

/**
 * Everything the command layer needs to make a policy decision.
 *
 * Serializable end to end (T-037 DoD): no function-valued field, so the whole
 * context can be persisted with an audit record, replayed, or shipped to a
 * worker and produce identical decisions.
 */
export interface CanvasBrandPolicyContext {
	/**
	 * `off` — evaluate nothing. `warning` — report, never block. `blocking` —
	 * a violation of a policy whose `recommendedEnforcement` is `"blocking"`
	 * aborts the command.
	 */
	readonly enforcement: "off" | "warning" | "blocking";
	readonly capabilities: CanvasBrandCapabilities;
	/**
	 * The Brand Kit id this context was resolved against, when one applies.
	 * An id, not the kit: the kit itself is large and already in the document.
	 */
	readonly resolvedBrandKitId?: string;
	/**
	 * Opaque host revision. When it changes, cached decisions and compliance
	 * results are stale — it participates in the compliance cache key (T-043)
	 * and lets the Editor refresh mid-session (T-040).
	 */
	readonly policyRevision?: string;
}

/* ── Validation (T-036 steps 3-4) ────────────────────────────────────────── */

export type CanvasBrandPolicyIssueCode =
	| "policy-identity-field"
	| "policy-unknown-property"
	| "policy-unknown-token-constraint"
	| "policy-empty-token-allowlist-with-literals-denied";

export interface CanvasBrandPolicyIssue {
	readonly code: CanvasBrandPolicyIssueCode;
	readonly message: string;
	readonly propertyId?: string;
	readonly field?: string;
}

/**
 * Field names that would make a policy carry identity.
 *
 * Matched case-insensitively against a policy's own keys, including unknown
 * ones — the policy travels inside a `looseObject` snapshot, so a host could
 * otherwise smuggle `{ allowedUserIds: [...] }` through as an unknown key and
 * have it replicated to every peer, which is a privacy leak rather than a
 * policy.
 */
const IDENTITY_FIELD_PATTERNS = [
	"user",
	"role",
	"group",
	"tenant",
	"member",
	"actor",
	"principal",
	"account",
	"email",
	"token",
	"credential",
	"secret",
	"apikey",
	"password",
	"permission",
	"grant",
];

function looksLikeIdentityField(key: string): boolean {
	const normalized = key.toLowerCase().replace(/[^a-z]/g, "");
	// `recommendedEnforcement` and `tokenConstraints` legitimately contain
	// "token"/"enforcement"-ish substrings, so the known-good keys are exempt
	// before the pattern scan rather than the patterns being weakened.
	return IDENTITY_FIELD_PATTERNS.some((pattern) =>
		normalized.includes(pattern),
	);
}

const KNOWN_POLICY_KEYS: ReadonlySet<string> = new Set([
	"editablePropertyIds",
	"tokenConstraints",
	"lockStructure",
	"allowDetach",
	"allowFlatten",
	"allowVariantChange",
	"allowSourceUpdate",
	"allowSourceSwap",
	"recommendedEnforcement",
]);

/**
 * Validate a policy against the definition that carries it.
 *
 * Reports every issue rather than throwing on the first — a policy is authored
 * once and its author wants the whole list.
 */
export function validateBrandComponentPolicy(
	policy: CanvasBrandComponentPolicy,
	knownPropertyIds: readonly string[] = [],
): readonly CanvasBrandPolicyIssue[] {
	const issues: CanvasBrandPolicyIssue[] = [];
	const known = new Set(knownPropertyIds);

	// Identity scan runs over the policy's OWN keys, so an unknown key smuggled
	// through the loose snapshot schema is caught too.
	for (const key of Object.keys(policy)) {
		if (KNOWN_POLICY_KEYS.has(key)) continue;
		if (looksLikeIdentityField(key)) {
			issues.push({
				code: "policy-identity-field",
				field: key,
				message: `Policy field "${key}" looks like identity. A policy describes what may be edited, never who may edit it — identity belongs in the host's capability snapshot, which is never replicated.`,
			});
		}
	}

	for (const propertyId of policy.editablePropertyIds ?? []) {
		if (!known.has(propertyId)) {
			issues.push({
				code: "policy-unknown-property",
				propertyId,
				message: `Policy allows editing "${propertyId}", which this component does not advertise.`,
			});
		}
	}

	for (const [propertyId, constraint] of Object.entries(
		policy.tokenConstraints ?? {},
	)) {
		if (!known.has(propertyId)) {
			issues.push({
				code: "policy-unknown-token-constraint",
				propertyId,
				message: `Policy constrains tokens on "${propertyId}", which this component does not advertise.`,
			});
		}
		// An empty allowlist WITH literals denied permits nothing at all — almost
		// certainly a mistake, and one that presents to the user as an
		// unexplained "you cannot set this".
		if (
			constraint.allowedTokenIds?.length === 0 &&
			constraint.allowLiteral === false
		) {
			issues.push({
				code: "policy-empty-token-allowlist-with-literals-denied",
				propertyId,
				message: `Property "${propertyId}" permits no token and no literal, so it can never be given a value.`,
			});
		}
	}

	return issues;
}

/**
 * Is this context free of anything unserializable?
 *
 * Used by a test and available to hosts. Cheap structural check rather than a
 * schema, because the contract is "no functions anywhere", not a shape.
 */
export function isSerializablePolicyContext(
	context: CanvasBrandPolicyContext,
): boolean {
	const seen = new Set<unknown>();
	const walk = (value: unknown): boolean => {
		if (typeof value === "function") return false;
		if (!value || typeof value !== "object") return true;
		if (seen.has(value)) return true;
		seen.add(value);
		return Object.values(value as Record<string, unknown>).every(walk);
	};
	return walk(context);
}

/** A context that denies nothing — the default when a host wires no policy. */
export const CANVAS_PERMISSIVE_POLICY_CONTEXT: CanvasBrandPolicyContext = {
	enforcement: "off",
	capabilities: {
		canEditOverrides: true,
		canChangeVariant: true,
		canDetach: true,
		canFlatten: true,
		canInsertExternalComponents: true,
		canUpdateComponents: true,
	},
};
