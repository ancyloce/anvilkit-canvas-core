/**
 * @file The Source a component instance points at (plan 0021 T-012, TD 0016 §5.1/§5.2).
 *
 * ## Why this lives in `ir/` and not in `component-libraries/`
 *
 * `source` is a **persisted** field on a `component-instance` node, so its type
 * and its schema must be reachable from `ir/types.ts` and `ir/validators.ts`.
 * `ir/` is rank 1 and `component-libraries/` is rank 4 (`scripts/check-layering.mjs`),
 * and rank 1 cannot import upward — so the persisted shape has to be declared
 * here, exactly as `layout/` and `components/` already do for theirs. M0 landed
 * these types in `component-libraries/types.ts` as a placeholder and recorded
 * this move as the follow-up; that module now re-exports from here so the
 * public subpath surface is unchanged.
 *
 * ## Strict at the boundary, loose in the document
 *
 * This module declares the **loose** schema — the one that parses a persisted
 * or peer-replicated document — for the reason `ir/validators.ts` gives at
 * lines 40-46: the IR is a CRDT wire format, so an older replica must
 * round-trip a newer peer's unknown keys instead of deleting them.
 * `component-libraries/schema.ts` declares a **strict** counterpart for the
 * one-shot Provider envelope, where an unknown key is a signal something is
 * wrong rather than forward compatibility.
 *
 * Those two schemas differ in *strictness only*. The field bounds and the
 * exact-version rule are single-sourced HERE and imported downward by the
 * strict side, so the two can never disagree about what a legal ref is.
 */

import { z } from "zod";

import { MAX_EXTERNAL_REF_FIELD_CHARS } from "../limits.js";

/**
 * An **exact, immutable** reference to one version of one external component.
 *
 * Every field is required and none of them is a range. `version` is an opaque
 * exact identifier: hosts may use SemVer, calendar versions, or content hashes,
 * but Canvas only ever compares it for **equality** and displays it. Ordering
 * and "is an update available" come from Provider metadata, never from parsing
 * this string — which is why range and channel syntax is rejected at parse time
 * rather than tolerated and ignored.
 *
 * `integrity` is a Subresource-Integrity-style `sha256-<base64url>` digest of
 * the component's canonical bytes. Because it participates in the snapshot key,
 * the same logical version published twice with different bytes produces a
 * *different* key — so a Provider cannot substitute content under a version a
 * document already trusts (TD §22.1, same-version content substitution).
 */
export interface CanvasExternalComponentRef {
	kind: "library";
	/** Opaque host identifier for the library. Not a display name. */
	libraryId: string;
	/** Opaque identifier for the component within `libraryId`. */
	componentId: string;
	/** Opaque exact version. Compared for equality only; never ordered. */
	version: string;
	/** `sha256-<base64url>` digest of the canonical component bytes. */
	integrity: string;
}

/** A Source defined inside this document's own `ir.components` registry. */
export interface CanvasLocalComponentSourceRef {
	kind: "local";
	/** Registry key in `CanvasIR.components`. */
	componentId: string;
}

/**
 * Where an instance's Source comes from — the same field for both kinds.
 *
 * A discriminated union on `kind` so a resolver handles both in one place
 * (TD §10, the shared local/external resolver) and TypeScript makes a missing
 * case an error rather than a silent fallthrough to "local".
 *
 * PRD 0015 shipped local instances carrying a bare `componentId`; the instance
 * schema migrates those to `{ kind: "local", componentId }` on read — see
 * `CanvasComponentInstanceNodeSchema` in `./validators.js`.
 */
export type CanvasComponentSourceRef =
	| CanvasLocalComponentSourceRef
	| CanvasExternalComponentRef;

/** Narrow a source ref to the external variant. */
export function isExternalSourceRef(
	source: CanvasComponentSourceRef,
): source is CanvasExternalComponentRef {
	return source.kind === "library";
}

/** Narrow a source ref to the document-local variant. */
export function isLocalSourceRef(
	source: CanvasComponentSourceRef,
): source is CanvasLocalComponentSourceRef {
	return source.kind === "local";
}

/**
 * The registry key for a **local** Source, or `undefined` for an external one.
 *
 * The one accessor every `ir.components[…]` lookup goes through. It exists
 * because "which document-local definition does this instance use" and "which
 * Source does this instance use" stopped being the same question the moment
 * `source` became a union — and a call site that answers the second question
 * with the first silently treats every external instance as local.
 */
export function localComponentIdOf(
	source: CanvasComponentSourceRef,
): string | undefined {
	return source.kind === "local" ? source.componentId : undefined;
}

/**
 * A stable, human-readable label for a Source — diagnostics and messages only.
 *
 * Never a registry key and never persisted: the external form is lossy on
 * purpose (it omits `integrity`, which is unreadable and would swamp the
 * message). Use {@link localComponentIdOf} to look anything up.
 */
export function componentSourceLabel(source: CanvasComponentSourceRef): string {
	return source.kind === "local"
		? source.componentId
		: `${source.libraryId}/${source.componentId}@${source.version}`;
}

/**
 * Structural equality for two Sources.
 *
 * Field-wise rather than `JSON.stringify` because key order is not part of the
 * value: two refs that differ only in property order are the same Source, and a
 * stringify-based compare would call them different and duplicate a snapshot.
 */
export function componentSourceRefsEqual(
	a: CanvasComponentSourceRef,
	b: CanvasComponentSourceRef,
): boolean {
	if (a.kind !== b.kind) return false;
	if (a.kind === "local" || b.kind === "local") {
		return a.componentId === b.componentId;
	}
	return (
		a.libraryId === b.libraryId &&
		a.componentId === b.componentId &&
		a.version === b.version &&
		a.integrity === b.integrity
	);
}

