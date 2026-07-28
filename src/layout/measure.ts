import { fingerprint64 } from "../hash.js";
import type {
	CanvasAssetRef,
	CanvasBounds,
	CanvasNode,
	CanvasRichTextNode,
	CanvasTextNode,
	RichTextParagraph,
	RichTextWrap,
} from "../ir/types.js";
import {
	MAX_MEASUREMENT_REQUESTS,
	MAX_MEASUREMENT_TEXT_LENGTH,
} from "../limits.js";
import {
	DEFAULT_RICH_TEXT_STYLE,
	type RichTextStyleDefaults,
	resolveSpanStyle,
} from "../text-contracts.js";
import type { CanvasLayoutMeasurementProvider } from "./types.js";
import { type CanvasLayoutIssue, createLayoutIssue } from "./validate.js";

/**
 * @file Intrinsic-size measurement for the layout resolver (TD §7.2, §8).
 *
 * This module **composes** the existing `CanvasTextMeasurer` port; it never
 * redefines it. That port is synchronous and required to be pure, because the
 * same measurer must produce identical line breaks in the editor, in an export
 * worker, and in Node — so everything here is synchronous too, and there is no
 * `Promise` variant anywhere in the resolution path.
 *
 * Three rules this file exists to enforce:
 *
 * 1. **One measurer for two node kinds.** Only `rich-text` maps directly onto
 *    `TextMeasureRequest` (which takes `paragraphs`). A plain `text` node is a
 *    single unstyled string, and it is adapted here into a one-span,
 *    one-paragraph request measured with `wrap: "none"` — rather than growing
 *    a second measurement path that would drift from the first.
 * 2. **The document outranks the provider for asset sizes.** `ir.assets[id]`
 *    is read first and the provider only fills gaps, because the document is
 *    what an export worker also has; preferring a session-local provider would
 *    make the same document resolve differently in the editor and on export.
 * 3. **A missing measurement is a diagnostic, not a throw.** The resolver must
 *    keep an editor interactive when fonts have not loaded, so every failure
 *    path here returns a deterministic fallback size plus
 *    `layout-measurement-missing` (NFR-REL-002 / AC-008).
 */

/** Kinds whose intrinsic size comes from an asset rather than from measurement. */
type AssetBackedNode = Extract<
	CanvasNode,
	{ type: "image" | "svg" | "video" | "audio" }
>;

function isAssetBacked(node: CanvasNode): node is AssetBackedNode {
	return (
		node.type === "image" ||
		node.type === "svg" ||
		node.type === "video" ||
		node.type === "audio"
	);
}

/**
 * Everything the intrinsic-size pass needs, resolved once per resolution
 * rather than re-derived per node.
 */
export interface LayoutMeasurementContext {
	readonly assets: Readonly<Record<string, CanvasAssetRef>>;
	readonly provider?: CanvasLayoutMeasurementProvider;
	/** Host defaults merged over the package-wide base — never a partial. */
	readonly defaults: RichTextStyleDefaults;
	/** Identity of the provider's font/asset manifest; part of every key. */
	readonly manifestHash: string;
	/** Measurement results keyed per TD §8.2, shared across the whole pass. */
	readonly cache: Map<string, CanvasBounds>;
	/** Requests issued so far, against `MAX_MEASUREMENT_REQUESTS`. */
	budget: { spent: number };
}

export function createMeasurementContext(
	assets: Readonly<Record<string, CanvasAssetRef>>,
	options: {
		provider?: CanvasLayoutMeasurementProvider;
		richTextDefaults?: Partial<RichTextStyleDefaults>;
	} = {},
): LayoutMeasurementContext {
	const context: LayoutMeasurementContext = {
		assets,
		defaults: {
			...DEFAULT_RICH_TEXT_STYLE,
			...(options.richTextDefaults ?? {}),
		},
		manifestHash: options.provider?.manifestHash ?? "",
		cache: new Map(),
		budget: { spent: 0 },
	};
	return options.provider
		? { ...context, provider: options.provider }
		: context;
}

/** What an intrinsic measurement produced, and what went wrong if anything did. */
export interface IntrinsicMeasurement {
	readonly size: CanvasBounds;
	/**
	 * The TD §8.2 measurement key, when a measurement was actually attempted.
	 * Absent for nodes whose size needs no measuring.
	 */
	readonly key?: string;
	/** Present only when the size below is a fallback rather than a measurement. */
	readonly issue?: CanvasLayoutIssue;
}

