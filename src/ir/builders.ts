import { nowIso } from "../clock.js";
import type {
	BrandTokenRef,
	CanvasAudioNode,
	CanvasBounds,
	CanvasEllipseNode,
	CanvasFill,
	CanvasFontFamily,
	CanvasFrameNode,
	CanvasGroupNode,
	CanvasImageAdjustments,
	CanvasImageCrop,
	CanvasImageNode,
	CanvasIR,
	CanvasLineNode,
	CanvasMediaTrim,
	CanvasNode,
	CanvasPage,
	CanvasPageBackground,
	CanvasPageLayoutAids,
	CanvasPageSize,
	CanvasPathNode,
	CanvasPolygonNode,
	CanvasRectNode,
	CanvasRichTextNode,
	CanvasStarNode,
	CanvasSvgNode,
	CanvasTextAlign,
	CanvasTextNode,
	CanvasTransform,
	CanvasVideoNode,
	FramePlaceholder,
	ImageFilter,
	RichTextOverflow,
	RichTextParagraph,
	RichTextWrap,
} from "./types.js";
import { CANVAS_IR_VERSION } from "./validators.js";

const IDENTITY_TRANSFORM: CanvasTransform = {
	x: 0,
	y: 0,
	rotation: 0,
	scaleX: 1,
	scaleY: 1,
};

const DEFAULT_PAGE_SIZE: CanvasPageSize = {
	width: 1080,
	height: 1080,
	unit: "px",
};

const DEFAULT_PAGE_BACKGROUND: CanvasPageBackground = {
	kind: "solid",
	value: "#ffffff",
};

function generateId(): string {
	const c = (globalThis as { crypto?: { randomUUID?: () => string } }).crypto;
	if (c && typeof c.randomUUID === "function") {
		return c.randomUUID();
	}
	// RFC4122-style v4 fallback for environments without crypto.randomUUID.
	const rand = (n: number) =>
		Math.floor(Math.random() * 2 ** n)
			.toString(16)
			.padStart(Math.ceil(n / 4), "0");
	return `${rand(32)}-${rand(16)}-4${rand(12).slice(0, 3)}-${(8 + Math.floor(Math.random() * 4)).toString(16)}${rand(12).slice(0, 3)}-${rand(48)}`;
}

function clonePartialTransform(
	override: Partial<CanvasTransform> | undefined,
): CanvasTransform {
	return { ...IDENTITY_TRANSFORM, ...(override ?? {}) };
}

export interface CreateCanvasIROptions {
	id?: string;
	title?: string;
	pages?: CanvasPage[];
	ownerId?: string;
	brandId?: string;
	now?: () => string;
}

export function createCanvasIR(options: CreateCanvasIROptions = {}): CanvasIR {
	const now = options.now ?? nowIso;
	const ts = now();
	const pages = options.pages?.length ? options.pages : [createPage()];
	return {
		version: CANVAS_IR_VERSION,
		id: options.id ?? generateId(),
		title: options.title ?? "Untitled",
		pages,
		assets: {},
		metadata: {
			createdAt: ts,
			updatedAt: ts,
			...(options.ownerId !== undefined ? { ownerId: options.ownerId } : {}),
			...(options.brandId !== undefined ? { brandId: options.brandId } : {}),
		},
	};
}

export interface CreatePageOptions {
	id?: string;
	name?: string;
	size?: CanvasPageSize;
	background?: CanvasPageBackground;
	root?: CanvasGroupNode;
	layoutAids?: CanvasPageLayoutAids;
}

export function createPage(options: CreatePageOptions = {}): CanvasPage {
	const size = options.size ?? DEFAULT_PAGE_SIZE;
	return {
		id: options.id ?? generateId(),
		...(options.name !== undefined ? { name: options.name } : {}),
		size,
		background: options.background ?? DEFAULT_PAGE_BACKGROUND,
		root:
			options.root ??
			createGroup({
				bounds: { width: size.width, height: size.height },
			}),
		...(options.layoutAids !== undefined
			? { layoutAids: options.layoutAids }
			: {}),
	};
}

export interface CreateGroupOptions {
	id?: string;
	name?: string;
	transform?: Partial<CanvasTransform>;
	bounds?: CanvasBounds;
	zIndex?: number;
	children?: CanvasNode[];
}

export function createGroup(options: CreateGroupOptions = {}): CanvasGroupNode {
	return {
		id: options.id ?? generateId(),
		...(options.name !== undefined ? { name: options.name } : {}),
		type: "group",
		transform: clonePartialTransform(options.transform),
		bounds: options.bounds ?? { width: 0, height: 0 },
		zIndex: options.zIndex ?? 0,
		children: options.children ?? [],
	};
}

