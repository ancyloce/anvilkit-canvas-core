import { MAX_TREE_DEPTH } from "../limits.js";
import { CanvasCanonicalizationError } from "./errors.js";

/**
 * RFC 8785 (JSON Canonicalization Scheme) canonicalizer — the integrity
 * preimage (plan 0021 T-006, TD 0016 §6.2, OD-02).
 *
 * # ⚠ DIGEST-CRITICAL MODULE — changing it invalidates every stored snapshot
 *
 * The bytes this module produces are what gets hashed into a component's
 * `integrity` value, and that digest is part of the snapshot registry **key**.
 * Any change to the output — a different escape, a different key order, a
 * different number rendering, adding or removing a normalization step — changes
 * every digest, which means:
 *
 * - every snapshot already stored in every saved document fails verification;
 * - those documents' components resolve to `component-integrity-mismatch`;
 * - the keys no longer match `snapshotKey(entry.ref)`, so the registry
 *   invariant fails too.
 *
 * There is no migration for this, because the old bytes cannot be recovered from
 * the new ones. Treat an edit here as a **breaking format change** requiring a
 * `canonicalFormatVersion` bump and an explicit re-admission path, never as a
 * refactor. The committed goldens under `__tests__/fixtures/canonical/` exist to
 * make an accidental change loudly fail rather than silently ship.
 *
 * # Why JCS rather than a bespoke profile
 *
 * JCS's two hard parts are already native here (TD §6.2):
 *
 * - it sorts object keys by **UTF-16 code unit**, which is exactly what
 *   `Array.prototype.sort()` does on JS strings — no comparator needed, and no
 *   locale to get wrong;
 * - it specifies number formatting as ECMAScript `Number::toString`, which is
 *   what `JSON.stringify` already emits, pinned by ECMA-262 rather than by us.
 *
 * String escaping likewise defers to `JSON.stringify`, which RFC 8785 §3.2.2.2
 * describes: shortest-form escapes, and (since ES2019 well-formed
 * `JSON.stringify`) lone surrogates escaped to ASCII `\\udXXX`. That last detail
 * matters more than it looks: it means `TextEncoder` never sees an unpaired
 * surrogate, so it can never substitute U+FFFD and silently change the preimage.
 *
 * # The three rules layered on top of JCS
 *
 * 1. **NFC normalization** of every string value *and* every key, so visually
 *    identical identifiers typed on different platforms cannot produce different
 *    digests (TD §6.2). Keys are normalized *before* sorting, otherwise two
 *    NFC-equal keys could order differently depending on their input form.
 * 2. **Non-finite numbers are rejected**, not coerced. `JSON.stringify` turns
 *    `NaN`/`Infinity` into `null`, which would make two different payloads hash
 *    the same.
 * 3. **Only plain JSON data is accepted.** A `Date`, `Map`, class instance, or
 *    anything with a `toJSON` is refused rather than silently flattened, because
 *    `toJSON` puts the preimage under the input object's control.
 */

const TEXT_ENCODER = new TextEncoder();

/**
 * Canonical UTF-8 bytes for `value`.
 *
 * @throws {CanvasCanonicalizationError} for non-finite numbers, non-JSON types,
 * cycles, excessive depth, or keys that collide after NFC normalization.
 */
export function canonicalizeComponentPayload(value: unknown): Uint8Array {
	return TEXT_ENCODER.encode(canonicalizeComponentPayloadToString(value));
}

/**
 * The canonical form as a JS string.
 *
 * Exposed alongside the byte form because goldens and cross-runtime comparisons
 * are far more readable as text, and because the byte form is a pure
 * `TextEncoder` application of it. Digest callers should use
 * {@link canonicalizeComponentPayload}.
 */
export function canonicalizeComponentPayloadToString(value: unknown): string {
	return emit(value, 0, new Set<object>());
}

function nfc(value: string): string {
	return value.normalize("NFC");
}

function isPlainObject(value: object): boolean {
	const proto = Object.getPrototypeOf(value);
	return proto === Object.prototype || proto === null;
}

