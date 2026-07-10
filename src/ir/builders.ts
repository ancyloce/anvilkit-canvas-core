import { nowIso } from "../clock.js";
import type {
	CanvasBounds,
	CanvasEllipseNode,
	CanvasGroupNode,
	CanvasImageCrop,
	CanvasImageNode,
	CanvasIR,
	CanvasLineNode,
	CanvasNode,
	CanvasPage,
	CanvasPageBackground,
	CanvasPageSize,
	CanvasPathNode,
	CanvasRectNode,
	CanvasTextAlign,
	CanvasTextNode,
	CanvasTransform,
	ImageFilter,
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

export interface CreateRectOptions {
	id?: string;
	name?: string;
	transform?: Partial<CanvasTransform>;
	bounds: CanvasBounds;
	zIndex?: number;
	fill?: string;
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
	fill?: string;
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
	fill?: string;
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
	fontFamily?: string;
	fontSize?: number;
	fontWeight?: string;
	fill?: string;
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

export interface CreateImageOptions {
	id?: string;
	name?: string;
	transform?: Partial<CanvasTransform>;
	bounds: CanvasBounds;
	zIndex?: number;
	assetId: string;
	crop?: CanvasImageCrop;
	filters?: ImageFilter[];
	maskAssetId?: string;
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
		...(options.maskAssetId !== undefined
			? { maskAssetId: options.maskAssetId }
			: {}),
	};
}