/**
 * True when `value` contains a C0 or C1 control character.
 *
 * A code-unit scan rather than a regex on purpose. The equivalent character
 * class can only be written with escape sequences, and writing it with literal
 * control bytes — which is easy to do by accident — produces a file that is no
 * longer text and a class that silently does not match what it looks like it
 * matches. This form cannot be corrupted that way and is faster besides.
 */
function hasControlCharacters(value: string): boolean {
	for (let i = 0; i < value.length; i += 1) {
		const code = value.charCodeAt(i);
		if (code <= 0x1f || (code >= 0x7f && code <= 0x9f)) return true;
	}
	return false;
}

/**
 * One reference field: 1-256 characters, no C0/C1 control characters.
 *
 * A factory rather than a shared schema instance because the strict envelope
 * side refines it further; handing out one frozen instance would make those
 * refinements accumulate onto this module's schema too.
 */
export function componentRefField(): z.ZodString {
	return z
		.string()
		.min(1)
		.max(MAX_EXTERNAL_REF_FIELD_CHARS)
		.refine((value) => !hasControlCharacters(value), {
			message: "must not contain C0/C1 control characters",
		}) as unknown as z.ZodString;
}

/** Digest shape: `<algorithm>-<base64url>`. */
export const COMPONENT_INTEGRITY_SHAPE =
	/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*-[A-Za-z0-9_-]+={0,2}$/;

/**
 * Version strings that look like a range, a channel, or a floating pointer.
 *
 * Canvas compares `version` for **equality only** — ordering and update
 * availability come from Provider metadata (TD §5.1). A range would therefore
 * not be "resolved later", it would be stored and compared as the literal
 * string `^1.0.0`, matching nothing and silently never updating. Rejecting at
 * parse time turns that silent dead end into a loud, named failure.
 *
 * `latest` is called out separately because it is the single most likely value
 * a host integration will try, and the one whose failure mode — a document
 * whose rendering depends on whatever the service returns today — is exactly
 * what the immutable-snapshot design exists to prevent.
 */
const RANGE_OR_CHANNEL_CHARS = /[\^~*<>=|\s]/;
const FLOATING_VERSION_WORDS = new Set([
	"latest",
	"next",
	"stable",
	"canary",
	"beta",
	"alpha",
	"dev",
	"edge",
	"head",
	"main",
	"master",
]);
/** `1.x`, `1.2.x`, `1.X` — an implicit range with no range operator. */
const WILDCARD_SEGMENT = /(?:^|\.)[xX*](?:$|\.)/;

/** The exact-version rule. `null` means the version is acceptable. */
export function componentVersionProblem(version: string): string | null {
	if (FLOATING_VERSION_WORDS.has(version.trim().toLowerCase())) {
		return `"${version}" is a floating channel, not an exact version. Canvas compares versions for equality only and never resolves them, so a document pinned to a channel would silently never match a snapshot. Supply the exact version the Provider resolved it to.`;
	}
	if (RANGE_OR_CHANNEL_CHARS.test(version)) {
		return `"${version}" contains range or channel syntax. Versions are opaque and compared for equality only; ranges are never resolved, so this would match nothing. Supply the exact version.`;
	}
	if (WILDCARD_SEGMENT.test(version)) {
		return `"${version}" contains a wildcard segment. Versions are opaque and compared for equality only; wildcards are never expanded. Supply the exact version.`;
	}
	// A bare hyphen range "1.0.0-2.0.0" is indistinguishable from a legitimate
	// SemVer prerelease ("1.0.0-rc.1"), so it is NOT rejected — a false reject on
	// a real prerelease is worse than accepting an odd exact string, because the
	// value is opaque to us either way.
	return null;
}

/**
 * Report the version rule as an issue on the `version` path.
 *
 * Shared by every schema that carries a ref rather than applied once to a
 * wrapped schema: `z.discriminatedUnion` requires plain object members, so a
 * union cannot take an already-refined schema. One shared
 * {@link componentVersionProblem} keeps the *rule* single-sourced even though
 * the wiring is applied at each site.
 */
export function addComponentVersionIssue(
	version: string,
	ctx: { addIssue: (issue: z.core.$ZodRawIssue) => void },
): void {
	const problem = componentVersionProblem(version);
	if (problem) {
		ctx.addIssue({
			code: "custom",
			path: ["version"],
			message: problem,
		} as z.core.$ZodRawIssue);
	}
}

/**
 * The persisted external ref, **loose** (CON-5).
 *
 * Unknown keys survive a round trip; the field bounds and the version rule are
 * the same ones the strict envelope side enforces.
 */
export const CanvasIRExternalComponentRefSchema = z.looseObject({
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

/** The persisted local ref, loose for the same reason. */
export const CanvasIRLocalComponentSourceRefSchema = z.looseObject({
	kind: z.literal("local"),
	componentId: componentRefField(),
});

/**
 * The persisted `source` field.
 *
 * `discriminatedUnion` rather than a plain union so a wrong `kind` reports one
 * precise issue on that field instead of the union's full cross-product of
 * failures.
 */
export const CanvasIRComponentSourceRefSchema: z.ZodType<CanvasComponentSourceRef> =
	z
		.discriminatedUnion("kind", [
			CanvasIRLocalComponentSourceRefSchema,
			CanvasIRExternalComponentRefSchema,
		])
		.superRefine((source, ctx) => {
			if (source.kind === "library") {
				addComponentVersionIssue(source.version, ctx);
			}
		}) as unknown as z.ZodType<CanvasComponentSourceRef>;