function emit(value: unknown, depth: number, seen: Set<object>): string {
	if (depth > MAX_TREE_DEPTH) {
		throw new CanvasCanonicalizationError(
			"depth-exceeded",
			`payload nests deeper than ${MAX_TREE_DEPTH} levels`,
		);
	}

	if (value === null) return "null";

	switch (typeof value) {
		case "boolean":
			return value ? "true" : "false";

		case "number": {
			if (!Number.isFinite(value)) {
				throw new CanvasCanonicalizationError(
					"non-finite-number",
					`${String(value)} has no canonical JSON form; JSON.stringify would coerce it to null and make two different payloads hash identically`,
				);
			}
			// ECMA-262 Number::toString, which is what RFC 8785 §3.2.2.3 specifies.
			// Also renders -0 as "0", matching JCS.
			return JSON.stringify(value) as string;
		}

		case "string":
			return JSON.stringify(nfc(value));

		case "bigint":
			throw new CanvasCanonicalizationError(
				"unsupported-type",
				"bigint has no JSON representation",
			);

		case "undefined":
			throw new CanvasCanonicalizationError(
				"unsupported-type",
				"undefined has no JSON representation in this position (object properties holding undefined are omitted instead)",
			);

		case "function":
		case "symbol":
			throw new CanvasCanonicalizationError(
				"unsupported-type",
				`${typeof value} has no JSON representation`,
			);

		case "object":
			return emitObject(value as object, depth, seen);

		default:
			throw new CanvasCanonicalizationError(
				"unsupported-type",
				`unexpected type ${typeof value}`,
			);
	}
}

function emitObject(value: object, depth: number, seen: Set<object>): string {
	if (seen.has(value)) {
		throw new CanvasCanonicalizationError(
			"cyclic-reference",
			"payload contains a cycle and has no finite canonical form",
		);
	}

	if (typeof (value as { toJSON?: unknown }).toJSON === "function") {
		throw new CanvasCanonicalizationError(
			"unsupported-type",
			"objects with a toJSON method are refused: toJSON would put the digest preimage under the payload's own control",
		);
	}

	seen.add(value);
	try {
		if (Array.isArray(value)) {
			// Arrays are semantically ordered; JCS preserves their order.
			const items = value.map((item) => {
				if (item === undefined) {
					throw new CanvasCanonicalizationError(
						"unsupported-type",
						"array holes / undefined elements have no canonical form (JSON.stringify would emit null and lose the distinction)",
					);
				}
				return emit(item, depth + 1, seen);
			});
			return `[${items.join(",")}]`;
		}

		if (!isPlainObject(value)) {
			throw new CanvasCanonicalizationError(
				"unsupported-type",
				`only plain objects and arrays are canonicalizable; received ${value.constructor?.name ?? "an exotic object"}`,
			);
		}

		// Own enumerable string keys only — the same set JSON.stringify walks.
		// Symbol keys are invisible to JSON and are therefore ignored, not an error.
		const normalized = new Map<string, string>();
		for (const [rawKey, propertyValue] of Object.entries(value)) {
			// Properties holding `undefined` are OMITTED, matching JSON.stringify.
			// This is load-bearing: an optional envelope field left explicitly
			// `undefined` must hash the same as one that is absent, or the digest
			// would depend on how the parser happened to fill the object.
			if (propertyValue === undefined) continue;

			const key = nfc(rawKey);
			if (normalized.has(key)) {
				throw new CanvasCanonicalizationError(
					"duplicate-key-after-normalization",
					`keys "${rawKey}" and another collide as "${key}" after NFC normalization, so the payload has no unambiguous canonical form`,
				);
			}
			normalized.set(key, emit(propertyValue, depth + 1, seen));
		}

		// RFC 8785: sort by UTF-16 code unit. Default string sort does exactly that.
		const keys = [...normalized.keys()].sort();
		const members = keys.map(
			(key) => `${JSON.stringify(key)}:${normalized.get(key) as string}`,
		);
		return `{${members.join(",")}}`;
	} finally {
		seen.delete(value);
	}
}