export interface CreateFrameOptions {
	id?: string;
	name?: string;
	transform?: Partial<CanvasTransform>;
	/** A frame owns its bounds (unlike a group, which derives them from children). */
	bounds: CanvasBounds;
	zIndex?: number;
	children?: CanvasNode[];
	clip?: boolean;
	background?: CanvasFill;
	placeholder?: FramePlaceholder;
	radius?: number;
}

export function createFrame(options: CreateFrameOptions): CanvasFrameNode {
	return {
		id: options.id ?? generateId(),
		...(options.name !== undefined ? { name: options.name } : {}),
		type: "frame",
		transform: clonePartialTransform(options.transform),
		bounds: options.bounds,
		zIndex: options.zIndex ?? 0,
		children: options.children ?? [],
		...(options.clip !== undefined ? { clip: options.clip } : {}),
		...(options.background !== undefined
			? { background: options.background }
			: {}),
		...(options.placeholder !== undefined
			? { placeholder: options.placeholder }
			: {}),
		...(options.radius !== undefined ? { radius: options.radius } : {}),
	};
}

export interface CreateRectOptions {
	id?: string;
	name?: string;
	transform?: Partial<CanvasTransform>;
	bounds: CanvasBounds;
	zIndex?: number;
	fill?: CanvasFill;
	stroke?: string;
	strokeWidth?: number;
	radius?: number;
}

export function createRect(options: CreateRectOptions): CanvasRectNode {
	return {
		id: options.id ?? generateId(),
		...(options.name !== undefined ? { name: options.name } : {}),
		type: "rect",
		transform: clonePartialTransform(options.transform),
		bounds: options.bounds,
		zIndex: options.zIndex ?? 0,
		...(options.fill !== undefined ? { fill: options.fill } : {}),
		...(options.stroke !== undefined ? { stroke: options.stroke } : {}),
		...(options.strokeWidth !== undefined
			? { strokeWidth: options.strokeWidth }
			: {}),
		...(options.radius !== undefined ? { radius: options.radius } : {}),
	};
}

export interface CreateEllipseOptions {
	id?: string;
	name?: string;
	transform?: Partial<CanvasTransform>;
	bounds: CanvasBounds;
	zIndex?: number;
	fill?: CanvasFill;
	stroke?: string;
	strokeWidth?: number;
}

export function createEllipse(
	options: CreateEllipseOptions,
): CanvasEllipseNode {
	return {
		id: options.id ?? generateId(),
		...(options.name !== undefined ? { name: options.name } : {}),
		type: "ellipse",
		transform: clonePartialTransform(options.transform),
		bounds: options.bounds,
		zIndex: options.zIndex ?? 0,
		...(options.fill !== undefined ? { fill: options.fill } : {}),
		...(options.stroke !== undefined ? { stroke: options.stroke } : {}),
		...(options.strokeWidth !== undefined
			? { strokeWidth: options.strokeWidth }
			: {}),
	};
}

export interface CreatePolygonOptions {
	id?: string;
	name?: string;
	transform?: Partial<CanvasTransform>;
	bounds: CanvasBounds;
	zIndex?: number;
	/** Vertex count. Must be an integer >= 3; defaults to a pentagon. */
	sides?: number;
	fill?: CanvasFill;
	stroke?: string;
	strokeWidth?: number;
}

export function createPolygon(
	options: CreatePolygonOptions,
): CanvasPolygonNode {
	return {
		id: options.id ?? generateId(),
		...(options.name !== undefined ? { name: options.name } : {}),
		type: "polygon",
		transform: clonePartialTransform(options.transform),
		bounds: options.bounds,
		zIndex: options.zIndex ?? 0,
		sides: options.sides ?? 5,
		...(options.fill !== undefined ? { fill: options.fill } : {}),
		...(options.stroke !== undefined ? { stroke: options.stroke } : {}),
		...(options.strokeWidth !== undefined
			? { strokeWidth: options.strokeWidth }
			: {}),
	};
}

export interface CreateStarOptions {
	id?: string;
	name?: string;
	transform?: Partial<CanvasTransform>;
	bounds: CanvasBounds;
	zIndex?: number;
	/** Number of outer tips. Must be an integer >= 3; defaults to 5. */
	points?: number;
	/** Inner-vertex radius as a fraction of the outer radius; defaults to 0.5. */
	innerRadiusRatio?: number;
	fill?: CanvasFill;
	stroke?: string;
	strokeWidth?: number;
}

