/**
 * Brand-policy decision port — **rank anchor only, no contract yet.**
 *
 * This module exists so the layering rank for the policy port is a decided,
 * gate-enforced fact before the first policy symbol is written (plan 0021
 * T-003, decision D-3). It is intentionally empty: the contract itself
 * (`CanvasBrandPolicyContext`, the decision function shape, and the deny
 * reasons) lands with the enforcement gateway in M4 / T-036–T-038.
 *
 * ## Why rank 2, and why that matters
 *
 * A host-implemented port over `ir/` types only — the same shape as
 * `text-contracts.ts` and `comment-contracts.ts`, so it takes the same rank.
 * Rank 2 is load-bearing in two opposite directions:
 *
 * - **`commands/` (rank 3) can import it.** That is what lets every mutation
 *   path consult policy from inside synchronous command application, which is
 *   the only place an atomic deny can happen.
 * - **`clipboard/` (rank 2) cannot** — it is a same-rank sibling, and the gate
 *   permits only strictly-downward edges. Clipboard policy is therefore
 *   enforced in the *caller* (the Editor action layer, and the paste command at
 *   rank >= 3); `clipboard/payload.ts` stays policy-free by construction rather
 *   than by convention. See plan 0021 §4.2 and the `check-layering.mjs`
 *   self-test cases that pin both edges.
 *
 * Placing the port here rather than inside `brand-governance/` (rank 5) is the
 * whole point: rank 5 is unreachable from `commands/`, so a gateway-owned
 * contract could never be consulted where mutations actually happen.
 *
 * @see `scripts/check-layering.mjs` — the ranks and their self-test
 * @see `docs/architecture/src-layer-map.md` — the current rank table
 */

import type { CanvasDocumentLocation } from "./ir/walkers.js";

/**
 * Why a mutation was refused, as a stable code.
 *
 * Deliberately small and closed. These reach a user through localized copy, so
 * a new reason is a deliberate contract change rather than a free-form string
 * a call site can invent.
 */
export type CanvasPolicyDenyReason =
	/** The host's capability snapshot does not permit this operation at all. */
	| "capability-denied"
	/** The property is not in the component policy's editable allowlist. */
	| "property-not-editable"
	/** A policy on the instance path sets `lockStructure`. */
	| "structure-locked"
	/** A policy on the instance path sets `allowDetach: false`. */
	| "detach-denied"
	/** A policy on the instance path sets `allowFlatten: false`. */
	| "flatten-denied"
	/** A policy on the instance path sets `allowVariantChange: false`. */
	| "variant-change-denied"
	/** The value violates a token constraint on that property. */
	| "token-not-allowed";

/**
 * The outcome of asking policy about one operation.
 *
 * Three states, not two: `warn` is what lets a host run in advisory mode, where
 * an edit commits AND is reported. Collapsing `warn` into `allow` would lose
 * the report; collapsing it into `deny` would make advisory mode block.
 */
export interface CanvasPolicyDecision {
	readonly outcome: "allow" | "warn" | "deny";
	readonly reason?: CanvasPolicyDenyReason;
	/** Non-localized detail for logs. Never rendered to a user. */
	readonly detail?: string;
	/** The instance the decision was made about, when one applies. */
	readonly instanceId?: string;
	readonly propertyId?: string;
}

/** Operations policy can be asked about. */
export type CanvasPolicyOperation =
	| "override-set"
	| "override-reset"
	| "variant-change"
	| "structure-edit"
	| "detach"
	| "flatten"
	| "source-update"
	| "source-swap"
	| "insert-external";

/** What the evaluator is being asked. */
export interface CanvasPolicyQuery {
	readonly operation: CanvasPolicyOperation;
	/** Page-level instance id (OD-08). Absent for document-scoped operations. */
	readonly instanceId?: string;
	readonly propertyId?: string;
	readonly location?: CanvasDocumentLocation;
	/**
	 * The value being written, when the operation writes one — used only for
	 * token-constraint checks. `unknown` because this rank must not know brand
	 * value shapes.
	 */
	readonly value?: unknown;
}

/**
 * The port `commands/` (rank 3) calls.
 *
 * `context` is typed `unknown` **on purpose**: the real type is
 * `CanvasBrandPolicyContext`, which lives in `brand-governance/` at rank 5 and
 * is unreachable from here. Passing it opaquely is what lets rank 3 consult
 * policy without any `brand/` import at all (T-038 step 2) — the implementation
 * at rank 5 casts it back. The alternative, moving the brand context down to
 * rank 2, would drag brand vocabulary into a layer that has no business
 * knowing it.
 */
export type CanvasPolicyEvaluator = (
	query: CanvasPolicyQuery,
	context: unknown,
) => CanvasPolicyDecision;

/** An evaluator that permits everything — the default when no host wires one. */
export const CANVAS_ALLOW_ALL_POLICY: CanvasPolicyEvaluator = () => ({
	outcome: "allow",
});
