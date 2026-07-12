import type {
	CanvasFill,
	CanvasTextAlign,
	RichTextParagraph,
	RichTextSpan,
	RichTextWrap,
} from "./ir/types.js";

/**
 * The headless text-measurement contract.
 *
 * Core CANNOT measure text. Measuring needs font metrics, which need a Canvas2D
 * context, a DOM, or a font-shaping library — none of which may exist here: core
 * is React-free, Konva-free and DOM-free by gate (`check:react-free-runtime`),
 * and it runs unchanged in a browser, in Node, and inside a worker.
 *
 * So core defines the SHAPE of a measurement and nothing else. There is no layout
 * engine in this package and there must never be one. The editor implements this
 * port against Konva/Canvas2D (canvas-m1-008); the SVG serializer takes an
 * implementation through its options (canvas-m1-007). Both then produce the same
 * line breaks from the same document, which is the whole point of hoisting the
 * contract up here instead of letting each side invent its own.
 */

/**
 * A span's style with every optional field resolved.
 *
 * {@link RichTextSpan} leaves each style field optional, meaning "inherit the
 * host's default". Something has to turn that into concrete values before any
 * glyph can be measured, and if the editor and the exporter each did it their own
 * way they would disagree about where lines break — the exact class of bug this
 * contract exists to prevent. {@link resolveSpanStyle} is that single answer.
 */
export interface ResolvedSpanStyle {
	fontFamily: string;
	fontSize: number;
	fontWeight: string;
	italic: boolean;
	underline: boolean;
	letterSpacing: number;
	textTransform: NonNullable<RichTextSpan["textTransform"]>;
	fill: CanvasFill;
}

/** The host's fallbacks for span fields a document leaves unset. */
export interface RichTextStyleDefaults extends ResolvedSpanStyle {
	/** Multiple of the resolved font size, used when a paragraph omits its own. */
	lineHeight: number;
	align: CanvasTextAlign;
}

/**
 * Resolve one span against the host's defaults. Pure, allocation-only, and
 * deliberately dumb — it is field inheritance, not layout.
 */
export function resolveSpanStyle(
	span: RichTextSpan,
	defaults: RichTextStyleDefaults,
): ResolvedSpanStyle {
	return {
		fontFamily: span.fontFamily ?? defaults.fontFamily,
		fontSize: span.fontSize ?? defaults.fontSize,
		fontWeight: span.fontWeight ?? defaults.fontWeight,
		italic: span.italic ?? defaults.italic,
		underline: span.underline ?? defaults.underline,
		letterSpacing: span.letterSpacing ?? defaults.letterSpacing,
		textTransform: span.textTransform ?? defaults.textTransform,
		fill: span.fill ?? defaults.fill,
	};
}

/** What to lay out, and the box to lay it out into. */
export interface TextMeasureRequest {
	paragraphs: readonly RichTextParagraph[];
	/** The width lines wrap against, in the node's local units. */
	width: number;
	wrap: RichTextWrap;
	defaults: RichTextStyleDefaults;
}

/**
 * A contiguous piece of ONE span that landed on ONE line.
 *
 * A span is split across lines when it wraps, so a run is a slice of it, not the
 * whole thing. `spanIndex` points back into the source paragraph so a caller can
 * recover the styling (and so a hit-test can map a click back to a text offset)
 * without the measurer having to copy the style onto every run.
 */
export interface MeasuredRun {
	paragraphIndex: number;
	spanIndex: number;
	/** Character offset of this run within its span's `text`. */
	start: number;
	/** The slice itself — `span.text.slice(start, start + text.length)`. */
	text: string;
	/** Offset from the line's left edge. */
	x: number;
	width: number;
}

export interface MeasuredLine {
	paragraphIndex: number;
	runs: MeasuredRun[];
	/** Offset from the block's left edge — this is where `align` is applied. */
	x: number;
	/** Offset from the block's top edge. */
	y: number;
	width: number;
	height: number;
	/** Baseline offset from the line's own top, for placing glyphs. */
	baseline: number;
}

export interface MeasuredText {
	lines: MeasuredLine[];
	/** The widest line. May exceed the requested width when `wrap` is `"none"`. */
	width: number;
	/** Total laid-out height — what `overflow: "auto-height"` resizes to. */
	height: number;
}

/**
 * Lay out rich text. Implementations MUST be pure: the same request has to give
 * the same result, or an export will not match what the editor showed.
 */
export type CanvasTextMeasurer = (request: TextMeasureRequest) => MeasuredText;
