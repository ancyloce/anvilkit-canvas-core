import type {
	CanvasNodeKindRegistry,
	CanvasSvgHookContext,
	CanvasUnknownNode,
} from "../extensions/node-kind-registry.js";
import { toAffineMatrix } from "../geometry/affine.js";
import {
	computePolygonVertices,
	computeStarVertices,
} from "../geometry/polygon.js";
import type {
	BrandTokenRef,
	CanvasAssetRef,
	CanvasAudioNode,
	CanvasEllipseNode,
	CanvasFill,
	CanvasFontFamily,
	CanvasFrameNode,
	CanvasGradientFill,
	CanvasGroupNode,
	CanvasImageNode,
	CanvasIR,
	CanvasLineNode,
	CanvasNode,
	CanvasNodeBase,
	CanvasPage,
	CanvasPathNode,
	CanvasPolygonNode,
	CanvasRectNode,
	CanvasRichTextNode,
	CanvasShadow,
	CanvasStarNode,
	CanvasSvgNode,
	CanvasTextAlign,
	CanvasTextNode,
	CanvasTransform,
	CanvasUnit,
	CanvasVideoNode,
	FramePlaceholder,
	RichTextParagraph,
	RichTextSpan,
} from "../ir/types.js";
import { CanvasIRSchema } from "../ir/validators.js";
import { CanvasIRDepthError, MAX_TREE_DEPTH } from "../ir/walkers.js";
import {
	type CanvasTextMeasurer,
	type MeasuredText,
	type ResolvedSpanStyle,
	type RichTextStyleDefaults,
	resolveSpanStyle,
} from "../text-contracts.js";

/**
 * SVG serializer for `@anvilkit/canvas-core`.
 *
 * Pure and dependency-free (this package depends on `zod` only). SVG is emitted
 * by string concatenation, mirroring — never importing — the escaping/URL
 * conventions used in `@anvilkit/plugin-export-html`. canvas-core must never
 * import React, Konva, `@anvilkit/core`, or `@anvilkit/plugin-asset-manager`.
 *
 * FIDELITY CAVEATS (static SVG cannot perfectly reproduce the live Konva stage;
 * the serializer emits a warning at each of these and the export plugin/UI is
 * expected to surface them):
 *  - Text never wraps. SVG `<text>` has no width-based wrapping, so multi-line
 *    text is emitted best-effort. Baseline is approximated with an ascent ratio
 *    rather than `dominant-baseline` (Illustrator ignores baseline attributes).
 *  - Skew uses Konva's shear-factor convention (not SVG's degrees); skewed nodes
 *    are emitted as a composed `matrix(...)` for exactness.
 *  - `blendMode` maps to `mix-blend-mode` only for CSS-valid values.
 *  - Image `crop` maps to an SVG `<clipPath>` over the rendered element, which
 *    differs from Konva's source-rect sampling once the image is scaled.
 *  - Image `maskAssetId` / `filters` are not represented. Per FR-012's
 *    "preserved or migrated" clause these are deliberately WARN-ONLY
 *    (`IMAGE_MASK_UNSUPPORTED` / `IMAGE_FILTERS_UNSUPPORTED`): the node still
 *    serializes, the unrepresentable aspect is reported, and the field survives
 *    in the IR — it is never silently dropped, and the image is never flattened
 *    to hide the gap. A future vector-mask implementation can start emitting
 *    real markup without changing the IR or breaking existing consumers.
 *  - Frame `clip` IS fully representable (an SVG `<clipPath>` over the frame's
 *    box, rounded when `radius` is set), so it carries no fidelity warning. A
 *    frame whose `placeholder` has no resolved asset warns with
 *    `FRAME_PLACEHOLDER_UNRESOLVED` and paints a deterministic fallback.
 */

// --- URL / scheme safety -----------------------------------------------------

// `<image href>` uses an ALLOWLIST (not a scheme blocklist), matching the
// path-`d` discipline: only http(s), scheme-less relative/protocol-relative
// refs, and — when explicitly permitted — safe raster `data:` URIs are emitted.
// Any other scheme (javascript:, vbscript:, file:, blob:, filesystem:, ftp:,
// mailto:, custom:, …) is dropped, so a novel dangerous scheme can't slip past.
const ALLOWED_URI_SCHEMES: ReadonlySet<string> = new Set(["http", "https"]);
const URI_SCHEME_RE = /^([a-z][a-z0-9+.-]*):/;

const SAFE_DATA_IMAGE_RE =
	/^data:image\/(?:png|jpe?g|gif|webp|avif)(?:;[^,]*)?,/i;

const PATH_D_RE = /^[\sMmLlHhVvCcSsQqTtAaZz0-9.,+\-eE]*$/;

const BTOA_CHUNK_SIZE = 0x8000;

/** px-per-inch used when a page size omits an explicit `dpi`. */
export const DEFAULT_DPI = 96;

// --- escaping ----------------------------------------------------------------

/** Escape text content for an XML/SVG element body. */
export function escapeXml(input: string): string {
	return input
		.replaceAll("&", "&amp;")
		.replaceAll("<", "&lt;")
		.replaceAll(">", "&gt;");
}

/** Escape a value for a double-quoted XML/SVG attribute. */
export function escapeAttr(input: string): string {
	return escapeXml(input).replaceAll('"', "&quot;").replaceAll("'", "&#39;");
}

/**
 * Strip characters that could break out of a `<style>` element or a CSS value.
 * Used for `@font-face` family/src strings.
 */