export function createStar(options: CreateStarOptions): CanvasStarNode {
	return {
		id: options.id ?? generateId(),
		...(options.name !== undefined ? { name: options.name } : {}),
		type: "star",
		transform: clonePartialTransform(options.transform),
		bounds: options.bounds,
		zIndex: options.zIndex ?? 0,
		points: options.points ?? 5,
		innerRadiusRatio: options.innerRadiusRatio ?? 0.5,
		...(options.fill !== undefined ? { fill: options.fill } : {}),
		...(options.stroke !== undefined ? { stroke: options.stroke } : {}),
		...(options.strokeWidth !== undefined
			? { strokeWidth: options.strokeWidth }
			: {}),
	};
}

export interface CreateLineOptions {
	id?: string;
	name?: string;
	transform?: Partial<CanvasTransform>;
	points: [number, number, number, number];
	stroke?: string;
	strokeWidth?: number;
	zIndex?: number;
	bounds?: CanvasBounds;
}

export function createLine(options: CreateLineOptions): CanvasLineNode {
	const [x1, y1, x2, y2] = options.points;
	const bounds = options.bounds ?? {
		width: Math.abs(x2 - x1),
		height: Math.abs(y2 - y1),
	};
	return {
		id: options.id ?? generateId(),
		...(options.name !== undefined ? { name: options.name } : {}),
		type: "line",
		transform: clonePartialTransform(options.transform),
		bounds,
		zIndex: options.zIndex ?? 0,
		points: options.points,
		stroke: options.stroke ?? "#000000",
		...(options.strokeWidth !== undefined
			? { strokeWidth: options.strokeWidth }
			: {}),
	};
}

export interface CreatePathOptions {
	id?: string;
	name?: string;
	transform?: Partial<CanvasTransform>;
	bounds: CanvasBounds;
	zIndex?: number;
	/** SVG path data. Must be non-empty (matches `CanvasPathNodeSchema`). */
	d: string;
	fill?: CanvasFill;
	stroke?: string;
	strokeWidth?: number;
}

export function createPath(options: CreatePathOptions): CanvasPathNode {
	return {
		id: options.id ?? generateId(),
		...(options.name !== undefined ? { name: options.name } : {}),
		type: "path",
		transform: clonePartialTransform(options.transform),
		bounds: options.bounds,
		zIndex: options.zIndex ?? 0,
		d: options.d,
		...(options.fill !== undefined ? { fill: options.fill } : {}),
		...(options.stroke !== undefined ? { stroke: options.stroke } : {}),
		...(options.strokeWidth !== undefined
			? { strokeWidth: options.strokeWidth }
			: {}),
	};
}

export interface CreateTextOptions {
	id?: string;
	name?: string;
	transform?: Partial<CanvasTransform>;
	bounds: CanvasBounds;
	zIndex?: number;
	text: string;
	fontFamily?: CanvasFontFamily;
	fontSize?: number;
	fontWeight?: string;
	fill?: CanvasFill;
	align?: CanvasTextAlign;
}

export function createText(options: CreateTextOptions): CanvasTextNode {
	return {
		id: options.id ?? generateId(),
		...(options.name !== undefined ? { name: options.name } : {}),
		type: "text",
		transform: clonePartialTransform(options.transform),
		bounds: options.bounds,
		zIndex: options.zIndex ?? 0,
		text: options.text,
		fontFamily: options.fontFamily ?? "Inter",
		fontSize: options.fontSize ?? 16,
		...(options.fontWeight !== undefined
			? { fontWeight: options.fontWeight }
			: {}),
		fill: options.fill ?? "#000000",
		...(options.align !== undefined ? { align: options.align } : {}),
	};
}

export interface CreateRichTextOptions {
	id?: string;
	name?: string;
	transform?: Partial<CanvasTransform>;
	/** The node's geometric box (hit-testing, snapping, group extents). */
	bounds: CanvasBounds;
	zIndex?: number;
	/** The wrap width. Defaults to `bounds.width` — the overwhelmingly common case. */
	width?: number;
	height?: number;
	paragraphs?: RichTextParagraph[];
	overflow?: RichTextOverflow;
	wrap?: RichTextWrap;
}

/**
 * A rich-text block. `width` defaults to `bounds.width`, so the two agree unless
 * a caller deliberately separates them — see {@link CanvasRichTextNode} for why
 * both exist.
 *
 * `paragraphs` defaults to a single empty paragraph rather than `[]`: an empty
 * array has no caret position, so an editor would have to special-case it before
 * the user can type. One empty paragraph is the natural "empty text block".
 */
