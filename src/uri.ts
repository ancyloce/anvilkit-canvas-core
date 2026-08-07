/**
 * URI scheme safety — the one allowlist this package trusts.
 *
 * ## Why this is its own rank-0 module
 *
 * This logic was written for and lived in `serialize/svg.ts` (rank 5), guarding
 * `<image href>` output. Plan 0021 T-009 needs the same guard for a completely
 * different input — Provider-supplied release-notes and thumbnail URLs, which
 * reach the Libraries UI — and that consumer lives in `component-libraries/` at
 * rank **4**. A rank-4 module cannot import a rank-5 one, so the choice was
 * duplicate the allowlist or move it to the floor.
 *
 * Duplicating a security primitive is how two allowlists drift until only one of
 * them knows about a novel dangerous scheme. It moved. This is the same forcing
 * argument that produced `limits.ts` and `hash.ts`, and `serialize/svg.ts`
 * re-exports every name it used to own, so no importer changed.
 *
 * @see `docs/architecture/src-layer-map.md`
 */

// An ALLOWLIST, not a scheme blocklist, matching the path-`d` discipline: only
// http(s), scheme-less relative/protocol-relative refs, and — when explicitly
// permitted — safe raster `data:` URIs are accepted. Any other scheme
// (javascript:, vbscript:, file:, blob:, filesystem:, ftp:, mailto:, custom:, …)
// is dropped, so a novel dangerous scheme cannot slip past by not being listed.
const ALLOWED_URI_SCHEMES: ReadonlySet<string> = new Set(["http", "https"]);
const URI_SCHEME_RE = /^([a-z][a-z0-9+.-]*):/;

const SAFE_DATA_IMAGE_RE =
	/^data:image\/(?:png|jpe?g|gif|webp|avif)(?:;[^,]*)?,/i;

export interface NormalizeUriOptions {
	readonly allowSafeDataImage?: boolean;
}

/**
 * Returns a safe URI, or `undefined` when the scheme is not allowlisted.
 * Scheme-less (relative or protocol-relative `//…`) refs and `http(s)` are
 * allowed; `data:` URIs are allowed only when `allowSafeDataImage` is set and
 * the payload is a known raster image type; everything else is dropped.
 */
export function normalizeUri(
	input: string,
	options: NormalizeUriOptions = {},
): string | undefined {
	const candidate = input.trim();
	if (!candidate) return undefined;

	const collapsed = stripControlChars(candidate).toLowerCase();

	if (collapsed.startsWith("data:")) {
		return options.allowSafeDataImage && isSafeDataImageUrl(candidate)
			? candidate
			: undefined;
	}

	const scheme = URI_SCHEME_RE.exec(collapsed)?.[1];
	if (scheme && !ALLOWED_URI_SCHEMES.has(scheme)) return undefined;

	return candidate;
}

export function isSafeDataImageUrl(input: string): boolean {
	return SAFE_DATA_IMAGE_RE.test(input);
}

/**
 * The schemes that name **browser-local bytes**: `blob:` and `filesystem:`.
 *
 * Both are deliberately absent from this module's `ALLOWED_URI_SCHEMES` and
 * stay that way — a `blob:` URI is an opaque handle minted by one document in one
 * browsing session, so emitting one into an exported SVG (or any other
 * portable artifact) produces a reference no other machine, and after a reload
 * not even the same machine, can resolve. Referencing one is always wrong.
 *
 * *Resolving* one is not. A caller that can turn the handle back into bytes —
 * `@anvilkit/canvas-editor`'s browser-local asset store, a host's own blob
 * registry — can embed those bytes inline, and then the URI itself never
 * reaches the output at all. This predicate is what lets the SVG serializer
 * offer exactly that class of URI to an injected `SvgFetchAsset` while every
 * other blocked scheme (`javascript:`, `file:`, `ftp:`, …) keeps dropping
 * unconditionally.
 *
 * It lives beside the allowlist, not next to either consumer, for the reason
 * this module exists at all: two places deciding what "browser-local" means is
 * how they drift. `serialize/svg.ts` and the editor's JSON exporter both call
 * this one function, so "which assets are unportable" has a single answer.
 *
 * Control characters are stripped before the scheme test, so `blo\nb:` cannot
 * masquerade as something else — and, symmetrically, cannot smuggle a blocked
 * scheme into the fetchable class.
 */
export function isLocalObjectUri(input: string): boolean {
	if (typeof input !== "string") return false;
	const scheme = URI_SCHEME_RE.exec(
		stripControlChars(input.trim()).toLowerCase(),
	)?.[1];
	return scheme === "blob" || scheme === "filesystem";
}

/**
 * Returns a safe **absolute** http(s) URL, or `undefined`.
 *
 * Stricter than `normalizeUri` in exactly one way, and deliberately so:
 * the scheme is **required**. `normalizeUri` permits scheme-less input because a
 * relative `href` inside an SVG document is meaningful and resolves against that
 * document. A Provider-supplied link has no such base — it is metadata from an
 * untrusted remote catalog that the Editor may render as an anchor or an
 * `<img src>`. A bare `//evil.example` or `some/path` there is either
 * meaningless or a protocol-relative escape, so both are rejected rather than
 * passed through for the UI to resolve against the *app's* origin.
 *
 * `data:` is never accepted here regardless of payload — a catalog has no reason
 * to inline an image, and TD §22.2 names `data:` alongside `javascript:` as the
 * schemes that must not ride in on catalog metadata.
 *
 * Callers must treat `undefined` as "render nothing" (strip), never as "render
 * the raw input".
 */
export function sanitizeProviderUrl(input: string): string | undefined {
	if (typeof input !== "string") return undefined;

	const candidate = input.trim();
	if (!candidate) return undefined;

	// Control characters are stripped before the scheme test so that
	// `java\nscript:` / `java\0script:` cannot smuggle a blocked scheme past a
	// naive prefix check.
	const collapsed = stripControlChars(candidate).toLowerCase();

	const scheme = URI_SCHEME_RE.exec(collapsed)?.[1];
	if (!scheme || !ALLOWED_URI_SCHEMES.has(scheme)) return undefined;

	// Reject anything the platform URL parser will not accept, so a caller never
	// hands a malformed authority to the DOM.
	try {
		new URL(candidate);
	} catch {
		return undefined;
	}

	return candidate;
}

function stripControlChars(input: string): string {
	let out = "";
	for (const ch of input) {
		const cp = ch.charCodeAt(0);
		if (cp <= 0x20 || cp === 0x7f) continue;
		out += ch;
	}
	return out;
}
