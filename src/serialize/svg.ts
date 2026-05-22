import type {
	CanvasAssetRef,
	CanvasEllipseNode,
	CanvasGroupNode,
	CanvasImageNode,
	CanvasIR,
	CanvasLineNode,
	CanvasNode,
	CanvasNodeBase,
	CanvasPage,
	CanvasPathNode,
	CanvasRectNode,
	CanvasTextAlign,
	CanvasTextNode,
	CanvasTransform,
	CanvasUnit,
} from "../types.js";

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
 *  - Image `maskAssetId` / `filters` are not represented (out of scope here).
 */

// --- URL / scheme safety (mirrors plugin-export-html `normalizeUrl`) ---------

const BLOCKED_URI_SCHEMES = [
	"javascript:",
	"vbscript:",
	"file:",
	"blob:",
	"filesystem:",
] as const;

const SAFE_DATA_IMAGE_RE =
	/^data:image\/(?:png|jpe?g|gif|webp|avif)(?:;[^,]*)?,/i;

const PATH_D_RE = /^[\sMmLlHhVvCcSsQqTtAaZz0-9.,+\-eE]*$/;

const BTOA_CHUNK_SIZE = 0x8000;

/** px-per-inch used when a page size omits an explicit `dpi`. */
export const DEFAULT_DPI = 96;

const DEG_TO_RAD = Math.PI / 180;

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
 * Strip only `<`, `>` and newlines from a CSS `src` value so it cannot break
 * out of the `<style>` element while preserving `url(...)`/`format(...)` quotes.
 */
export function escapeCssUrl(input: string): string {
	return input.replace(/[<>\r\n]/g, "");
}

// --- URI normalization -------------------------------------------------------

export interface NormalizeUriOptions {
	readonly allowSafeDataImage?: boolean;
}

/**
 * Returns a safe URI, or `undefined` when the scheme is blocked. Mirrors the
 * blocked-scheme list in plugin-export-html. `data:` URIs are only allowed when
 * `allowSafeDataImage` is set and the payload is a known raster image type.
 */