export function createRichText(
	options: CreateRichTextOptions,
): CanvasRichTextNode {
	return {
		id: options.id ?? generateId(),
		...(options.name !== undefined ? { name: options.name } : {}),
		type: "rich-text",
		transform: clonePartialTransform(options.transform),
		bounds: options.bounds,
		zIndex: options.zIndex ?? 0,
		width: options.width ?? options.bounds.width,
		...(options.height !== undefined ? { height: options.height } : {}),
		paragraphs: options.paragraphs ?? [{ spans: [] }],
		...(options.overflow !== undefined ? { overflow: options.overflow } : {}),
		...(options.wrap !== undefined ? { wrap: options.wrap } : {}),
	};
}

export interface CreateImageOptions {
	id?: string;
	name?: string;
	transform?: Partial<CanvasTransform>;
	bounds: CanvasBounds;
	zIndex?: number;
	assetId: string;
	crop?: CanvasImageCrop;
	filters?: ImageFilter[];
	adjustments?: CanvasImageAdjustments;
	maskAssetId?: string;
	assetToken?: BrandTokenRef;
}

export function createImage(options: CreateImageOptions): CanvasImageNode {
	return {
		id: options.id ?? generateId(),
		...(options.name !== undefined ? { name: options.name } : {}),
		type: "image",
		transform: clonePartialTransform(options.transform),
		bounds: options.bounds,
		zIndex: options.zIndex ?? 0,
		assetId: options.assetId,
		...(options.crop !== undefined ? { crop: options.crop } : {}),
		...(options.filters !== undefined ? { filters: options.filters } : {}),
		...(options.adjustments !== undefined
			? { adjustments: options.adjustments }
			: {}),
		...(options.maskAssetId !== undefined
			? { maskAssetId: options.maskAssetId }
			: {}),
		...(options.assetToken !== undefined
			? { assetToken: options.assetToken }
			: {}),
	};
}

export interface CreateSvgOptions {
	id?: string;
	name?: string;
	transform?: Partial<CanvasTransform>;
	bounds: CanvasBounds;
	zIndex?: number;
	assetId: string;
}

/** FR-016 — asset-reference only. There is no options field for inline markup. */
export function createSvg(options: CreateSvgOptions): CanvasSvgNode {
	return {
		id: options.id ?? generateId(),
		...(options.name !== undefined ? { name: options.name } : {}),
		type: "svg",
		transform: clonePartialTransform(options.transform),
		bounds: options.bounds,
		zIndex: options.zIndex ?? 0,
		assetId: options.assetId,
	};
}

interface CreateMediaOptions {
	id?: string;
	name?: string;
	transform?: Partial<CanvasTransform>;
	bounds: CanvasBounds;
	zIndex?: number;
	assetId: string;
	trim?: CanvasMediaTrim;
	muted?: boolean;
	volume?: number;
}

export interface CreateVideoOptions extends CreateMediaOptions {
	poster?: string;
}

export type CreateAudioOptions = CreateMediaOptions;

/** FR-081 — asset-reference only. No playback/rendering is implemented in canvas-core. */
export function createVideo(options: CreateVideoOptions): CanvasVideoNode {
	return {
		id: options.id ?? generateId(),
		...(options.name !== undefined ? { name: options.name } : {}),
		type: "video",
		transform: clonePartialTransform(options.transform),
		bounds: options.bounds,
		zIndex: options.zIndex ?? 0,
		assetId: options.assetId,
		...(options.trim !== undefined ? { trim: options.trim } : {}),
		...(options.muted !== undefined ? { muted: options.muted } : {}),
		...(options.volume !== undefined ? { volume: options.volume } : {}),
		...(options.poster !== undefined ? { poster: options.poster } : {}),
	};
}

/** FR-081 — asset-reference only. No playback/rendering is implemented in canvas-core. */
export function createAudio(options: CreateAudioOptions): CanvasAudioNode {
	return {
		id: options.id ?? generateId(),
		...(options.name !== undefined ? { name: options.name } : {}),
		type: "audio",
		transform: clonePartialTransform(options.transform),
		bounds: options.bounds,
		zIndex: options.zIndex ?? 0,
		assetId: options.assetId,
		...(options.trim !== undefined ? { trim: options.trim } : {}),
		...(options.muted !== undefined ? { muted: options.muted } : {}),
		...(options.volume !== undefined ? { volume: options.volume } : {}),
	};
}