export function escapeCssString(input: string): string {
	return input.replace(/[<>"'\\\r\n]/g, "");
}

/**
 * Sanitize a CSS `src` value for a `@font-face` rule: strip `<`/`>`/newlines (so
 * it cannot break out of the `<style>` element) and the structural CSS breakout
 * characters `{`, `}`, `;` (so it cannot terminate the declaration/rule and
 * inject arbitrary CSS — e.g. `url(x); } * { background: url(//evil) }`), while
 * preserving the `url(...)`/`format(...)` quotes a font `src` legitimately needs.
 */
export function escapeCssUrl(input: string): string {
	return input.replace(/[<>{};\r\n]/g, "");
}

// --- URI normalization -------------------------------------------------------

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

function stripControlChars(input: string): string {
	let out = "";
	for (const ch of input) {
		const cp = ch.charCodeAt(0);
		if (cp <= 0x20 || cp === 0x7f) continue;
		out += ch;
	}
	return out;
}

// --- base64 (web-target; mirrors plugin-export-html `encodeBase64`) ----------

export function bytesToBase64(bytes: Uint8Array): string {
	const bufferCtor = (
		globalThis as typeof globalThis & {
			Buffer?: {
				from(data: Uint8Array): { toString(encoding: string): string };
			};
		}
	).Buffer;

	if (bufferCtor) {
		return bufferCtor.from(bytes).toString("base64");
	}

	if (typeof btoa !== "function") {
		throw new Error("Base64 encoding is not supported in this environment.");
	}

	let binary = "";
	for (let index = 0; index < bytes.length; index += BTOA_CHUNK_SIZE) {
		const chunk = bytes.subarray(index, index + BTOA_CHUNK_SIZE);
		binary += String.fromCharCode(...chunk);
	}
	return btoa(binary);
}

// --- ids and path data -------------------------------------------------------

/** Reduce an arbitrary id to chars safe inside an XML id and `url(#…)` ref. */
export function sanitizeId(id: string): string {
	const cleaned = id.replace(/[^A-Za-z0-9_-]/g, "_");
	return cleaned.length > 0 ? cleaned : "id";
}

/**
 * Allowlist check for an SVG path `d` string — the one free-text field that
 * flows into an attribute. Rejects anything outside path commands, numbers,
 * separators, and scientific-notation exponents.
 */
export function isValidPathD(d: string): boolean {
	return PATH_D_RE.test(d);
}

// --- units -------------------------------------------------------------------

export function unitToPx(
	value: number,
	unit: CanvasUnit,
	dpi: number = DEFAULT_DPI,
): number {
	switch (unit) {
		case "mm":
			return (value / 25.4) * dpi;
		case "in":
			return value * dpi;
		default:
			return value;
	}
}

// --- numeric formatting ------------------------------------------------------

/** Stable, snapshot-friendly number formatting: 4-dp, no `-0`, no float noise. */
export function fmt(n: number): string {
	if (!Number.isFinite(n)) return "0";
	const rounded = Math.round(n * 1e4) / 1e4;
	return String(Object.is(rounded, -0) ? 0 : rounded);
}

// --- affine transform --------------------------------------------------------

/**
 * The value for an SVG `transform` attribute, or `""` for an identity
 * transform. Skewed nodes emit a composed `matrix(...)`; everything else emits
 * the readable `translate/rotate/scale` decomposition, which composes to the
 * same matrix as Konva's translate→rotate→scale nesting.
 */
export function transformAttr(t: CanvasTransform): string {
	const skewX = t.skewX ?? 0;
	const skewY = t.skewY ?? 0;

	if (skewX !== 0 || skewY !== 0) {
		return `matrix(${toAffineMatrix(t).map(fmt).join(" ")})`;
	}

	const parts: string[] = [];
	if (t.x !== 0 || t.y !== 0) parts.push(`translate(${fmt(t.x)} ${fmt(t.y)})`);
	if (t.rotation !== 0) parts.push(`rotate(${fmt(t.rotation)})`);
	if (t.scaleX !== 1 || t.scaleY !== 1) {
		parts.push(`scale(${fmt(t.scaleX)} ${fmt(t.scaleY)})`);
	}
	return parts.join(" ");
}

// --- warnings + emit context -------------------------------------------------

export type SvgWarningCode =
	| "TEXT_NO_WRAP"
	| "PATH_INVALID_D"
	| "AI_PLACEHOLDER_SKIPPED"
	| "BLENDMODE_UNSUPPORTED"
	| "FONT_NOT_IN_MANIFEST"
	| "MISSING_ASSET"
	| "UNSAFE_URI"
	| "EMBED_NO_FETCHER"
	| "IMAGE_FIT_MODE_APPROXIMATED"
	| "IMAGE_MASK_UNSUPPORTED"
	| "IMAGE_FILTERS_UNSUPPORTED"
	| "BACKGROUND_UNSUPPORTED"
	| "UNKNOWN_KIND_SKIPPED"
	| "CUSTOM_KIND"
	// Added for frames (canvas-m1-003). The union only ever grows: FR-041 requires
	// that every pre-existing code and its emit sites keep working unchanged, so a
	// consumer switching on `SvgWarningCode` is never broken by a new member.
	//
	// There is deliberately no `FRAME_MASK_UNSUPPORTED`: a frame has no mask field
	// (PRD §12.2 — `clip`/`background`/`placeholder`/`radius`), and frame clipping
	// IS losslessly representable as an SVG `<clipPath>`. A code that can never be
	// emitted would be dead API. Image masks keep warning via
	// `IMAGE_MASK_UNSUPPORTED`, which is unchanged.
	| "FRAME_PLACEHOLDER_UNRESOLVED"
	// Added for rich text (canvas-m1-007). Same grow-only rule.
	//
	// `RICH_TEXT_WRAP_APPROXIMATE` — no `textMeasurer` was supplied, so the
	// serializer cannot know where lines break: it falls back to one line per
	// paragraph. The output is still deterministic, it just is not wrapped.
	//
	// `RICH_TEXT_ELLIPSIS_UNSUPPORTED` — static SVG has no `text-overflow`. An
	// `ellipsis` overflow is emitted clipped (best effort), without the ellipsis
	// glyph, so the caller knows the truncation marker is missing.
	//
	// There is deliberately no `RICH_TEXT_CLIP_UNSUPPORTED`: `overflow: "clip"` IS
	// losslessly representable as a `<clipPath>`, exactly like a frame's, so a code
	// for it could never fire — dead API, which the frame work already ruled out.
	| "RICH_TEXT_WRAP_APPROXIMATE"
	| "RICH_TEXT_ELLIPSIS_UNSUPPORTED"
	// Added for brand-token refs (canvas-m1-012). Same grow-only rule. Fires when
	// a `BrandTokenRef` fill/fontFamily has no `resolveBrandToken` option, or the
	// resolver returns nothing usable — the node still emits, with the token's
	// fill/font degraded to the same deterministic fallback an absent value gets
	// (fill: omitted attribute; fontFamily: inherits from the parent element).
	// This IS FR-041's "unresolved brand token" code — no separate
	// `TOKEN_UNRESOLVED` was added in canvas-m3-002, since this already covers
	// both `tokenType: "color"` and `"font"` refs.
	| "BRAND_TOKEN_UNRESOLVED"
	// Added for the SVG asset node (FR-016, canvas-m3-005). Fires whenever an
	// `svg`-kind node is serialized: inline vector embedding is deferred behind
	// a future `inlineVectorSvg` capability flag, so the node always renders as
	// an `<image>` asset reference (the same safe path `image` nodes use).
	| "SVG_INLINE_UNSUPPORTED"
	// Added for animation metadata (FR-080, canvas-m6-001). Fires whenever a
	// node or the page itself carries `animation` metadata: static SVG has no
	// timeline, so the node/page renders in its normal resting state exactly
	// as it would without the metadata — this warning is purely informational,
	// never a divergent render.
	| "ANIMATION_IGNORED"
	// Added for video/audio nodes (FR-081, canvas-m6-002). A video renders its
	// `poster` asset as a static `<image>` fallback when one is set (nothing
	// otherwise); audio has no visual representation at all, ever.
	| "VIDEO_UNSUPPORTED"
	| "AUDIO_UNSUPPORTED";

export interface SvgSerializeWarning {
	code: SvgWarningCode;
	message: string;
	nodeId?: string;
	/**
	 * Optional suggested remediation or explanation of the degrade applied
	 * (FR-041, canvas-m3-002) — e.g. "falls back to the neutral gray fill"
	 * or "sanitize and re-upload as a raster to embed inline". Additive;
	 * every existing warning site keeps working without setting it.
	 */
	fallback?: string;
}

/**
 * Fallbacks for the rich-text style fields a document leaves unset. Chosen to
 * match `createText`'s defaults (`ir/builders.ts`) so a rich-text block with no
 * explicit styling renders like a plain `text` node would.
 */
const DEFAULT_RICH_TEXT_STYLE: RichTextStyleDefaults = {
	fontFamily: "Inter",
	fontSize: 16,
	fontWeight: "400",
	italic: false,
	underline: false,
	strikethrough: false,
	letterSpacing: 0,
	textTransform: "none",
	fill: "#000000",
	lineHeight: 1.4,
	align: "left",
};

/** Options resolved to concrete values, threaded through emission. */
export interface ResolvedSvgOptions {
	images: SvgImageMode;
	skipInvisible: boolean;
	pretty: boolean;
	fonts: SvgFontFaceDef[];
	richTextDefaults: RichTextStyleDefaults;
	fetchAsset?: SvgFetchAsset;
	nodeKinds?: CanvasNodeKindRegistry;
	textMeasurer?: CanvasTextMeasurer;
	resolveBrandToken?: SvgResolveBrandToken;
}

/**
 * Mutable state threaded through emission: accumulates content-level warnings
 * and the set of font families actually used (so `@font-face` emission can be
 * limited to fonts that appear in the document), plus the resolved options and
 * the document's asset map for image resolution.
 */
export interface SvgEmitContext {
	readonly warnings: SvgSerializeWarning[];
	readonly usedFonts: Set<string>;
	readonly options: ResolvedSvgOptions;
	readonly assets: Record<string, CanvasAssetRef>;
}

export function createEmitContext(
	options: SvgSerializeOptions = {},
	assets: Record<string, CanvasAssetRef> = {},
): SvgEmitContext {
	const resolved: ResolvedSvgOptions = {
		images: options.images ?? "auto",
		skipInvisible: options.skipInvisible ?? true,
		pretty: options.pretty ?? false,
		fonts: options.fonts ?? [],
		richTextDefaults: {
			...DEFAULT_RICH_TEXT_STYLE,
			...(options.richTextDefaults ?? {}),
		},
	};
	if (options.fetchAsset) resolved.fetchAsset = options.fetchAsset;
	if (options.nodeKinds) resolved.nodeKinds = options.nodeKinds;
	if (options.textMeasurer) resolved.textMeasurer = options.textMeasurer;
	if (options.resolveBrandToken) {
		resolved.resolveBrandToken = options.resolveBrandToken;
	}
	return {
		warnings: [],
		usedFonts: new Set<string>(),
		options: resolved,
		assets,
	};
}

function warn(
	ctx: SvgEmitContext,
	code: SvgWarningCode,
	message: string,
	nodeId?: string,
): void {
	ctx.warnings.push(nodeId ? { code, message, nodeId } : { code, message });
}

/**
 * Build the framework-free emit surface handed to a custom node kind's `toSvg`
 * hook (the registry-driven path for non-built-in kinds).
 */
function makeSvgHookContext(ctx: SvgEmitContext): CanvasSvgHookContext {
	return {
		commonAttrs: (n) => commonAttrs(n, ctx).join(" "),
		fmt,
		escapeAttr,
		escapeXml,
		warn: (code, message, nodeId) =>
			warn(ctx, "CUSTOM_KIND", `[${code}] ${message}`, nodeId),
	};
}

// --- shared attribute helpers ------------------------------------------------

const TEXT_ASCENT_RATIO = 0.8;

/** CSS `mix-blend-mode` values; `normal` is the default and never emitted. */
const CSS_BLEND_MODES: ReadonlySet<string> = new Set([
	"multiply",
	"screen",
	"overlay",
	"darken",
	"lighten",
	"color-dodge",
	"color-burn",
	"hard-light",
	"soft-light",
	"difference",
	"exclusion",
	"hue",
	"saturation",
	"color",
	"luminosity",
]);

function blendStyle(
	node: CanvasNodeBase,
	ctx: SvgEmitContext,
): string | undefined {
	const blend = node.blendMode;
	if (!blend || blend === "normal") return undefined;
	if (CSS_BLEND_MODES.has(blend)) return `mix-blend-mode:${blend}`;
	warn(
		ctx,
		"BLENDMODE_UNSUPPORTED",
		`Unsupported blend mode "${blend}".`,
		node.id,
	);
	return undefined;
}

/** transform / opacity / blend-mode attributes shared by every node. */
function commonAttrs(node: CanvasNodeBase, ctx: SvgEmitContext): string[] {
	const out: string[] = [];
	const transform = transformAttr(node.transform);
	if (transform) out.push(`transform="${transform}"`);
	if (node.opacity !== undefined && node.opacity !== 1) {
		out.push(`opacity="${fmt(node.opacity)}"`);
	}
	const style = blendStyle(node, ctx);
	if (style) out.push(`style="${escapeAttr(style)}"`);
	return out;
}

/**
 * `fill`/`stroke` attributes. An undefined fill emits `fill="none"` so a Konva
 * shape with no fill stays transparent (SVG's default fill is black).
 */
function paintAttrs(
	fill: string | undefined,
	stroke: string | undefined,
	strokeWidth: number | undefined,
): string[] {
	const out = [`fill="${fill !== undefined ? escapeAttr(fill) : "none"}"`];
	if (stroke !== undefined) {
		out.push(`stroke="${escapeAttr(stroke)}"`);
		if (strokeWidth !== undefined) {
			out.push(`stroke-width="${fmt(strokeWidth)}"`);
		}
	}
	return out;
}

/**
 * SVG markup for a gradient fill. `gradientUnits="objectBoundingBox"` makes the
 * 0..1 `from`/`to` coordinates map directly onto the node's box.
 */
function gradientMarkup(id: string, g: CanvasGradientFill): string {
	const stops = g.stops
		.map(
			(s) =>
				`<stop offset="${fmt(s.offset)}" stop-color="${escapeAttr(s.color)}" />`,
		)
		.join("");
	if (g.kind === "radial") {
		const r = Math.hypot(g.to.x - g.from.x, g.to.y - g.from.y);
		return `<radialGradient id="${id}" gradientUnits="objectBoundingBox" cx="${fmt(g.from.x)}" cy="${fmt(g.from.y)}" r="${fmt(r)}">${stops}</radialGradient>`;
	}
	return `<linearGradient id="${id}" gradientUnits="objectBoundingBox" x1="${fmt(g.from.x)}" y1="${fmt(g.from.y)}" x2="${fmt(g.to.x)}" y2="${fmt(g.to.y)}">${stops}</linearGradient>`;
}

/** SVG `<filter>` markup for a drop shadow (stdDeviation ≈ Konva blur / 2). */
function shadowMarkup(id: string, s: CanvasShadow): string {
	return `<filter id="${id}"><feDropShadow dx="${fmt(s.offsetX)}" dy="${fmt(s.offsetY)}" stdDeviation="${fmt(s.blur / 2)}" flood-color="${escapeAttr(s.color)}" flood-opacity="${fmt(s.opacity ?? 1)}" /></filter>`;
}

/**
 * Resolve a fill field through `resolveBrandToken` when it is a token
 * reference; pass a plain color/gradient through unchanged. Unresolved (no
 * resolver, or the resolver returns nothing) degrades to `undefined` — which
 * `decorate` already treats as "no fill" — with a `BRAND_TOKEN_UNRESOLVED`
 * warning. Never throws.
 */
function resolveFill(
	fill: CanvasFill | undefined,
	ctx: SvgEmitContext,
	nodeId: string,
): string | CanvasGradientFill | undefined {
	if (fill === undefined || typeof fill === "string") return fill;
	if ("kind" in fill) return fill; // CanvasGradientFill — not a token.
	const resolved = ctx.options.resolveBrandToken?.(fill);
	if (resolved !== undefined) return resolved;
	warn(
		ctx,
		"BRAND_TOKEN_UNRESOLVED",
		`Brand token "${fill.id}" (${fill.tokenType}) could not be resolved; fill omitted.`,
		nodeId,
	);
	return undefined;
}

/** `resolveFill`'s font-family counterpart, warning on an unresolved token. */
function resolveFontFamily(
	fontFamily: CanvasFontFamily,
	ctx: SvgEmitContext,
	nodeId: string,
): string | undefined {
	const resolved = tryResolveFontFamily(fontFamily, ctx);
	if (resolved !== undefined || typeof fontFamily === "string") return resolved;
	warn(
		ctx,
		"BRAND_TOKEN_UNRESOLVED",
		`Brand token "${fontFamily.id}" (font) could not be resolved; font-family omitted.`,
		nodeId,
	);
	return undefined;
}

/**
 * Silent variant of `resolveFontFamily`, for the `usedFonts` pre-scan
 * (`emitRichText`) — that pass is best-effort bookkeeping, not an emission
 * point, so it must not double-warn for the same token the actual `<tspan>`
 * emission already warns about.
 */
function tryResolveFontFamily(
	fontFamily: CanvasFontFamily,
	ctx: SvgEmitContext,
): string | undefined {
	if (typeof fontFamily === "string") return fontFamily;
	const resolved = ctx.options.resolveBrandToken?.(fontFamily);
	return typeof resolved === "string" ? resolved : undefined;
}

/**
 * Resolve a fillable/shadowable node's fill + shadow into inline `<defs>`, the
 * `fill` value (a color, or `url(#id)` for a gradient), and an optional `filter`
 * attribute. Ids derive from the node id (one fill + one shadow per node). A
 * string/undefined fill with no shadow yields empty defs/filter, so the output
 * is byte-identical to a plain shape. A brand-token fill is resolved FIRST,
 * before any of the gradient/defs logic below ever sees it.
 */
function decorate(
	fill: CanvasFill | undefined,
	shadow: CanvasShadow | undefined,
	nodeId: string,
	ctx: SvgEmitContext,
): { defs: string; fill: string | undefined; filterAttr: string } {
	const resolvedFill = resolveFill(fill, ctx, nodeId);
	const inner: string[] = [];
	let fillValue: string | undefined;
	if (resolvedFill === undefined || typeof resolvedFill === "string") {
		fillValue = resolvedFill;
	} else {
		const id = `grad-${sanitizeId(nodeId)}`;
		inner.push(gradientMarkup(id, resolvedFill));
		fillValue = `url(#${id})`;
	}
	let filterAttr = "";
	if (shadow) {
		const id = `shadow-${sanitizeId(nodeId)}`;
		inner.push(shadowMarkup(id, shadow));
		filterAttr = ` filter="url(#${id})"`;
	}
	return {
		defs: inner.length > 0 ? `<defs>${inner.join("")}</defs>` : "",
		fill: fillValue,
		filterAttr,
	};
}

function textAnchor(
	align: CanvasTextAlign | undefined,
): "start" | "middle" | "end" {
	if (align === "center") return "middle";
	if (align === "right") return "end";
	return "start";
}

function textAnchorX(
	align: CanvasTextAlign | undefined,
	width: number,
): number {
	if (align === "center") return width / 2;
	if (align === "right") return width;
	return 0;
}

/** True when a node should be omitted because it is hidden and we skip hidden nodes. */
export function shouldSkipNode(
	node: CanvasNodeBase,
	skipInvisible: boolean,
): boolean {
	return skipInvisible && node.visible === false;
}

/** FR-075 (B-03a): extended stroke presentation attributes. */
function strokeStyleAttrs(node: {
	strokeOpacity?: number;
	strokeDash?: number[];
	strokeCap?: "butt" | "round" | "square";
	strokeJoin?: "miter" | "round" | "bevel";
}): string[] {
	const out: string[] = [];
	if (node.strokeOpacity !== undefined) {
		out.push(`stroke-opacity="${fmt(node.strokeOpacity)}"`);
	}
	if (node.strokeDash && node.strokeDash.length > 0) {
		out.push(`stroke-dasharray="${node.strokeDash.map(fmt).join(" ")}"`);
	}
	if (node.strokeCap !== undefined) {
		out.push(`stroke-linecap="${node.strokeCap}"`);
	}
	if (node.strokeJoin !== undefined) {
		out.push(`stroke-linejoin="${node.strokeJoin}"`);
	}
	return out;
}

/**
 * FR-075 arrowheads (B-03a): marker defs + marker-start/end attributes for
 * line/path nodes. The marker inherits the stroke color via context-fill-free
 * explicit fill (SVG 1.1-safe).
 */
function arrowMarkerParts(node: {
	id: string;
	stroke?: string;
	arrowStart?: "none" | "arrow";
	arrowEnd?: "none" | "arrow";
}): { defs: string; attrs: string[] } {
	const color = node.stroke ?? "#000";
	const attrs: string[] = [];
	let defs = "";
	const marker = (suffix: "start" | "end"): string => {
		const id = `arrow-${suffix}-${sanitizeId(node.id)}`;
		attrs.push(`marker-${suffix}="url(#${id})"`);
		return `<marker id="${id}" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse"><path d="M 0 0 L 10 5 L 0 10 z" fill="${escapeAttr(color)}" /></marker>`;
	};
	const markers: string[] = [];
	if (node.arrowStart === "arrow") markers.push(marker("start"));
	if (node.arrowEnd === "arrow") markers.push(marker("end"));
	if (markers.length > 0) defs = `<defs>${markers.join("")}</defs>`;
	return { defs, attrs };
}

/**
 * FR-076 (B-03b): a rounded-rect path honouring independent corner radii,
 * clamped to the half-extents. Replaces `<rect rx>` (single-radius only).
 */
function roundedRectPath(
	width: number,
	height: number,
	radii: {
		topLeft: number;
		topRight: number;
		bottomRight: number;
		bottomLeft: number;
	},
): string {
	const clamp = (r: number): number =>
		Math.max(0, Math.min(r, width / 2, height / 2));
	const tl = clamp(radii.topLeft);
	const tr = clamp(radii.topRight);
	const br = clamp(radii.bottomRight);
	const bl = clamp(radii.bottomLeft);
	return [
		`M ${fmt(tl)} 0`,
		`H ${fmt(width - tr)}`,
		tr > 0 ? `A ${fmt(tr)} ${fmt(tr)} 0 0 1 ${fmt(width)} ${fmt(tr)}` : "",
		`V ${fmt(height - br)}`,
		br > 0
			? `A ${fmt(br)} ${fmt(br)} 0 0 1 ${fmt(width - br)} ${fmt(height)}`
			: "",
		`H ${fmt(bl)}`,
		bl > 0 ? `A ${fmt(bl)} ${fmt(bl)} 0 0 1 0 ${fmt(height - bl)}` : "",
		`V ${fmt(tl)}`,
		tl > 0 ? `A ${fmt(tl)} ${fmt(tl)} 0 0 1 ${fmt(tl)} 0` : "",
		"Z",
	]
		.filter(Boolean)
		.join(" ");
}

// --- shape emitters (synchronous; image emission is async, added later) ------

export function emitRect(node: CanvasRectNode, ctx: SvgEmitContext): string {
	const decor = decorate(node.fill, node.shadow, node.id, ctx);
	const paint = [
		...paintAttrs(decor.fill, node.stroke, node.strokeWidth),
		...strokeStyleAttrs(node),
		...strokeStyleAttrs(node),
	];
	// FR-076: independent corner radii render as a path (rect rx is uniform).
	if (node.cornerRadii) {
		const attrs = [
			...commonAttrs(node, ctx),
			`d="${roundedRectPath(node.bounds.width, node.bounds.height, node.cornerRadii)}"`,
			...paint,
		];
		return `${decor.defs}<path ${attrs.join(" ")}${decor.filterAttr} />`;
	}
	const attrs = [
		...commonAttrs(node, ctx),
		`width="${fmt(node.bounds.width)}"`,
		`height="${fmt(node.bounds.height)}"`,
	];
	if (node.radius !== undefined && node.radius > 0) {
		attrs.push(`rx="${fmt(node.radius)}"`, `ry="${fmt(node.radius)}"`);
	}
	attrs.push(...paint);
	return `${decor.defs}<rect ${attrs.join(" ")}${decor.filterAttr} />`;
}

export function emitEllipse(
	node: CanvasEllipseNode,
	ctx: SvgEmitContext,
): string {
	const rx = node.bounds.width / 2;
	const ry = node.bounds.height / 2;
	const decor = decorate(node.fill, node.shadow, node.id, ctx);
	const attrs = [
		...commonAttrs(node, ctx),
		`cx="${fmt(rx)}"`,
		`cy="${fmt(ry)}"`,
		`rx="${fmt(rx)}"`,
		`ry="${fmt(ry)}"`,
		...paintAttrs(decor.fill, node.stroke, node.strokeWidth),
		...strokeStyleAttrs(node),
	];
	return `${decor.defs}<ellipse ${attrs.join(" ")}${decor.filterAttr} />`;
}

function pointsAttr(vertices: readonly { x: number; y: number }[]): string {
	return vertices.map((v) => `${fmt(v.x)},${fmt(v.y)}`).join(" ");
}

export function emitPolygon(
	node: CanvasPolygonNode,
	ctx: SvgEmitContext,
): string {
	const decor = decorate(node.fill, node.shadow, node.id, ctx);
	const attrs = [
		...commonAttrs(node, ctx),
		`points="${pointsAttr(computePolygonVertices(node.bounds, node.sides))}"`,
		...paintAttrs(decor.fill, node.stroke, node.strokeWidth),
		...strokeStyleAttrs(node),
	];
	return `${decor.defs}<polygon ${attrs.join(" ")}${decor.filterAttr} />`;
}

export function emitStar(node: CanvasStarNode, ctx: SvgEmitContext): string {
	const decor = decorate(node.fill, node.shadow, node.id, ctx);
	const vertices = computeStarVertices(
		node.bounds,
		node.points,
		node.innerRadiusRatio,
	);
	const attrs = [
		...commonAttrs(node, ctx),
		`points="${pointsAttr(vertices)}"`,
		...paintAttrs(decor.fill, node.stroke, node.strokeWidth),
		...strokeStyleAttrs(node),
	];
	return `${decor.defs}<polygon ${attrs.join(" ")}${decor.filterAttr} />`;
}

export function emitLine(node: CanvasLineNode, ctx: SvgEmitContext): string {
	const [x1, y1, x2, y2] = node.points;
	const attrs = [
		...commonAttrs(node, ctx),
		`x1="${fmt(x1)}"`,
		`y1="${fmt(y1)}"`,
		`x2="${fmt(x2)}"`,
		`y2="${fmt(y2)}"`,
		`stroke="${escapeAttr(node.stroke)}"`,
	];
	if (node.strokeWidth !== undefined) {
		attrs.push(`stroke-width="${fmt(node.strokeWidth)}"`);
	}
	attrs.push(...strokeStyleAttrs(node));
	const arrows = arrowMarkerParts(node);
	attrs.push(...arrows.attrs);
	return `${arrows.defs}<line ${attrs.join(" ")} />`;
}

export function emitPath(node: CanvasPathNode, ctx: SvgEmitContext): string {
	if (!isValidPathD(node.d)) {
		warn(
			ctx,
			"PATH_INVALID_D",
			"Path data contains unsupported characters; node skipped.",
			node.id,
		);
		return "";
	}
	const decor = decorate(node.fill, node.shadow, node.id, ctx);
	const attrs = [
		...commonAttrs(node, ctx),
		`d="${escapeAttr(node.d)}"`,
		...paintAttrs(decor.fill, node.stroke, node.strokeWidth),
		...strokeStyleAttrs(node),
		...strokeStyleAttrs(node),
	];
	const arrows = arrowMarkerParts(node);
	attrs.push(...arrows.attrs);
	return `${arrows.defs}${decor.defs}<path ${attrs.join(" ")}${decor.filterAttr} />`;
}

export function emitText(node: CanvasTextNode, ctx: SvgEmitContext): string {
	const fontFamily = resolveFontFamily(node.fontFamily, ctx, node.id);
	if (fontFamily !== undefined) ctx.usedFonts.add(fontFamily);
	const anchor = textAnchor(node.align);
	const x = textAnchorX(node.align, node.bounds.width);
	const baselineY = node.fontSize * TEXT_ASCENT_RATIO;
	const decor = decorate(node.fill, node.shadow, node.id, ctx);

	const attrs = [
		...commonAttrs(node, ctx),
		`x="${fmt(x)}"`,
		`y="${fmt(baselineY)}"`,
		...(fontFamily !== undefined
			? [`font-family="${escapeAttr(fontFamily)}"`]
			: []),
		`font-size="${fmt(node.fontSize)}"`,
	];
	if (node.fontWeight !== undefined) {
		attrs.push(`font-weight="${escapeAttr(node.fontWeight)}"`);
	}
	if (anchor !== "start") attrs.push(`text-anchor="${anchor}"`);
	attrs.push(`fill="${escapeAttr(decor.fill ?? "")}"`);

	const lines = node.text.split("\n");
	if (lines.length > 1) {
		warn(
			ctx,
			"TEXT_NO_WRAP",
			"Multi-line text is emitted as explicit line breaks without width-based wrapping.",
			node.id,
		);
		const tspans = lines
			.map(
				(line, index) =>
					`<tspan x="${fmt(x)}" dy="${index === 0 ? "0" : fmt(node.fontSize)}">${escapeXml(line)}</tspan>`,
			)
			.join("");
		return `${decor.defs}<text ${attrs.join(" ")}${decor.filterAttr}>${tspans}</text>`;
	}
	return `${decor.defs}<text ${attrs.join(" ")}${decor.filterAttr}>${escapeXml(node.text)}</text>`;
}

// --- rich text ---------------------------------------------------------------

/**
 * Apply a span's `textTransform` to the string being emitted.
 *
 * SVG has no `text-transform`, so unlike CSS this has to happen at serialize
 * time. The IR's `span.text` is never rewritten — only the emitted glyphs are —
 * so the original casing survives a round-trip.
 *
 * `capitalize` upper-cases the first letter of each whitespace-separated word,
 * matching CSS. It deliberately does not try to be clever about punctuation.
 */
function applyTextTransform(
	text: string,
	transform: ResolvedSpanStyle["textTransform"],
): string {
	switch (transform) {
		case "uppercase":
			return text.toUpperCase();
		case "lowercase":
			return text.toLowerCase();
		case "capitalize":
			return text.replace(
				/(^|\s)(\S)/g,
				(_m, lead: string, ch: string) => lead + ch.toUpperCase(),
			);
		default:
			return text;
	}
}

/**
 * Presentation attributes for ONE span's `<tspan>`.
 *
 * Only fields the document explicitly set are emitted; everything else is left
 * to inherit from the parent `<text>`, which carries the resolved defaults. So
 * the attribute set mirrors the document rather than a fully-expanded style, and
 * a span that sets nothing emits a bare `<tspan>`.
 */
function richSpanAttrs(
	span: RichTextSpan,
	fillValue: string | undefined,
	ctx: SvgEmitContext,
	nodeId: string,
): string[] {
	const attrs: string[] = [];
	if (span.fontFamily !== undefined) {
		const fontFamily = resolveFontFamily(span.fontFamily, ctx, nodeId);
		if (fontFamily !== undefined) {
			attrs.push(`font-family="${escapeAttr(fontFamily)}"`);
		}
	}
	if (span.fontSize !== undefined) {
		attrs.push(`font-size="${fmt(span.fontSize)}"`);
	}
	if (span.fontWeight !== undefined) {
		attrs.push(`font-weight="${escapeAttr(span.fontWeight)}"`);
	}
	if (span.italic !== undefined) {
		attrs.push(`font-style="${span.italic ? "italic" : "normal"}"`);
	}
	if (span.underline !== undefined || span.strikethrough !== undefined) {
		const parts = [
			span.underline ? "underline" : "",
			span.strikethrough ? "line-through" : "",
		].filter(Boolean);
		attrs.push(
			`text-decoration="${parts.length > 0 ? parts.join(" ") : "none"}"`,
		);
	}
	if (span.letterSpacing !== undefined) {
		attrs.push(`letter-spacing="${fmt(span.letterSpacing)}"`);
	}
	if (fillValue !== undefined) {
		attrs.push(`fill="${escapeAttr(fillValue)}"`);
	}
	return attrs;
}

/**
 * A span's fill, resolved through the shared gradient machinery.
 *
 * `decorate` derives its `<defs>` ids from the node id — one gradient per node —
 * so a rich-text node with several gradient spans would emit colliding
 * `grad-<id>` ids. Passing a SYNTHETIC per-span id is the established fix; the
 * frame background does the same thing with `${node.id}-bg`.
 */
function richSpanFill(
	node: CanvasRichTextNode,
	span: RichTextSpan,
	paragraphIndex: number,
	spanIndex: number,
	ctx: SvgEmitContext,
): { defs: string; fill: string | undefined } {
	if (span.fill === undefined) return { defs: "", fill: undefined };
	const decor = decorate(
		span.fill,
		undefined,
		`${node.id}-p${paragraphIndex}s${spanIndex}`,
		ctx,
	);
	return { defs: decor.defs, fill: decor.fill };
}

/** The largest resolved font size in a paragraph — what drives its line height. */
function paragraphFontSize(
	paragraph: RichTextParagraph,
	defaults: RichTextStyleDefaults,
): number {
	let size = 0;
	for (const span of paragraph.spans) {
		size = Math.max(size, resolveSpanStyle(span, defaults).fontSize);
	}
	// An empty paragraph still occupies a line — a blank line between two
	// paragraphs is content, not nothing.
	return size > 0 ? size : defaults.fontSize;
}

/**
 * Rich text → `<text>` with one `<tspan>` per line.
 *
 * Without a `textMeasurer` core cannot know where lines break (it has no font
 * metrics), so it lays out ONE LINE PER PARAGRAPH and flags the output with
 * `RICH_TEXT_WRAP_APPROXIMATE`. The result is still fully deterministic — it is
 * simply un-wrapped. With a measurer, the measured line boxes drive the tspan
 * positions and the two paths differ only in where the breaks land.
 *
 * Per-span styling rides on nested `<tspan>`s, which inherit from the `<text>`
 * element carrying the resolved defaults.
 */
export function emitRichText(
	node: CanvasRichTextNode,
	ctx: SvgEmitContext,
): string {
	if (node.paragraphs.length === 0) return "";
	const defaults = ctx.options.richTextDefaults;

	// Every family that will actually be painted, so `@font-face` emission (and
	// the FONT_NOT_IN_MANIFEST check) sees rich text too — `emitText` was the only
	// producer of `usedFonts` before this. Silent resolution: this is a
	// best-effort pre-scan, not an emission point, so an unresolved token is
	// skipped here without warning — the actual `<tspan>` emission warns.
	ctx.usedFonts.add(defaults.fontFamily);
	for (const paragraph of node.paragraphs) {
		for (const span of paragraph.spans) {
			const family = tryResolveFontFamily(
				resolveSpanStyle(span, defaults).fontFamily,
				ctx,
			);
			if (family !== undefined) ctx.usedFonts.add(family);
		}
	}

	const decor = decorate(defaults.fill, undefined, `${node.id}-rt`, ctx);
	const attrs = [
		...commonAttrs(node, ctx),
		`font-family="${escapeAttr(defaults.fontFamily)}"`,
		`font-size="${fmt(defaults.fontSize)}"`,
		`font-weight="${escapeAttr(defaults.fontWeight)}"`,
		`fill="${escapeAttr(decor.fill ?? "")}"`,
	];

	const defs: string[] = [];
	if (decor.defs) defs.push(decor.defs);

	const measurer = ctx.options.textMeasurer;
	const measured = measurer
		? measurer({
				paragraphs: node.paragraphs,
				width: node.width,
				wrap: node.wrap ?? "word",
				defaults,
			})
		: undefined;
	const body = measured
		? emitMeasuredLines(node, measured, defaults, defs, ctx)
		: emitUnwrappedParagraphs(node, ctx, defaults, defs);

	// The clip box needs a height. An explicit `height` wins; otherwise the
	// measured height is the only honest answer, and without a measurer there is
	// none — so an unmeasured, unsized block simply cannot be clipped.
	const clipHeight = node.height ?? measured?.height;
	const clip = richTextClip(node, ctx, clipHeight);
	if (clip.attr) attrs.push(clip.attr);
	if (clip.defs) defs.push(clip.defs);

	return `${defs.join("")}<text ${attrs.join(" ")}>${body}</text>`;
}

/**
 * `overflow` → an SVG `<clipPath>`, reusing the mechanism a frame's `clip` uses.
 *
 * `"clip"` is losslessly representable, so it needs no warning. `"ellipsis"` is
 * NOT: static SVG has no `text-overflow`, so the text is clipped at the box edge
 * without a `…` marker, and the caller is told so. `"visible"`/`"auto-height"`
 * (and the unset default) clip nothing — `auto-height` means the box grew to fit,
 * so there is by definition no overflow to trim.
 */
function richTextClip(
	node: CanvasRichTextNode,
	ctx: SvgEmitContext,
	height: number | undefined,
): { defs: string; attr: string } {
	const overflow = node.overflow ?? "visible";
	if (overflow !== "clip" && overflow !== "ellipsis") {
		return { defs: "", attr: "" };
	}
	if (overflow === "ellipsis") {
		warn(
			ctx,
			"RICH_TEXT_ELLIPSIS_UNSUPPORTED",
			"SVG has no text-overflow; the block is clipped at its box without an ellipsis marker.",
			node.id,
		);
	}
	// Nothing to clip against: no explicit height, and no measurer to derive one.
	if (height === undefined) return { defs: "", attr: "" };

	const clipId = `richtext-clip-${sanitizeId(node.id)}`;
	return {
		defs: `<defs><clipPath id="${clipId}"><rect width="${fmt(node.width)}" height="${fmt(height)}" /></clipPath></defs>`,
		attr: `clip-path="url(#${clipId})"`,
	};
}

/**
 * The measurer path: every measured line becomes one absolutely-positioned
 * `<tspan>` per run.
 *
 * A run is a slice of ONE span that landed on ONE line, so a wrapped span
 * produces several runs — each carrying its source span's styling, recovered via
 * `spanIndex`. Runs are placed absolutely (`x`/`y`) rather than flowed, because
 * the measurer has already decided exactly where every piece goes; re-flowing
 * them would throw that away. Alignment is baked into `line.x` by the measurer,
 * so no `text-anchor` is emitted on this path.
 */
function emitMeasuredLines(
	node: CanvasRichTextNode,
	measured: MeasuredText,
	defaults: RichTextStyleDefaults,
	defs: string[],
	ctx: SvgEmitContext,
): string {
	const out: string[] = [];
	for (const line of measured.lines) {
		const paragraph = node.paragraphs[line.paragraphIndex];
		if (!paragraph) continue;
		const y = line.y + line.baseline;
		for (const run of line.runs) {
			const span = paragraph.spans[run.spanIndex];
			if (!span) continue;
			const fill = richSpanFill(
				node,
				span,
				line.paragraphIndex,
				run.spanIndex,
				ctx,
			);
			if (fill.defs && !defs.includes(fill.defs)) defs.push(fill.defs);
			const attrs = [
				`x="${fmt(line.x + run.x)}"`,
				`y="${fmt(y)}"`,
				...richSpanAttrs(span, fill.fill, ctx, node.id),
			];
			const text = escapeXml(
				applyTextTransform(
					run.text,
					resolveSpanStyle(span, defaults).textTransform,
				),
			);
			out.push(`<tspan ${attrs.join(" ")}>${text}</tspan>`);
		}
	}
	return out.join("");
}

/**
 * The no-measurer path: one line per paragraph, laid out from the defaults'
 * line height. Paragraph `align` becomes `text-anchor`, so alignment still works
 * without any glyph measurement.
 */
function emitUnwrappedParagraphs(
	node: CanvasRichTextNode,
	ctx: SvgEmitContext,
	defaults: RichTextStyleDefaults,
	defs: string[],
): string {
	warn(
		ctx,
		"RICH_TEXT_WRAP_APPROXIMATE",
		"No text measurer was supplied; rich text is emitted as one line per paragraph, without width-based wrapping.",
		node.id,
	);

	const lines: string[] = [];
	let y = 0;
	for (const [pi, paragraph] of node.paragraphs.entries()) {
		const size = paragraphFontSize(paragraph, defaults);
		const align = paragraph.align ?? defaults.align;
		const anchor = textAnchor(align);
		const x = textAnchorX(align, node.width);

		const lineAttrs = [
			`x="${fmt(x)}"`,
			`y="${fmt(y + size * TEXT_ASCENT_RATIO)}"`,
		];
		if (anchor !== "start") lineAttrs.push(`text-anchor="${anchor}"`);

		lines.push(
			`<tspan ${lineAttrs.join(" ")}>${emitSpans(node, paragraph, pi, defaults, defs, ctx)}</tspan>`,
		);
		y += size * (paragraph.lineHeight ?? defaults.lineHeight);
	}
	return lines.join("");
}

/** The spans of one paragraph, as inline `<tspan>`s that flow after each other. */
function emitSpans(
	node: CanvasRichTextNode,
	paragraph: RichTextParagraph,
	paragraphIndex: number,
	defaults: RichTextStyleDefaults,
	defs: string[],
	ctx: SvgEmitContext,
): string {
	const out: string[] = [];
	for (const [si, span] of paragraph.spans.entries()) {
		const fill = richSpanFill(node, span, paragraphIndex, si, ctx);
		if (fill.defs) defs.push(fill.defs);
		const attrs = richSpanAttrs(span, fill.fill, ctx, node.id);
		const text = escapeXml(
			applyTextTransform(
				span.text,
				resolveSpanStyle(span, defaults).textTransform,
			),
		);
		out.push(
			attrs.length > 0
				? `<tspan ${attrs.join(" ")}>${text}</tspan>`
				: `<tspan>${text}</tspan>`,
		);
	}
	return out.join("");
}

// --- public options / result -------------------------------------------------

export interface SvgFontFaceDef {
	family: string;
	src: string;
	weight?: string;
	style?: string;
}

/** Fetch raw bytes for a remote/relative asset URI (only needed to embed). */
export type SvgFetchAsset = (
	uri: string,
) => Promise<{ bytes: Uint8Array; contentType: string }>;

/**
 * Resolve a `BrandTokenRef` to a concrete value: a fill (color/gradient) for
 * a `"color"` token, or a font-family string for a `"font"` token. Core never
 * calls this itself with a default — it is the host's brand-kit lookup,
 * injected. Return `undefined` (or omit the option) to leave a token
 * unresolved; the serializer degrades deterministically and records
 * `BRAND_TOKEN_UNRESOLVED`, never throws.
 */
export type SvgResolveBrandToken = (
	ref: BrandTokenRef,
) => string | CanvasGradientFill | undefined;

/**
 * - `auto` (default): inline `data:` URIs, reference everything else.
 * - `embed`: fetch + base64-embed remote URIs (requires `fetchAsset`).
 * - `reference`: always emit `href` referencing the original URI.
 */
export type SvgImageMode = "auto" | "embed" | "reference";

export interface SvgSerializeOptions {
	images?: SvgImageMode;
	fetchAsset?: SvgFetchAsset;
	fonts?: SvgFontFaceDef[];
	/** Skip nodes with `visible === false` (default `true`). */
	skipInvisible?: boolean;
	/** Newline-indent the output for readable/golden snapshots (default `false`). */
	pretty?: boolean;
	/**
	 * Run {@link CanvasIRSchema} over `ir` before emitting and throw on failure
	 * (default `false`). The serializer trusts its input and `fmt` coerces any
	 * non-finite number to `"0"` to keep the output well-formed; enable this to
	 * fail fast on a malformed/un-validated IR (NaN/Infinity, wrong types) instead
	 * of silently emitting zeros.
	 */
	validate?: boolean;
	/**
	 * Node-kind registry (typically `runtime.nodeKinds`). A node whose `type` is
	 * not a built-in kind is emitted via its registered `toSvg` hook; without one
	 * it is skipped with an `UNKNOWN_KIND_SKIPPED` warning.
	 */
	nodeKinds?: CanvasNodeKindRegistry;
	/**
	 * Lays out `rich-text` paragraphs. Core cannot measure glyphs (no DOM, no font
	 * metrics — see {@link CanvasTextMeasurer}), so wrapping is only possible when
	 * the host injects its measurer here. The editor's measurer is the same one it
	 * renders with, which is what makes an export match what the user saw.
	 *
	 * Omit it and rich text still exports deterministically — one line per
	 * paragraph, flagged with `RICH_TEXT_WRAP_APPROXIMATE`.
	 */
	textMeasurer?: CanvasTextMeasurer;
	/**
	 * Fallbacks for span style fields a document leaves unset. Merged over the
	 * built-in defaults, which mirror `createText`'s.
	 */
	richTextDefaults?: Partial<RichTextStyleDefaults>;
	/** Resolve `BrandTokenRef` fills/fonts to concrete values. See {@link SvgResolveBrandToken}. */
	resolveBrandToken?: SvgResolveBrandToken;
}

export interface SvgSerializeResult {
	svg: string;
	warnings: SvgSerializeWarning[];
}

// --- node dispatch + group recursion -----------------------------------------

async function emitNode(
	node: CanvasNode,
	ctx: SvgEmitContext,
	depth: number,
): Promise<string> {
	if (depth > MAX_TREE_DEPTH) {
		throw new CanvasIRDepthError([node.id]);
	}
	if (shouldSkipNode(node, ctx.options.skipInvisible)) return "";
	if (node.meta?.animation) {
		warn(
			ctx,
			"ANIMATION_IGNORED",
			`Node has animation metadata ("${node.meta.animation.kind}") that is not represented in this static export.`,
			node.id,
		);
	}
	const pad = ctx.options.pretty ? "\t".repeat(depth) : "";

	switch (node.type) {
		case "group":
			return emitGroup(node, ctx, depth);
		case "frame":
			return emitFrame(node, ctx, depth);
		case "rect":
			return pad + emitRect(node, ctx);
		case "ellipse":
			return pad + emitEllipse(node, ctx);
		case "polygon":
			return pad + emitPolygon(node, ctx);
		case "star":
			return pad + emitStar(node, ctx);
		case "line":
			return pad + emitLine(node, ctx);
		case "path": {
			const path = emitPath(node, ctx);
			return path ? pad + path : "";
		}
		case "text":
			return pad + emitText(node, ctx);
		case "rich-text": {
			// May be empty (a node with no paragraphs has nothing to paint), so it
			// follows the `path`/`image` precedent rather than the unconditional
			// `pad + …` the always-emitting leaves use.
			const richText = emitRichText(node, ctx);
			return richText ? pad + richText : "";
		}
		case "image": {
			const image = await emitImage(node, ctx);
			return image ? pad + image : "";
		}
		case "svg": {
			const svg = await emitSvg(node, ctx);
			return svg ? pad + svg : "";
		}
		case "ai-placeholder":
			warn(
				ctx,
				"AI_PLACEHOLDER_SKIPPED",
				"AI placeholder nodes have no static SVG representation.",
				node.id,
			);
			return "";
		case "video": {
			const video = await emitVideo(node, ctx);
			return video ? pad + video : "";
		}
		case "audio":
			emitAudio(node, ctx);
			return "";
		default: {
			// A custom (non-built-in) node kind: emit via its registered toSvg hook,
			// else skip with a warning. The built-in cases above keep their exact
			// byte output (golden parity); only unknown kinds reach here.
			const unknown = node as unknown as CanvasUnknownNode;
			const def = ctx.options.nodeKinds?.get(unknown.type);
			if (def?.toSvg) {
				const fragment = def.toSvg(unknown, makeSvgHookContext(ctx));
				return fragment ? pad + fragment : "";
			}
			warn(
				ctx,
				"UNKNOWN_KIND_SKIPPED",
				`No SVG serializer registered for node kind "${unknown.type}".`,
				unknown.id,
			);
			return "";
		}
	}
}

async function emitGroup(
	node: CanvasGroupNode,
	ctx: SvgEmitContext,
	depth: number,
): Promise<string> {
	const pad = ctx.options.pretty ? "\t".repeat(depth) : "";
	const children = await emitChildren(node.children, ctx, depth + 1);
	const attrs = commonAttrs(node, ctx);
	const attrStr = attrs.length ? ` ${attrs.join(" ")}` : "";

	if (children.length === 0) return `${pad}<g${attrStr} />`;
	if (!ctx.options.pretty) return `${pad}<g${attrStr}>${children.join("")}</g>`;
	return `${pad}<g${attrStr}>\n${children.join("\n")}\n${pad}</g>`;
}

/**
 * The neutral fill painted for a frame whose placeholder has no resolved asset
 * and which declares no background of its own. A fixed constant (not a random
 * or theme-derived colour) so the same document always serializes to the same
 * bytes — the golden snapshots depend on it.
 */
const FRAME_PLACEHOLDER_FALLBACK_FILL = "#e2e8f0";

/** True when a placeholder actually points at an asset present in the document. */
function isPlaceholderFilled(
	placeholder: FramePlaceholder,
	ctx: SvgEmitContext,
): boolean {
	return (
		placeholder.assetId !== undefined &&
		ctx.assets[placeholder.assetId] !== undefined
	);
}

/**
 * The fill to paint behind a frame's children, if any.
 *
 * An unresolved placeholder (no `assetId`, or one absent from the document's
 * asset map) is a fidelity gap: the frame is meant to show content that isn't
 * there. Rather than drop it silently, emit the frame's own background — or a
 * deterministic neutral fallback when it has none — and record a structured
 * warning. A *resolved* placeholder needs nothing special here: the asset is
 * carried by an `<image>` CHILD of the frame, which serializes normally and is
 * clipped by the frame rather than baked into it.
 */
function resolveFrameBackground(
	node: CanvasFrameNode,
	ctx: SvgEmitContext,
): CanvasFill | undefined {
	const placeholder = node.placeholder;
	if (placeholder && !isPlaceholderFilled(placeholder, ctx)) {
		warn(
			ctx,
			"FRAME_PLACEHOLDER_UNRESOLVED",
			`Frame placeholder ("${placeholder.kind}") has no resolved asset; painting a fallback background instead.`,
			node.id,
		);
		return node.background ?? FRAME_PLACEHOLDER_FALLBACK_FILL;
	}
	return node.background;
}

/**
 * Geometry attributes for the frame's own box — shared by the clip path and the
 * background rect so the two can never disagree about the rounding.
 */
function frameBoxAttrs(node: CanvasFrameNode): string[] {
	const attrs = [
		`width="${fmt(node.bounds.width)}"`,
		`height="${fmt(node.bounds.height)}"`,
	];
	if (node.radius !== undefined && node.radius > 0) {
		attrs.push(`rx="${fmt(node.radius)}"`, `ry="${fmt(node.radius)}"`);
	}
	return attrs;
}

/**
 * FR-076 (B-03b): the frame box as a concrete element string — a `<path>`
 * when per-corner radii are set, else the classic `<rect>`. Shared by the
 * clip path and the background so the two can never disagree.
 */
function frameBoxElement(node: CanvasFrameNode, extraAttrs: string): string {
	if (node.cornerRadii) {
		return `<path d="${roundedRectPath(node.bounds.width, node.bounds.height, node.cornerRadii)}"${extraAttrs} />`;
	}
	return `<rect ${frameBoxAttrs(node).join(" ")}${extraAttrs} />`;
}

/**
 * A frame is a group that owns a box: it can paint a background and clip its
 * children to that box.
 *
 * The clip is a `<clipPath>` applied to the `<g>` — the same mechanism the image
 * `crop` path uses. Applying it to the group (rather than compositing children
 * into a raster) is what lets a placed image child stay a real `<image>` element
 * that is *clipped* by the frame: a frame never flattens or bakes its content.
 * An unclipped frame emits a plain `<g>`, byte-identical in shape to a group.
 *
 * Children paint over the background, matching the editor's stacking order.
 */
async function emitFrame(
	node: CanvasFrameNode,
	ctx: SvgEmitContext,
	depth: number,
): Promise<string> {
	const pad = ctx.options.pretty ? "\t".repeat(depth) : "";
	const childPad = ctx.options.pretty ? "\t".repeat(depth + 1) : "";
	const attrs = commonAttrs(node, ctx);

	let clipDefs = "";
	if (node.clip) {
		const clipId = `frame-clip-${sanitizeId(node.id)}`;
		clipDefs = `<defs><clipPath id="${clipId}">${frameBoxElement(node, "")}</clipPath></defs>`;
		attrs.push(`clip-path="url(#${clipId})"`);
	}

	const body: string[] = [];
	const background = resolveFrameBackground(node, ctx);
	if (background !== undefined) {
		// Reuse the shared fill machinery so a gradient background lands in
		// `<defs>` exactly like a rect's does.
		const decor = decorate(background, undefined, `${node.id}-bg`, ctx);
		const bgPaint = paintAttrs(decor.fill, undefined, undefined).join(" ");
		body.push(
			`${childPad}${decor.defs}${frameBoxElement(node, bgPaint ? ` ${bgPaint}` : "")}`,
		);
	}
	body.push(...(await emitChildren(node.children, ctx, depth + 1)));

	const attrStr = attrs.length ? ` ${attrs.join(" ")}` : "";
	if (body.length === 0) return `${pad}${clipDefs}<g${attrStr} />`;
	if (!ctx.options.pretty) {
		return `${pad}${clipDefs}<g${attrStr}>${body.join("")}</g>`;
	}
	return `${pad}${clipDefs}<g${attrStr}>\n${body.join("\n")}\n${pad}</g>`;
}

async function emitChildren(
	nodes: readonly CanvasNode[],
	ctx: SvgEmitContext,
	depth: number,
): Promise<string[]> {
	const out: string[] = [];
	for (const child of nodes) {
		const svg = await emitNode(child, ctx, depth);
		if (svg) out.push(svg);
	}
	return out;
}

// --- image emission ----------------------------------------------------------

function sanitizeMimeType(input: string): string {
	return input.trim().replace(/[^a-zA-Z0-9/.+-]/g, "");
}

async function embedRemote(
	uri: string,
	fetchAsset: SvgFetchAsset,
	ctx: SvgEmitContext,
	nodeId: string,
): Promise<string | undefined> {
	try {
		const { bytes, contentType } = await fetchAsset(uri);
		const mime = sanitizeMimeType(contentType) || "application/octet-stream";
		return `data:${mime};base64,${bytesToBase64(bytes)}`;
	} catch {
		warn(
			ctx,
			"MISSING_ASSET",
			`Failed to fetch image "${uri}" for embedding; referencing instead.`,
			nodeId,
		);
		return undefined;
	}
}

/** Resolve an asset URI to a safe `href` value, embedding when requested. */
async function resolveImageHref(
	uri: string,
	ctx: SvgEmitContext,
	nodeId: string,
): Promise<string | undefined> {
	const trimmed = uri.trim();

	if (trimmed.toLowerCase().startsWith("data:")) {
		if (isSafeDataImageUrl(trimmed)) return trimmed;
		warn(
			ctx,
			"UNSAFE_URI",
			"Image data URI is not a permitted image type.",
			nodeId,
		);
		return undefined;
	}

	const safe = normalizeUri(trimmed);
	if (!safe) {
		warn(ctx, "UNSAFE_URI", "Image URI uses a blocked scheme.", nodeId);
		return undefined;
	}

	if (ctx.options.images === "embed") {
		if (ctx.options.fetchAsset) {
			const embedded = await embedRemote(
				safe,
				ctx.options.fetchAsset,
				ctx,
				nodeId,
			);
			if (embedded) return embedded;
		} else {
			warn(
				ctx,
				"EMBED_NO_FETCHER",
				"Image embedding requested without a fetchAsset; referencing instead.",
				nodeId,
			);
		}
	}

	return safe;
}

async function emitImage(
	node: CanvasImageNode,
	ctx: SvgEmitContext,
): Promise<string> {
	const asset = ctx.assets[node.assetId];
	if (!asset) {
		warn(
			ctx,
			"MISSING_ASSET",
			`Image asset "${node.assetId}" was not found.`,
			node.id,
		);
		return "";
	}
	if (node.maskAssetId) {
		warn(
			ctx,
			"IMAGE_MASK_UNSUPPORTED",
			"Image masks are not represented in SVG.",
			node.id,
		);
	}
	if (node.filters && node.filters.length > 0) {
		warn(
			ctx,
			"IMAGE_FILTERS_UNSUPPORTED",
			"Image filters are not represented in SVG.",
			node.id,
		);
	}

	const href = await resolveImageHref(asset.uri, ctx, node.id);
	if (!href) return "";

	// FR-094 fit-mode mapping (B-02). stretch = the pre-B-02 "none" behavior;
	// fill/fit map to slice/meet; original/center place the bitmap at its
	// intrinsic size (needs asset dims — approximated as "fit" + warning when
	// they are unknown), clipped to the node bounds via a wrapping <g> so the
	// clip tracks the node transform and composes with `crop`.
	const fitMode = node.fitMode ?? "stretch";
	const naturalPlacement =
		(fitMode === "original" || fitMode === "center") &&
		asset.width !== undefined &&
		asset.height !== undefined;
	if ((fitMode === "original" || fitMode === "center") && !naturalPlacement) {
		warn(
			ctx,
			"IMAGE_FIT_MODE_APPROXIMATED",
			`Image fit mode "${fitMode}" needs intrinsic asset dimensions; approximating with "fit".`,
			node.id,
		);
	}

	const imageAttrs: string[] = [];
	let defs = "";
	let openWrap = "";
	let closeWrap = "";
	if (
		naturalPlacement &&
		asset.width !== undefined &&
		asset.height !== undefined
	) {
		const offX =
			fitMode === "center" ? (node.bounds.width - asset.width) / 2 : 0;
		const offY =
			fitMode === "center" ? (node.bounds.height - asset.height) / 2 : 0;
		const fitClipId = `fit-${sanitizeId(node.id)}`;
		defs += `<defs><clipPath id="${fitClipId}"><rect width="${fmt(node.bounds.width)}" height="${fmt(node.bounds.height)}" /></clipPath></defs>`;
		openWrap = `<g ${commonAttrs(node, ctx).join(" ")} clip-path="url(#${fitClipId})">`;
		closeWrap = "</g>";
		imageAttrs.push(
			`x="${fmt(offX)}"`,
			`y="${fmt(offY)}"`,
			`width="${fmt(asset.width)}"`,
			`height="${fmt(asset.height)}"`,
			'preserveAspectRatio="none"',
		);
	} else {
		const par =
			fitMode === "fill"
				? "xMidYMid slice"
				: fitMode === "stretch"
					? "none"
					: "xMidYMid meet";
		imageAttrs.push(
			...commonAttrs(node, ctx),
			`width="${fmt(node.bounds.width)}"`,
			`height="${fmt(node.bounds.height)}"`,
			`preserveAspectRatio="${par}"`,
		);
	}

	if (node.crop) {
		const clipId = `crop-${sanitizeId(node.id)}`;
		defs += `<defs><clipPath id="${clipId}"><rect x="${fmt(node.crop.x)}" y="${fmt(node.crop.y)}" width="${fmt(node.crop.width)}" height="${fmt(node.crop.height)}" /></clipPath></defs>`;
		imageAttrs.push(`clip-path="url(#${clipId})"`);
	}
	imageAttrs.push(`href="${escapeAttr(href)}"`);

	return `${defs}${openWrap}<image ${imageAttrs.join(" ")} />${closeWrap}`;
}

/**
 * FR-016: an `svg` node always renders via the SAME safe `<image>`
 * asset-reference path `emitImage` uses (no crop/mask/filters — this node
 * has none) — never as inline `<svg>`/markup. Always emits
 * `SVG_INLINE_UNSUPPORTED`, since inline vector embedding is deferred behind
 * a future `inlineVectorSvg` capability flag.
 */
async function emitSvg(
	node: CanvasSvgNode,
	ctx: SvgEmitContext,
): Promise<string> {
	warn(
		ctx,
		"SVG_INLINE_UNSUPPORTED",
		"SVG nodes render as an <image> asset reference; inline vector embedding is not yet supported.",
		node.id,
	);
	const asset = ctx.assets[node.assetId];
	if (!asset) {
		warn(
			ctx,
			"MISSING_ASSET",
			`SVG asset "${node.assetId}" was not found.`,
			node.id,
		);
		return "";
	}
	const href = await resolveImageHref(asset.uri, ctx, node.id);
	if (!href) return "";

	const attrs = [
		...commonAttrs(node, ctx),
		`width="${fmt(node.bounds.width)}"`,
		`height="${fmt(node.bounds.height)}"`,
		'preserveAspectRatio="none"',
		`href="${escapeAttr(href)}"`,
	];
	return `<image ${attrs.join(" ")} />`;
}

/**
 * A video node (FR-081, canvas-m6-002) has no static SVG representation — its
 * only possible visual is its `poster` asset, rendered via the same
 * asset-reference `<image>` path `emitImage`/`emitSvg` use. Always emits
 * `VIDEO_UNSUPPORTED`; renders nothing when no `poster` is set.
 */
async function emitVideo(
	node: CanvasVideoNode,
	ctx: SvgEmitContext,
): Promise<string> {
	warn(
		ctx,
		"VIDEO_UNSUPPORTED",
		"Video nodes have no static SVG representation; the poster frame is rendered if one is set.",
		node.id,
	);
	if (!node.poster) return "";
	const asset = ctx.assets[node.poster];
	if (!asset) {
		warn(
			ctx,
			"MISSING_ASSET",
			`Video poster asset "${node.poster}" was not found.`,
			node.id,
		);
		return "";
	}
	const href = await resolveImageHref(asset.uri, ctx, node.id);
	if (!href) return "";

	const attrs = [
		...commonAttrs(node, ctx),
		`width="${fmt(node.bounds.width)}"`,
		`height="${fmt(node.bounds.height)}"`,
		'preserveAspectRatio="none"',
		`href="${escapeAttr(href)}"`,
	];
	return `<image ${attrs.join(" ")} />`;
}

/** An audio node (FR-081, canvas-m6-002) has no visual representation at all. */
function emitAudio(node: CanvasAudioNode, ctx: SvgEmitContext): string {
	warn(
		ctx,
		"AUDIO_UNSUPPORTED",
		"Audio nodes have no static SVG representation.",
		node.id,
	);
	return "";
}

// --- fonts -------------------------------------------------------------------

function fontFaceRule(def: SvgFontFaceDef): string {
	const parts = [
		`font-family:"${escapeCssString(def.family)}"`,
		`src:${escapeCssUrl(def.src)}`,
	];
	if (def.weight) parts.push(`font-weight:${escapeCssString(def.weight)}`);
	if (def.style) parts.push(`font-style:${escapeCssString(def.style)}`);
	return `@font-face{${parts.join(";")};}`;
}

/**
 * Emit `<defs><style>` `@font-face` rules for fonts that are both used in the
 * document and present in the manifest. Used families absent from the manifest
 * are reported (one warning per family) and rely on system fallback.
 */
function renderFontDefs(ctx: SvgEmitContext): string {
	const manifest = new Map(ctx.options.fonts.map((def) => [def.family, def]));
	const rules: string[] = [];
	for (const family of ctx.usedFonts) {
		const def = manifest.get(family);
		if (def) {
			rules.push(fontFaceRule(def));
		} else {
			warn(
				ctx,
				"FONT_NOT_IN_MANIFEST",
				`Font family "${family}" is not in the manifest; relying on system fallback.`,
			);
		}
	}
	return rules.length > 0
		? `<defs><style>${rules.join("")}</style></defs>`
		: "";
}

// --- page / document wrapper -------------------------------------------------

function resolvePage(ir: CanvasIR, selector: string | number): CanvasPage {
	if (typeof selector === "number") {
		const page = ir.pages[selector];
		if (!page) {
			throw new RangeError(
				`Canvas page index ${selector} is out of range (pages: ${ir.pages.length}).`,
			);
		}
		return page;
	}
	const page = ir.pages.find((candidate) => candidate.id === selector);
	if (!page) {
		throw new Error(`Canvas page with id "${selector}" was not found.`);
	}
	return page;
}

function backgroundRect(
	page: CanvasPage,
	width: number,
	height: number,
	ctx: SvgEmitContext,
): string | undefined {
	const background = page.background;
	if (background.kind === "solid") {
		return `<rect x="0" y="0" width="${fmt(width)}" height="${fmt(height)}" fill="${escapeAttr(background.value)}" />`;
	}
	warn(
		ctx,
		"BACKGROUND_UNSUPPORTED",
		`Page background of kind "${background.kind}" is not represented in SVG.`,
		page.id,
	);
	return undefined;
}

/**
 * Serialize a single page of a {@link CanvasIR} document to an SVG string.
 *
 * `pageSelector` is either the page id (string) or its index (number); an
 * unknown selector throws. Content-level degradations (unsupported background,
 * unresolved asset, skipped placeholder, …) are reported in `warnings`.
 */
export async function serializePageToSvg(
	ir: CanvasIR,
	pageSelector: string | number,
	options: SvgSerializeOptions = {},
): Promise<SvgSerializeResult> {
	if (options.validate) CanvasIRSchema.parse(ir);
	const page = resolvePage(ir, pageSelector);
	const ctx = createEmitContext(options, ir.assets);
	if (page.animation) {
		warn(
			ctx,
			"ANIMATION_IGNORED",
			`Page has animation metadata ("${page.animation.kind}") that is not represented in this static export.`,
		);
	}
	const pretty = ctx.options.pretty;
	const childPad = pretty ? "\t" : "";

	const width = unitToPx(page.size.width, page.size.unit, page.size.dpi);
	const height = unitToPx(page.size.height, page.size.unit, page.size.dpi);

	const content: string[] = [];
	const background = backgroundRect(page, width, height, ctx);
	if (background) content.push(childPad + background);
	// The page root group is the page coordinate space; emit its children
	// directly so the document isn't wrapped in a redundant <g>.
	content.push(...(await emitChildren(page.root.children, ctx, 1)));

	// Accessible name: prefer the page name, fall back to the document title.
	// `<title>` is emitted as the first child (screen readers announce it) and is
	// paired with `role="img"` — role without a label is an a11y anti-pattern, so
	// neither is added when there is no name to give.
	const titleText = (page.name ?? ir.title ?? "").trim();
	const hasTitle = titleText.length > 0;

	const body: string[] = [];
	if (hasTitle) body.push(`${childPad}<title>${escapeXml(titleText)}</title>`);
	// Font `<defs>` is built after emission so it only covers fonts actually
	// used, and is placed first so `@font-face` is declared before any glyphs.
	const fontDefs = renderFontDefs(ctx);
	if (fontDefs) body.push(childPad + fontDefs);
	body.push(...content);

	const roleAttr = hasTitle ? ' role="img"' : "";
	const open = `<svg xmlns="http://www.w3.org/2000/svg" width="${fmt(width)}" height="${fmt(height)}" viewBox="0 0 ${fmt(width)} ${fmt(height)}"${roleAttr}>`;

	let svg: string;
	if (body.length === 0) {
		svg = `${open}</svg>`;
	} else if (pretty) {
		svg = `${open}\n${body.join("\n")}\n</svg>`;
	} else {
		svg = `${open}${body.join("")}</svg>`;
	}

	return { svg, warnings: ctx.warnings };
}
