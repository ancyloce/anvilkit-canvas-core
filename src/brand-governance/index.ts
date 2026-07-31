/**
 * `@anvilkit/canvas-core/brand-governance` — portable brand policy, the
 * command-time capability snapshot, and the compliance surface built on them
 * (plan 0021 M4).
 *
 * ## Why this is a subpath and not part of the root barrel
 *
 * Governance is opt-in: a host that does not enforce brand policy should not
 * pay for the policy evaluator, the compliance scanner, or their caches in the
 * 80 KB root budget. The persisted *shapes* a document can carry
 * (`CanvasBrandComponentPolicy`) live in `ir/` and are re-exported from the
 * root barrel as types, which are erased — values stay here.
 *
 * ## Layering
 *
 * Rank 5. It may read `brand/` (4), `component-libraries/` (4), `commands/`
 * (3), `components/` (2), and `ir/` (1). The one thing it must NOT do is be
 * imported by `commands/` — which is why the decision port it implements lives
 * at `src/policy-contracts.ts` (rank 2) instead.
 */

/**
 * The decision port itself lives at rank 2 (`src/policy-contracts.ts`) so
 * `commands/` can depend on it. It is re-exported HERE because this subpath is
 * where a host looks for governance, and because the root barrel deliberately
 * does not carry governance values (see the file header).
 */
export type {
	CanvasPolicyDecision,
	CanvasPolicyDenyReason,
	CanvasPolicyEvaluator,
	CanvasPolicyOperation,
	CanvasPolicyQuery,
} from "../policy-contracts.js";
export { CANVAS_ALLOW_ALL_POLICY } from "../policy-contracts.js";
export * from "./command-policy.js";
export * from "./compliance-cache.js";
export * from "./compliance.js";
export * from "./types.js";
