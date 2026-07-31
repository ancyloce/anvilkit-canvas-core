/**
 * @file The brand-token type union — a leaf, imported by both sides.
 *
 * Extracted from `ir/types.ts` (plan 0021 T-036) to break a genuine import
 * cycle that `check:circular` caught: `types.ts` needs
 * `CanvasBrandComponentPolicy` from `component-policy.ts`, and
 * `component-policy.ts` needs this union from `types.ts`. A module with no
 * imports of its own cannot participate in a cycle, so both now depend on it
 * and neither on the other.
 *
 * `ir/types.ts` re-exports it, so `BrandTokenType`'s public import path is
 * unchanged for every existing consumer.
 */

/**
 * The kinds of value a brand kit owns. Referenced by `BrandTokenRef` (the
 * shape of an unresolved reference) and by `CanvasBrandTokenConstraint` (which
 * kinds a policy permits on a property).
 */
export type BrandTokenType = "color" | "font" | "spacing" | "asset" | "logo";