/**
 * The stable measurement key (TD §8.2).
 *
 * Includes node kind + content, every field of the resolved span style
 * (**including** paragraph line height and alignment, which the editor's
 * current cache omits — that omission is a real collision between two nodes
 * inheriting different host defaults), the wrap mode, the effective width
 * constraint, and the provider manifest.
 *
 * `overflow` is deliberately **excluded**: it governs how a measured block is
 * reconciled back into `bounds` afterwards, not how it is measured. Including
 * it would fragment the cache by a field that cannot change the result.
 *
 * No node id is included, so two nodes with identical content and style share
 * one entry — which is what makes the §15.1 "100 text nodes over 20
 * measurement keys" workload a 20-measurement pass rather than a 100.
 */
export function measurementKey(input: {
	kind: CanvasNode["type"];
	paragraphs: readonly RichTextParagraph[];
	wrap: RichTextWrap;
	width: number | undefined;
	defaults: RichTextStyleDefaults;
	manifestHash: string;
}): string {
	const parts: string[] = [
		input.kind,
		input.wrap,
		input.width === undefined ? "auto" : String(input.width),
		input.manifestHash,
	];
	for (const paragraph of input.paragraphs) {
		// Paragraph-level inheritance is part of the measurement, so it is part
		// of the key — this is the half the editor's existing cache drops.
		parts.push(
			`p:${paragraph.align ?? input.defaults.align}:${
				paragraph.lineHeight ?? input.defaults.lineHeight
			}`,
		);
		for (const span of paragraph.spans) {
			const style = resolveSpanStyle(span, input.defaults);
			parts.push(
				[
					"s",
					span.text,
					// `fill` is a paint property, but it is part of ResolvedSpanStyle
					// and a brand token can resolve to different families; keeping the
					// whole resolved style in the key is cheaper than auditing which
					// of its fields can ever move a glyph.
					typeof style.fontFamily === "string"
						? style.fontFamily
						: JSON.stringify(style.fontFamily),
					style.fontSize,
					style.fontWeight,
					style.italic,
					style.underline,
					style.strikethrough,
					style.letterSpacing,
					style.textTransform,
				].join(""),
			);
		}
	}
	return fingerprint64(parts.join(""));
}

/** Total character count across a request's spans, for the length cap. */
function contentLength(paragraphs: readonly RichTextParagraph[]): number {
	let total = 0;
	for (const paragraph of paragraphs) {
		for (const span of paragraph.spans) total += span.text.length;
	}
	return total;
}

/**
 * Adapt a plain `text` node into the rich-text measurement request shape.
 *
 * A `CanvasTextNode` is one string with one style and no wrapping, so it
 * becomes exactly one paragraph holding exactly one span, measured with
 * `wrap: "none"`. Its node-level `fontFamily`/`fontSize`/`fontWeight` become
 * span overrides so they win over the host defaults, and `align` becomes the
 * paragraph's.
 */
function textNodeParagraphs(node: CanvasTextNode): RichTextParagraph[] {
	return [
		{
			...(node.align ? { align: node.align } : {}),
			spans: [
				{
					text: node.text,
					fontFamily: node.fontFamily,
					fontSize: node.fontSize,
					...(node.fontWeight ? { fontWeight: node.fontWeight } : {}),
					fill: node.fill,
				},
			],
		},
	];
}