export function normalizeUri(
	input: string,
	options: NormalizeUriOptions = {},
): string | undefined {
	const candidate = input.trim();
	if (!candidate) return undefined;

	const collapsed = stripControlChars(candidate).toLowerCase();
	for (const scheme of BLOCKED_URI_SCHEMES) {
		if (collapsed.startsWith(scheme)) return undefined;
	}

	if (
		collapsed.startsWith("data:") &&
		(!options.allowSafeDataImage || !isSafeDataImageUrl(candidate))
	) {
		return undefined;
	}

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

/** SVG `matrix(a b c d e f)` tuple: point (x,y) → (a·x + c·y + e, b·x + d·y + f). */
export type AffineMatrix = [number, number, number, number, number, number];

function matrixTranslate(m: AffineMatrix, x: number, y: number): void {
	m[4] += m[0] * x + m[2] * y;
	m[5] += m[1] * x + m[3] * y;
}

function matrixRotate(m: AffineMatrix, rad: number): void {
	const c = Math.cos(rad);
	const s = Math.sin(rad);
	const m11 = m[0] * c + m[2] * s;
	const m12 = m[1] * c + m[3] * s;
	const m21 = m[0] * -s + m[2] * c;
	const m22 = m[1] * -s + m[3] * c;
	m[0] = m11;
	m[1] = m12;
	m[2] = m21;
	m[3] = m22;
}

function matrixScale(m: AffineMatrix, sx: number, sy: number): void {
	m[0] *= sx;
	m[1] *= sx;
	m[2] *= sy;
	m[3] *= sy;
}

function matrixSkew(m: AffineMatrix, kx: number, ky: number): void {
	const m11 = m[0] + m[2] * ky;
	const m12 = m[1] + m[3] * ky;
	const m21 = m[2] + m[0] * kx;
	const m22 = m[3] + m[1] * kx;
	m[0] = m11;
	m[1] = m12;
	m[2] = m21;
	m[3] = m22;
}

/**
 * Compose a transform into an affine matrix, replicating Konva's
 * `Node.getTransform` order exactly: translate → rotate → skew → scale.
 * (CanvasIR has no `offset`, so the trailing offset translate is always 0.)
 */
export function toAffineMatrix(t: CanvasTransform): AffineMatrix {
	const m: AffineMatrix = [1, 0, 0, 1, 0, 0];
	if (t.x !== 0 || t.y !== 0) matrixTranslate(m, t.x, t.y);
	if (t.rotation !== 0) matrixRotate(m, t.rotation * DEG_TO_RAD);
	const skewX = t.skewX ?? 0;
	const skewY = t.skewY ?? 0;
	if (skewX !== 0 || skewY !== 0) matrixSkew(m, skewX, skewY);
	if (t.scaleX !== 1 || t.scaleY !== 1) matrixScale(m, t.scaleX, t.scaleY);
	return m;
}

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
	| "IMAGE_MASK_UNSUPPORTED"
	| "IMAGE_FILTERS_UNSUPPORTED"
	| "BACKGROUND_UNSUPPORTED";

export interface SvgSerializeWarning {
	code: SvgWarningCode;
	message: string;
	nodeId?: string;
}

/** Options resolved to concrete values, threaded through emission. */
export interface ResolvedSvgOptions {
	images: SvgImageMode;
	skipInvisible: boolean;
	pretty: boolean;
	fonts: SvgFontFaceDef[];
	fetchAsset?: SvgFetchAsset;
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
	};
	if (options.fetchAsset) resolved.fetchAsset = options.fetchAsset;
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

// --- shape emitters (synchronous; image emission is async, added later) ------

export function emitRect(node: CanvasRectNode, ctx: SvgEmitContext): string {
	const attrs = [
		...commonAttrs(node, ctx),
		`width="${fmt(node.bounds.width)}"`,
		`height="${fmt(node.bounds.height)}"`,
	];
	if (node.radius !== undefined && node.radius > 0) {
		attrs.push(`rx="${fmt(node.radius)}"`, `ry="${fmt(node.radius)}"`);
	}
	attrs.push(...paintAttrs(node.fill, node.stroke, node.strokeWidth));
	return `<rect ${attrs.join(" ")} />`;
}

export function emitEllipse(
	node: CanvasEllipseNode,
	ctx: SvgEmitContext,
): string {
	const rx = node.bounds.width / 2;
	const ry = node.bounds.height / 2;
	const attrs = [
		...commonAttrs(node, ctx),
		`cx="${fmt(rx)}"`,
		`cy="${fmt(ry)}"`,
		`rx="${fmt(rx)}"`,
		`ry="${fmt(ry)}"`,
		...paintAttrs(node.fill, node.stroke, node.strokeWidth),
	];
	return `<ellipse ${attrs.join(" ")} />`;
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
	return `<line ${attrs.join(" ")} />`;
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
	const attrs = [
		...commonAttrs(node, ctx),
		`d="${escapeAttr(node.d)}"`,
		...paintAttrs(node.fill, node.stroke, node.strokeWidth),
	];
	return `<path ${attrs.join(" ")} />`;
}

export function emitText(node: CanvasTextNode, ctx: SvgEmitContext): string {
	ctx.usedFonts.add(node.fontFamily);
	const anchor = textAnchor(node.align);
	const x = textAnchorX(node.align, node.bounds.width);
	const baselineY = node.fontSize * TEXT_ASCENT_RATIO;

	const attrs = [
		...commonAttrs(node, ctx),
		`x="${fmt(x)}"`,
		`y="${fmt(baselineY)}"`,
		`font-family="${escapeAttr(node.fontFamily)}"`,
		`font-size="${fmt(node.fontSize)}"`,
	];
	if (node.fontWeight !== undefined) {
		attrs.push(`font-weight="${escapeAttr(node.fontWeight)}"`);
	}
	if (anchor !== "start") attrs.push(`text-anchor="${anchor}"`);
	attrs.push(`fill="${escapeAttr(node.fill)}"`);

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
		return `<text ${attrs.join(" ")}>${tspans}</text>`;
	}
	return `<text ${attrs.join(" ")}>${escapeXml(node.text)}</text>`;
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
	if (shouldSkipNode(node, ctx.options.skipInvisible)) return "";
	const pad = ctx.options.pretty ? "\t".repeat(depth) : "";

	switch (node.type) {
		case "group":
			return emitGroup(node, ctx, depth);
		case "rect":
			return pad + emitRect(node, ctx);
		case "ellipse":
			return pad + emitEllipse(node, ctx);
		case "line":
			return pad + emitLine(node, ctx);
		case "path": {
			const path = emitPath(node, ctx);
			return path ? pad + path : "";
		}
		case "text":
			return pad + emitText(node, ctx);
		case "image": {
			const image = await emitImage(node, ctx);
			return image ? pad + image : "";
		}
		case "ai-placeholder":
			warn(
				ctx,
				"AI_PLACEHOLDER_SKIPPED",
				"AI placeholder nodes have no static SVG representation.",
				node.id,
			);
			return "";
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

	const attrs = [
		...commonAttrs(node, ctx),
		`width="${fmt(node.bounds.width)}"`,
		`height="${fmt(node.bounds.height)}"`,
		'preserveAspectRatio="none"',
	];

	let defs = "";
	if (node.crop) {
		const clipId = `crop-${sanitizeId(node.id)}`;
		defs = `<defs><clipPath id="${clipId}"><rect x="${fmt(node.crop.x)}" y="${fmt(node.crop.y)}" width="${fmt(node.crop.width)}" height="${fmt(node.crop.height)}" /></clipPath></defs>`;
		attrs.push(`clip-path="url(#${clipId})"`);
	}
	attrs.push(`href="${escapeAttr(href)}"`);

	return `${defs}<image ${attrs.join(" ")} />`;
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
	const page = resolvePage(ir, pageSelector);
	const ctx = createEmitContext(options, ir.assets);
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

	// Font `<defs>` is built after emission so it only covers fonts actually
	// used, and is placed first so `@font-face` is declared before any glyphs.
	const body: string[] = [];
	const fontDefs = renderFontDefs(ctx);
	if (fontDefs) body.push(childPad + fontDefs);
	body.push(...content);

	const open = `<svg xmlns="http://www.w3.org/2000/svg" width="${fmt(width)}" height="${fmt(height)}" viewBox="0 0 ${fmt(width)} ${fmt(height)}">`;

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
