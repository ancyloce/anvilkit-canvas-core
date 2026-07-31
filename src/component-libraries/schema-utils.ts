import { z } from "zod";

import {
	MAX_EXTERNAL_DISPLAY_STRING_CHARS,
	MAX_EXTERNAL_REF_FIELD_CHARS,
	MAX_EXTERNAL_URL_CHARS,
} from "../limits.js";
import { sanitizeProviderUrl } from "../uri.js";

/**
 * Strict, bounded schema helpers for the untrusted Provider boundary
 * (plan 0021 T-008, OD-01).
 *
 * # The strict/loose asymmetry, stated in both directions
 *
 * `ir/validators.ts:40-46` documents why the **IR** uses `z.looseObject`, and
 * that reasoning is correct and must not be changed: the Canvas IR is a versioned
 * persisted *and collaborative* wire format, so a replica running an older build
 * has to round-trip a newer peer's unknown fields rather than silently delete
 * them. Stripping would lose data and break CRDT convergence, and preserved
 * unknown keys are inert because consumers only read known fields.
 *
 * **None of that applies to a Provider envelope**, and this is the other half of
 * the asymmetry:
 *
 * | | Canvas IR | Provider envelope |
 * | --- | --- | --- |
 * | Lifetime | persisted, long-lived | one-shot response |
 * | Replicated between peers? | yes (CRDT) | no |
 * | Version negotiation | mixed-version swarm | pinned to an exact version |
 * | Unknown key means | a newer peer knows something we don't | something is wrong |
 * | Posture | `looseObject` (preserve) | `strictObject` (**reject**) |
 *
 * An envelope is consumed once, at a trust boundary, and its content is about to
 * be hashed into a digest that becomes a registry key. An unknown key there is
 * either a Provider bug or an attempt to smuggle content past validation — and
 * critically, unknown keys must never reach the canonical preimage (TD §6.2), so
 * rejecting them is what keeps the digest well-defined.
 *
 * So: **loose in `ir/`, strict here, on purpose. Please do not "fix" either one to
 * match the other.** Both call sites carry a pointer to the other.
 */

/**
 * A `z.strictObject` for envelope shapes — unknown keys are rejected.
 *
 * A named wrapper rather than calling `z.strictObject` directly so that every
 * trust-boundary schema in this domain is greppable as one set, and so the
 * rationale above has exactly one place to live.
 */
export function strictEnvelopeObject<Shape extends z.ZodRawShape>(
	shape: Shape,
) {
	return z.strictObject(shape);
}

/**
 * An identifier-scale bounded string (1–{@link MAX_EXTERNAL_REF_FIELD_CHARS}).
 *
 * Bounded *before* any allocation-heavy work, per TD §22.2.
 */
export function boundedIdentifier() {
	return z.string().min(1).max(MAX_EXTERNAL_REF_FIELD_CHARS);
}

/**
 * A display-scale bounded string for non-authoritative catalog metadata.
 *
 * Catalog metadata is excluded from integrity bytes (TD §5.4), so no digest
 * constrains it — this bound is the only guard it gets.
 */
export function boundedDisplayString() {
	return z.string().max(MAX_EXTERNAL_DISPLAY_STRING_CHARS);
}

/**
 * A Provider-supplied URL: length-bounded, then scheme-checked.
 *
 * Transforms to `undefined` when the URL is unsafe rather than failing the whole
 * envelope. That is deliberate: a `javascript:` thumbnail is a reason to render no
 * thumbnail, not a reason to refuse an otherwise valid, integrity-verified
 * component. Callers must treat `undefined` as "render nothing" — which is why
 * {@link sanitizeProviderUrl} never returns its input on rejection.
 */
export function boundedProviderUrl() {
	return z
		.string()
		.max(MAX_EXTERNAL_URL_CHARS)
		.transform((value) => sanitizeProviderUrl(value))
		.optional();
}