function measureParagraphs(
	node: CanvasNode,
	paragraphs: readonly RichTextParagraph[],
	wrap: RichTextWrap,
	width: number | undefined,
	context: LayoutMeasurementContext,
	fallback: CanvasBounds,
): IntrinsicMeasurement {
	const key = measurementKey({
		kind: node.type,
		paragraphs,
		wrap,
		width,
		defaults: context.defaults,
		manifestHash: context.manifestHash,
	});
	const cached = context.cache.get(key);
	if (cached) return { size: cached, key };

	if (!context.provider) {
		return {
			size: fallback,
			key,
			issue: createLayoutIssue("layout-measurement-missing", {
				nodeId: node.id,
				message: `No measurement provider was supplied, so "${node.id}" cannot be measured; falling back to its stored bounds.`,
			}),
		};
	}
	if (contentLength(paragraphs) > MAX_MEASUREMENT_TEXT_LENGTH) {
		return {
			size: fallback,
			key,
			issue: createLayoutIssue("layout-measurement-missing", {
				nodeId: node.id,
				message: `Node "${node.id}" exceeds MAX_MEASUREMENT_TEXT_LENGTH=${MAX_MEASUREMENT_TEXT_LENGTH} characters and was not measured; falling back to its stored bounds.`,
			}),
		};
	}
	if (context.budget.spent >= MAX_MEASUREMENT_REQUESTS) {
		return {
			size: fallback,
			key,
			issue: createLayoutIssue("layout-measurement-missing", {
				nodeId: node.id,
				message: `This resolution reached MAX_MEASUREMENT_REQUESTS=${MAX_MEASUREMENT_REQUESTS}; "${node.id}" was not measured and falls back to its stored bounds.`,
			}),
		};
	}

	context.budget.spent += 1;
	let measured: { width: number; height: number };
	try {
		measured = context.provider.measureText({
			paragraphs,
			// The port takes a required width; `wrap: "none"` makes it inert, and
			// an unconstrained rich-text measurement passes Infinity so the
			// measurer reports the natural width rather than wrapping at 0.
			width: width ?? Number.POSITIVE_INFINITY,
			wrap,
			defaults: context.defaults,
		});
	} catch (error) {
		// A host measurer that throws — an unloaded font, a detached canvas —
		// must not take the document down with it. NFR-REL-002.
		return {
			size: fallback,
			key,
			issue: createLayoutIssue("layout-measurement-missing", {
				nodeId: node.id,
				message: `Measuring "${node.id}" failed (${
					error instanceof Error ? error.message : String(error)
				}); falling back to its stored bounds.`,
			}),
		};
	}

	if (!Number.isFinite(measured.width) || !Number.isFinite(measured.height)) {
		return {
			size: fallback,
			key,
			issue: createLayoutIssue("layout-measurement-missing", {
				nodeId: node.id,
				message: `Measuring "${node.id}" returned a non-finite size (${measured.width}×${measured.height}); falling back to its stored bounds.`,
			}),
		};
	}

	const size: CanvasBounds = {
		width: Math.max(0, measured.width),
		height: Math.max(0, measured.height),
	};
	context.cache.set(key, size);
	return { size, key };
}

/**
 * Intrinsic size of one node, per the TD §7.2 precedence.
 *
 * `widthConstraint` is the width the caller has already decided this node gets
 * on its inline axis — the wrap width for rich text. `undefined` means the
 * width is itself being hugged and the content decides it.
 *
 * Auto Layout frames are **not** handled here: their intrinsic size is their
 * resolved children plus padding and gap, which only the solver knows. This
 * function is the leaf half of the precedence table.
 */
export function measureIntrinsicSize(
	node: CanvasNode,
	context: LayoutMeasurementContext,
	widthConstraint?: number,
): IntrinsicMeasurement {
	if (node.type === "rich-text") {
		const rich = node as CanvasRichTextNode;
		// The authored wrap width is the fallback constraint when the caller has
		// not fixed one; `sizing: "auto-width"` means the content decides.
		const width =
			widthConstraint ??
			(rich.sizing === "auto-width" ? undefined : rich.width);
		return measureParagraphs(
			node,
			rich.paragraphs,
			rich.wrap ?? "word",
			width,
			context,
			node.bounds,
		);
	}

	if (node.type === "text") {
		// Single-line by contract, so wrap is "none" and the width constraint is
		// irrelevant to the result — passing it would only fragment the cache.
		return measureParagraphs(
			node,
			textNodeParagraphs(node as CanvasTextNode),
			"none",
			undefined,
			context,
			node.bounds,
		);
	}

	if (isAssetBacked(node)) {
		const asset = context.assets[node.assetId];
		if (
			asset &&
			typeof asset.width === "number" &&
			typeof asset.height === "number" &&
			Number.isFinite(asset.width) &&
			Number.isFinite(asset.height)
		) {
			return { size: { width: asset.width, height: asset.height } };
		}
		const fromProvider = context.provider?.getIntrinsicAssetSize?.(
			node.assetId,
		);
		if (
			fromProvider &&
			Number.isFinite(fromProvider.width) &&
			Number.isFinite(fromProvider.height)
		) {
			return { size: fromProvider };
		}
		return {
			size: node.bounds,
			issue: createLayoutIssue("layout-measurement-missing", {
				nodeId: node.id,
				message: `No intrinsic size is recorded for asset "${node.assetId}" on node "${node.id}", and no provider supplied one; falling back to its stored bounds.`,
			}),
		};
	}

	// Every other leaf: stored bounds are the intrinsic size. Requesting Hug on
	// one of these is reported by `validateLayoutInvariants`
	// (`layout-hug-unsupported`), not here — this function's contract is to
	// return a usable size, never to second-guess the request.
	return { size: node.bounds };
}
