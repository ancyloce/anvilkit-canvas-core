import { z } from "zod";

import {
	addComponentVersionIssue,
	COMPONENT_INTEGRITY_SHAPE,
	componentRefField,
} from "../ir/component-source.js";
import type {
	CanvasComponentSourceRef,
	CanvasExternalComponentRef,
} from "./types.js";

/**
 * Schemas for the exact external reference (plan 0021 T-010, TD 0016 §5.1).
 *
 * ## Strict here, loose in `ir/`
 *
 * These use `z.strictObject` — unknown keys are **rejected**. That is the
 * opposite of `ir/validators.ts`, which documents at lines 40-46 why the IR uses
 * `z.looseObject`: the IR is a persisted *and collaborative* wire format, so a
 * replica on an older build must round-trip a newer peer's extra fields instead
 * of silently dropping them.
 *
 * None of that reasoning applies to a reference arriving in a Provider envelope
 * or an imported file. It is one-shot input at a trust boundary, pinned to an
 * exact version, consumed once, never replicated between peers — so an unknown
 * key there is a signal something is wrong, not forward compatibility (OD-01,
 * TD §6.2). The asymmetry is deliberate in **both** directions; please do not
 * "fix" either one to match the other.
 */

/**
 * The field bounds, the exact-version rule, and the digest shape are imported
 * from `ir/component-source.ts` (rank 1) rather than declared here.
 *
 * They are the definition of a legal ref, and a legal ref has to mean the same
 * thing on both sides of the trust boundary — a rule that lived in two places
 * would eventually let a document hold a ref its own envelope schema would have
 * rejected. What differs between the two sides is *strictness only*, and that
 * difference is expressed by the object wrappers below, not by the rules.
 */

/**
 * The exact external reference.
 *
 * `integrity` is checked for *shape* here — an algorithm prefix plus a
 * base64url digest. Which algorithms are actually **supported** is a separate
 * question answered by `parseIntegrity` (T-007), which owns the allowlist and
 * emits the `component-integrity-mismatch`-class diagnostic for anything else.
 * Shape and support are split on purpose: adding an algorithm should be a change
 * to one allowlist, not a schema migration.
 */
const ExternalComponentRefObject = z.strictObject({
	kind: z.literal("library"),
	libraryId: componentRefField(),
	componentId: componentRefField(),
	version: componentRefField(),
	integrity: componentRefField().refine(
		(value) => COMPONENT_INTEGRITY_SHAPE.test(value),
		{
			message:
				'must be an "<algorithm>-<base64url>" digest, e.g. "sha256-47DEQpj8HBSa-_TImW-5JCeuQeRkm5NMpJWZG3hSuFU"',
		},
	),
});

export const CanvasExternalComponentRefSchema: z.ZodType<CanvasExternalComponentRef> =
	ExternalComponentRefObject.superRefine((ref, ctx) => {
		addComponentVersionIssue(ref.version, ctx);
	}) as unknown as z.ZodType<CanvasExternalComponentRef>;

/** The document-local source variant PRD 0015 instances migrate to (T-012). */
export const CanvasLocalComponentSourceRefSchema = z.strictObject({
	kind: z.literal("local"),
	componentId: componentRefField(),
});

/**
 * Either source kind, discriminated on `kind`.
 *
 * `discriminatedUnion` rather than a plain union so a wrong `kind` reports one
 * precise issue on that field instead of the union's full cross-product of
 * failures — which matters because this error text reaches a host integrator.
 */
export const CanvasComponentSourceRefSchema: z.ZodType<CanvasComponentSourceRef> =
	z
		.discriminatedUnion("kind", [
			CanvasLocalComponentSourceRefSchema,
			ExternalComponentRefObject,
		])
		.superRefine((source, ctx) => {
			if (source.kind === "library") {
				addComponentVersionIssue(source.version, ctx);
			}
		}) as unknown as z.ZodType<CanvasComponentSourceRef>;
