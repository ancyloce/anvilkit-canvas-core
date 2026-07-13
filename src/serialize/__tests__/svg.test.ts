import { describe, expect, it } from "vitest";
import { toAffineMatrix } from "../../geometry/affine.js";
import type {
	BrandTokenRef,
	CanvasAssetRef,
	CanvasEllipseNode,
	CanvasGroupNode,
	CanvasImageNode,
	CanvasIR,
	CanvasLineNode,
	CanvasNode,
	CanvasPageBackground,
	CanvasPageSize,
	CanvasPathNode,
	CanvasPolygonNode,
	CanvasRectNode,
	CanvasRichTextNode,
	CanvasStarNode,
	CanvasSvgNode,
	CanvasTextNode,
	CanvasTransform,
} from "../../ir/types.js";
import { CanvasIRDepthError, MAX_TREE_DEPTH } from "../../ir/walkers.js";
import type {
	CanvasTextMeasurer,
	MeasuredLine,
	MeasuredRun,
	TextMeasureRequest,
} from "../../text-contracts.js";
import {
	bytesToBase64,
	createEmitContext,
	emitEllipse,
	emitLine,
	emitPath,
	emitPolygon,
	emitRect,
	emitRichText,
	emitStar,
	emitText,
	escapeAttr,
	escapeCssString,
	escapeCssUrl,
	escapeXml,
	isSafeDataImageUrl,
	isValidPathD,
	normalizeUri,
	sanitizeId,
	serializePageToSvg,
	shouldSkipNode,
	transformAttr,
	unitToPx,
} from "../svg.js";

const identity: CanvasTransform = {
	x: 0,
	y: 0,
	rotation: 0,
	scaleX: 1,
	scaleY: 1,
};

describe("escapeXml", () => {
	it("escapes the three XML text-content metacharacters", () => {
		expect(escapeXml("a < b & c > d")).toBe("a &lt; b &amp; c &gt; d");
	});

	it("escapes ampersands before angle brackets (no double-escaping)", () => {
		expect(escapeXml("&lt;")).toBe("&amp;lt;");
	});
});

describe("escapeAttr", () => {
	it("escapes quotes and apostrophes in addition to XML metachars", () => {
		expect(escapeAttr(`"x"&<'`)).toBe("&quot;x&quot;&amp;&lt;&#39;");
	});
});

describe("escapeCssString", () => {
	it("strips characters that could break out of a <style> block", () => {
		expect(escapeCssString('Inter"</style><script>')).toBe("Inter/stylescript");
	});
});

describe("escapeCssUrl", () => {
	it("strips the CSS rule/declaration breakout characters { } ;", () => {
		expect(escapeCssUrl("url(x); } * { background: url(//evil) }")).toBe(
			"url(x)  *  background: url(//evil) ",
		);
		expect(escapeCssUrl("a{b}c;d")).toBe("abcd");
	});

	it("strips <, > and newlines but preserves url()/format() quotes", () => {
		expect(escapeCssUrl('url("a.woff2") format("woff2")')).toBe(
			'url("a.woff2") format("woff2")',
		);
		expect(escapeCssUrl("url(x)<svg>\n")).toBe("url(x)svg");
	});
});

describe("normalizeUri", () => {
	it("blocks dangerous schemes regardless of case", () => {
		expect(normalizeUri("javascript:alert(1)")).toBeUndefined();
		expect(normalizeUri("JavaScript:alert(1)")).toBeUndefined();
		expect(normalizeUri("vbscript:msgbox")).toBeUndefined();
		expect(normalizeUri("file:///etc/passwd")).toBeUndefined();
		expect(normalizeUri("blob:https://x/y")).toBeUndefined();
		expect(normalizeUri("filesystem:https://x")).toBeUndefined();
	});

	it("allows http(s), relative, and protocol-relative URLs", () => {
		expect(normalizeUri("https://cdn.example.com/a.png")).toBe(
			"https://cdn.example.com/a.png",
		);
		expect(normalizeUri("/assets/a.png")).toBe("/assets/a.png");
		expect(normalizeUri("./img/a.png")).toBe("./img/a.png");
		expect(normalizeUri("//cdn.example.com/a.png")).toBe(
			"//cdn.example.com/a.png",
		);
	});

	it("allowlist: rejects non-http(s) schemes beyond the legacy blocklist", () => {
		expect(normalizeUri("ftp://host/a.png")).toBeUndefined();
		expect(normalizeUri("mailto:a@b.com")).toBeUndefined();
		expect(normalizeUri("custom-scheme://x")).toBeUndefined();
		expect(normalizeUri("ws://host")).toBeUndefined();
	});

	it("only allows safe data:image URIs when opted in", () => {
		const png = "data:image/png;base64,AAAA";
		expect(normalizeUri(png)).toBeUndefined();
		expect(normalizeUri(png, { allowSafeDataImage: true })).toBe(png);
		expect(
			normalizeUri("data:text/html,<script>", { allowSafeDataImage: true }),
		).toBeUndefined();
	});

	it("returns undefined for empty input", () => {
		expect(normalizeUri("   ")).toBeUndefined();
	});
});

describe("isSafeDataImageUrl", () => {
	it("accepts raster image data URIs", () => {
		expect(isSafeDataImageUrl("data:image/png;base64,AAAA")).toBe(true);
		expect(isSafeDataImageUrl("data:image/jpeg;base64,AAAA")).toBe(true);
		expect(isSafeDataImageUrl("data:image/webp;base64,AAAA")).toBe(true);
	});

	it("rejects svg+xml and non-image data URIs", () => {
		expect(isSafeDataImageUrl("data:image/svg+xml,<svg/>")).toBe(false);
		expect(isSafeDataImageUrl("data:text/html,x")).toBe(false);
	});
});

describe("bytesToBase64", () => {
	it("encodes a known byte vector", () => {
		expect(bytesToBase64(new Uint8Array([72, 105]))).toBe("SGk=");
	});

	it("encodes an empty buffer to an empty string", () => {
		expect(bytesToBase64(new Uint8Array([]))).toBe("");
	});
});

describe("sanitizeId", () => {
	it("replaces unsafe characters with underscores", () => {
		expect(sanitizeId("a b#c")).toBe("a_b_c");
		expect(sanitizeId("ok-id_1")).toBe("ok-id_1");
	});

	it("falls back to a placeholder for empty input", () => {
		expect(sanitizeId("")).toBe("id");
	});
});

describe("isValidPathD", () => {
	it("accepts well-formed path data", () => {
		expect(isValidPathD("M0 0 L10 10 C1 1 2 2 3 3 Z")).toBe(true);
		expect(isValidPathD("M1.5e2 -3 L+4,5")).toBe(true);
	});

	it("rejects injection attempts", () => {
		expect(isValidPathD('M0 0"/><script>alert(1)</script>')).toBe(false);
	});
});

describe("unitToPx", () => {
	it("passes px through unchanged", () => {
		expect(unitToPx(120, "px")).toBe(120);
	});

	it("converts inches and millimeters at 96 dpi by default", () => {
		expect(unitToPx(1, "in")).toBe(96);
		expect(unitToPx(25.4, "mm")).toBeCloseTo(96, 6);
	});

	it("honors an explicit dpi", () => {
		expect(unitToPx(1, "in", 300)).toBe(300);
	});
});

describe("transformAttr", () => {
	it("omits an identity transform", () => {
		expect(transformAttr(identity)).toBe("");
	});

	it("emits a readable decomposition without skew", () => {
		expect(transformAttr({ ...identity, x: 10, y: 20 })).toBe(
			"translate(10 20)",
		);
		expect(transformAttr({ ...identity, rotation: 45 })).toBe("rotate(45)");
		expect(transformAttr({ ...identity, scaleX: 2, scaleY: 3 })).toBe(
			"scale(2 3)",
		);
		expect(
			transformAttr({ ...identity, x: 5, rotation: 90, scaleX: 2, scaleY: 2 }),
		).toBe("translate(5 0) rotate(90) scale(2 2)");
	});

	it("emits a composed matrix when skew is present", () => {
		expect(transformAttr({ ...identity, skewX: 1 })).toBe(
			"matrix(1 0 1 1 0 0)",
		);
	});
});

describe("toAffineMatrix", () => {
	it("returns the identity matrix for an identity transform", () => {
		expect(toAffineMatrix(identity)).toEqual([1, 0, 0, 1, 0, 0]);
	});

	it("composes translate then scale in Konva order", () => {
		expect(
			toAffineMatrix({ ...identity, x: 10, y: 20, scaleX: 2, scaleY: 3 }),
		).toEqual([2, 0, 0, 3, 10, 20]);
	});
});

const rect: CanvasRectNode = {
	id: "r1",
	type: "rect",
	transform: identity,
	bounds: { width: 100, height: 50 },
	zIndex: 0,
	fill: "#f00",
	stroke: "#000",
	strokeWidth: 2,
	radius: 8,
};

describe("emitRect", () => {
	it("emits geometry, radius, fill and stroke", () => {
		expect(emitRect(rect, createEmitContext())).toBe(
			'<rect width="100" height="50" rx="8" ry="8" fill="#f00" stroke="#000" stroke-width="2" />',
		);
	});

	it("omits rx/ry when radius is absent or zero", () => {
		expect(emitRect({ ...rect, radius: 0 }, createEmitContext())).not.toContain(
			"rx=",
		);
	});

	it("emits fill=none for an unfilled shape", () => {
		const bare: CanvasRectNode = {
			id: "r2",
			type: "rect",
			transform: identity,
			bounds: { width: 10, height: 10 },
			zIndex: 0,
		};
		expect(emitRect(bare, createEmitContext())).toContain('fill="none"');
	});

	it("emits transform, opacity and blend-mode common attributes", () => {
		const out = emitRect(
			{
				...rect,
				radius: 0,
				transform: { ...identity, x: 10, y: 20 },
				opacity: 0.5,
				blendMode: "multiply",
			},
			createEmitContext(),
		);
		expect(out).toContain('transform="translate(10 20)"');
		expect(out).toContain('opacity="0.5"');
		expect(out).toContain('style="mix-blend-mode:multiply"');
	});

	it("warns on an unsupported blend mode", () => {
		const ctx = createEmitContext();
		emitRect({ ...rect, blendMode: "frobnicate" }, ctx);
		expect(ctx.warnings.map((w) => w.code)).toContain("BLENDMODE_UNSUPPORTED");
	});
});

describe("emitEllipse", () => {
	it("centers the ellipse at half its bounds", () => {
		const ellipse: CanvasEllipseNode = {
			id: "e1",
			type: "ellipse",
			transform: identity,
			bounds: { width: 80, height: 40 },
			zIndex: 0,
			fill: "#0f0",
		};
		expect(emitEllipse(ellipse, createEmitContext())).toBe(
			'<ellipse cx="40" cy="20" rx="40" ry="20" fill="#0f0" />',
		);
	});
});

describe("emitPolygon", () => {
	it("emits a <polygon> with one point per side, plus fill/stroke", () => {
		const polygon: CanvasPolygonNode = {
			id: "poly1",
			type: "polygon",
			transform: identity,
			bounds: { width: 100, height: 100 },
			zIndex: 0,
			sides: 4,
			fill: "#f00",
			stroke: "#000",
			strokeWidth: 2,
		};
		const out = emitPolygon(polygon, createEmitContext());
		expect(out).toBe(
			'<polygon points="50,0 100,50 50,100 0,50" fill="#f00" stroke="#000" stroke-width="2" />',
		);
	});

	it("emits fill=none for an unfilled polygon", () => {
		const bare: CanvasPolygonNode = {
			id: "poly2",
			type: "polygon",
			transform: identity,
			bounds: { width: 10, height: 10 },
			zIndex: 0,
			sides: 3,
		};
		expect(emitPolygon(bare, createEmitContext())).toContain('fill="none"');
	});
});

describe("emitStar", () => {
	it("emits a <polygon> with 2 * points, alternating outer/inner vertices", () => {
		const star: CanvasStarNode = {
			id: "star1",
			type: "star",
			transform: identity,
			bounds: { width: 100, height: 100 },
			zIndex: 0,
			points: 4,
			innerRadiusRatio: 0.5,
			fill: "#00f",
		};
		const out = emitStar(star, createEmitContext());
		expect(out.startsWith('<polygon points="')).toBe(true);
		const pointsMatch = out.match(/points="([^"]*)"/);
		const points = pointsMatch?.[1]?.split(" ") ?? [];
		expect(points).toHaveLength(8);
		expect(out).toContain('fill="#00f"');
	});

	it("emits fill=none for an unfilled star", () => {
		const bare: CanvasStarNode = {
			id: "star2",
			type: "star",
			transform: identity,
			bounds: { width: 10, height: 10 },
			zIndex: 0,
			points: 5,
			innerRadiusRatio: 0.5,
		};
		expect(emitStar(bare, createEmitContext())).toContain('fill="none"');
	});
});

describe("brand-token resolution", () => {
	const colorToken: BrandTokenRef = {
		type: "brand-token",
		tokenType: "color",
		id: "brand.accent",
	};
	const fontToken: BrandTokenRef = {
		type: "brand-token",
		tokenType: "font",
		id: "brand.heading-font",
	};

	it("resolves a token fill via resolveBrandToken", () => {
		const ctx = createEmitContext({
			resolveBrandToken: (ref) =>
				ref.id === "brand.accent" ? "#123456" : undefined,
		});
		const out = emitRect({ ...rect, fill: colorToken }, ctx);
		expect(out).toContain('fill="#123456"');
		expect(ctx.warnings).toEqual([]);
	});

	it("a resolver can resolve a token fill to a gradient", () => {
		const ctx = createEmitContext({
			resolveBrandToken: () => ({
				kind: "linear",
				stops: [
					{ offset: 0, color: "#000" },
					{ offset: 1, color: "#fff" },
				],
				from: { x: 0, y: 0 },
				to: { x: 1, y: 1 },
			}),
		});
		const out = emitRect({ ...rect, fill: colorToken }, ctx);
		expect(out).toContain("<linearGradient");
		expect(out).toContain('fill="url(#grad-r1)"');
	});

	it("degrades a token fill to fill=none + BRAND_TOKEN_UNRESOLVED when no resolver is supplied", () => {
		const ctx = createEmitContext();
		const out = emitRect({ ...rect, fill: colorToken }, ctx);
		expect(out).toContain('fill="none"');
		expect(ctx.warnings).toEqual([
			{
				code: "BRAND_TOKEN_UNRESOLVED",
				message: expect.stringContaining("brand.accent"),
				nodeId: "r1",
			},
		]);
	});

	it("degrades a token fill to fill=none + warns when the resolver returns undefined", () => {
		const ctx = createEmitContext({ resolveBrandToken: () => undefined });
		const out = emitRect({ ...rect, fill: colorToken }, ctx);
		expect(out).toContain('fill="none"');
		expect(ctx.warnings.map((w) => w.code)).toEqual(["BRAND_TOKEN_UNRESOLVED"]);
	});

	it("never throws for an unresolved token — the node still emits", () => {
		expect(() =>
			emitRect({ ...rect, fill: colorToken }, createEmitContext()),
		).not.toThrow();
	});

	it("resolves a token fontFamily on a plain text node", () => {
		const text: CanvasTextNode = {
			id: "t1",
			type: "text",
			transform: identity,
			bounds: { width: 100, height: 20 },
			zIndex: 0,
			text: "hi",
			fontFamily: fontToken,
			fontSize: 16,
			fill: "#000",
		};
		const ctx = createEmitContext({
			resolveBrandToken: () => "Georgia",
		});
		const out = emitText(text, ctx);
		expect(out).toContain('font-family="Georgia"');
		expect(ctx.usedFonts.has("Georgia")).toBe(true);
	});

	it("omits font-family + warns for an unresolved token fontFamily", () => {
		const text: CanvasTextNode = {
			id: "t1",
			type: "text",
			transform: identity,
			bounds: { width: 100, height: 20 },
			zIndex: 0,
			text: "hi",
			fontFamily: fontToken,
			fontSize: 16,
			fill: "#000",
		};
		const ctx = createEmitContext();
		const out = emitText(text, ctx);
		expect(out).not.toContain("font-family=");
		expect(ctx.warnings.map((w) => w.code)).toEqual(["BRAND_TOKEN_UNRESOLVED"]);
		expect(ctx.usedFonts.size).toBe(0);
	});

	it("resolves a rich-text span's token fill and fontFamily", () => {
		const richText: CanvasRichTextNode = {
			id: "rt1",
			type: "rich-text",
			transform: identity,
			bounds: { width: 200, height: 60 },
			zIndex: 0,
			width: 200,
			paragraphs: [
				{ spans: [{ text: "hi", fill: colorToken, fontFamily: fontToken }] },
			],
		};
		const ctx = createEmitContext({
			resolveBrandToken: (ref) =>
				ref.tokenType === "font" ? "Georgia" : "#ff00ff",
		});
		const out = emitRichText(richText, ctx);
		expect(out).toContain('fill="#ff00ff"');
		expect(out).toContain('font-family="Georgia"');
		// RICH_TEXT_WRAP_APPROXIMATE is pre-existing/unrelated — no measurer was
		// supplied. The point here is no BRAND_TOKEN_UNRESOLVED: both tokens resolved.
		expect(ctx.warnings.map((w) => w.code)).not.toContain(
			"BRAND_TOKEN_UNRESOLVED",
		);
	});

	it("warns once per unresolved span, not twice, for the usedFonts pre-scan", () => {
		const richText: CanvasRichTextNode = {
			id: "rt1",
			type: "rich-text",
			transform: identity,
			bounds: { width: 200, height: 60 },
			zIndex: 0,
			width: 200,
			paragraphs: [{ spans: [{ text: "hi", fontFamily: fontToken }] }],
		};
		const ctx = createEmitContext();
		emitRichText(richText, ctx);
		expect(
			ctx.warnings.filter((w) => w.code === "BRAND_TOKEN_UNRESOLVED"),
		).toHaveLength(1);
	});
});

describe("emitLine", () => {
	it("emits endpoints and stroke from points", () => {
		const line: CanvasLineNode = {
			id: "l1",
			type: "line",
			transform: identity,
			bounds: { width: 0, height: 0 },
			zIndex: 0,
			points: [0, 0, 10, 10],
			stroke: "#000",
			strokeWidth: 3,
		};
		expect(emitLine(line, createEmitContext())).toBe(
			'<line x1="0" y1="0" x2="10" y2="10" stroke="#000" stroke-width="3" />',
		);
	});
});

const path: CanvasPathNode = {
	id: "p1",
	type: "path",
	transform: identity,
	bounds: { width: 0, height: 0 },
	zIndex: 0,
	d: "M0 0 L10 10 Z",
	fill: "#00f",
};

describe("emitPath", () => {
	it("emits valid path data", () => {
		expect(emitPath(path, createEmitContext())).toBe(
			'<path d="M0 0 L10 10 Z" fill="#00f" />',
		);
	});

	it("skips and warns on injection in path data", () => {
		const ctx = createEmitContext();
		expect(emitPath({ ...path, d: 'M0 0"/><script>' }, ctx)).toBe("");
		expect(ctx.warnings.map((w) => w.code)).toContain("PATH_INVALID_D");
	});
});

const text: CanvasTextNode = {
	id: "t1",
	type: "text",
	transform: identity,
	bounds: { width: 200, height: 40 },
	zIndex: 0,
	text: "Hi",
	fontFamily: "Inter",
	fontSize: 24,
	fill: "#111",
};

describe("emitText", () => {
	it("emits a left-anchored baseline-offset <text> and records the font", () => {
		const ctx = createEmitContext();
		expect(emitText(text, ctx)).toBe(
			'<text x="0" y="19.2" font-family="Inter" font-size="24" fill="#111">Hi</text>',
		);
		expect(ctx.usedFonts.has("Inter")).toBe(true);
	});

	it("maps align to text-anchor and x offset", () => {
		const centered = emitText(
			{ ...text, align: "center" },
			createEmitContext(),
		);
		expect(centered).toContain('text-anchor="middle"');
		expect(centered).toContain('x="100"');

		const right = emitText({ ...text, align: "right" }, createEmitContext());
		expect(right).toContain('text-anchor="end"');
		expect(right).toContain('x="200"');
	});

	it("escapes text content", () => {
		expect(
			emitText({ ...text, text: "a < b & c" }, createEmitContext()),
		).toContain(">a &lt; b &amp; c<");
	});

	it("emits tspans and warns for multi-line text", () => {
		const ctx = createEmitContext();
		const out = emitText({ ...text, text: "line1\nline2" }, ctx);
		expect(out).toContain("<tspan");
		expect(ctx.warnings.map((w) => w.code)).toContain("TEXT_NO_WRAP");
	});
});

describe("shouldSkipNode", () => {
	it("skips hidden nodes only when skipInvisible is set", () => {
		expect(shouldSkipNode({ ...rect, visible: false }, true)).toBe(true);
		expect(shouldSkipNode({ ...rect, visible: false }, false)).toBe(false);
		expect(shouldSkipNode(rect, true)).toBe(false);
	});
});

function group(children: CanvasNode[]): CanvasGroupNode {
	return {
		id: "root",
		type: "group",
		transform: identity,
		bounds: { width: 0, height: 0 },
		zIndex: 0,
		children,
	};
}

function makeIR(
	root: CanvasGroupNode,
	opts: {
		size?: Partial<CanvasPageSize>;
		background?: CanvasPageBackground;
		assets?: Record<string, CanvasAssetRef>;
	} = {},
): CanvasIR {
	return {
		version: "2",
		id: "ir-1",
		title: "Fixture",
		pages: [
			{
				id: "page-1",
				size: {
					width: opts.size?.width ?? 100,
					height: opts.size?.height ?? 100,
					unit: opts.size?.unit ?? "px",
					...(opts.size?.dpi ? { dpi: opts.size.dpi } : {}),
				},
				background: opts.background ?? { kind: "solid", value: "#fff" },
				root,
			},
		],
		assets: opts.assets ?? {},
		metadata: { createdAt: "t0", updatedAt: "t0" },
	};
}

function imageNode(
	assetId: string,
	over: Partial<CanvasImageNode> = {},
): CanvasImageNode {
	return {
		id: "img1",
		type: "image",
		transform: identity,
		bounds: { width: 50, height: 40 },
		zIndex: 0,
		assetId,
		...over,
	};
}

describe("serializePageToSvg", () => {
	it("emits a well-formed svg with a viewBox and solid background", async () => {
		const { svg } = await serializePageToSvg(makeIR(group([])), 0);
		expect(svg.startsWith('<svg xmlns="http://www.w3.org/2000/svg"')).toBe(
			true,
		);
		expect(svg).toContain('viewBox="0 0 100 100"');
		expect(svg).toContain(
			'<rect x="0" y="0" width="100" height="100" fill="#fff" />',
		);
		expect(svg.endsWith("</svg>")).toBe(true);
	});

	it("selects a page by id and rejects unknown selectors", async () => {
		const ir = makeIR(group([]));
		await expect(serializePageToSvg(ir, "page-1")).resolves.toBeDefined();
		await expect(serializePageToSvg(ir, "nope")).rejects.toThrow(
			/not be found|not found/i,
		);
		await expect(serializePageToSvg(ir, 5)).rejects.toThrow(/out of range/i);
	});

	it("converts non-px page units to the viewBox in px", async () => {
		const { svg } = await serializePageToSvg(
			makeIR(group([]), { size: { width: 25.4, height: 25.4, unit: "mm" } }),
			0,
		);
		expect(svg).toContain('viewBox="0 0 96 96"');
	});

	it("wraps a nested group in a <g> containing its children", async () => {
		const child: CanvasRectNode = {
			id: "c1",
			type: "rect",
			transform: identity,
			bounds: { width: 10, height: 10 },
			zIndex: 0,
			fill: "#000",
		};
		const nested: CanvasGroupNode = {
			id: "g1",
			type: "group",
			transform: { ...identity, x: 5, y: 5 },
			bounds: { width: 0, height: 0 },
			zIndex: 0,
			children: [child],
		};
		const { svg } = await serializePageToSvg(makeIR(group([nested])), 0);
		expect(svg).toContain('<g transform="translate(5 5)">');
		expect(svg).toContain('<rect width="10" height="10"');
		expect(svg).toContain("</g>");
	});

	it("warns for an unsupported background kind", async () => {
		const { warnings } = await serializePageToSvg(
			makeIR(group([]), {
				background: { kind: "gradient", value: "linear-gradient(#fff,#000)" },
			}),
			0,
		);
		expect(warnings.map((w) => w.code)).toContain("BACKGROUND_UNSUPPORTED");
	});

	it("skips hidden nodes and ai-placeholder nodes with a warning", async () => {
		const hidden: CanvasRectNode = {
			id: "h1",
			type: "rect",
			transform: identity,
			bounds: { width: 10, height: 10 },
			zIndex: 0,
			fill: "#000",
			visible: false,
		};
		const placeholder: CanvasNode = {
			id: "ai1",
			type: "ai-placeholder",
			transform: identity,
			bounds: { width: 10, height: 10 },
			zIndex: 1,
			jobId: "job-1",
			status: "pending",
		};
		const { svg, warnings } = await serializePageToSvg(
			makeIR(group([hidden, placeholder])),
			0,
		);
		expect(svg).not.toContain('id="h1"');
		expect(svg).not.toContain("<rect width=");
		expect(warnings.map((w) => w.code)).toContain("AI_PLACEHOLDER_SKIPPED");
	});

	it("indents output in pretty mode", async () => {
		const rectNode: CanvasRectNode = {
			id: "r-pretty",
			type: "rect",
			transform: identity,
			bounds: { width: 10, height: 10 },
			zIndex: 0,
			fill: "#000",
		};
		const { svg } = await serializePageToSvg(makeIR(group([rectNode])), 0, {
			pretty: true,
		});
		expect(svg).toContain("\n\t<rect");
	});
});

const remoteAsset: Record<string, CanvasAssetRef> = {
	a1: { id: "a1", uri: "https://cdn.example.com/x.png" },
};

describe("serializePageToSvg images", () => {
	it("references a remote image by default (auto mode)", async () => {
		const { svg } = await serializePageToSvg(
			makeIR(group([imageNode("a1")]), { assets: remoteAsset }),
			0,
		);
		expect(svg).toContain("<image ");
		expect(svg).toContain('href="https://cdn.example.com/x.png"');
		expect(svg).toContain('preserveAspectRatio="none"');
		expect(svg).toContain('width="50" height="40"');
	});

	it("inlines an existing data: URI in auto mode", async () => {
		const { svg } = await serializePageToSvg(
			makeIR(group([imageNode("a1")]), {
				assets: { a1: { id: "a1", uri: "data:image/png;base64,SGk=" } },
			}),
			0,
		);
		expect(svg).toContain('href="data:image/png;base64,SGk="');
	});

	it("embeds a remote image via fetchAsset in embed mode", async () => {
		const fetchAsset = async () => ({
			bytes: new Uint8Array([72, 105]),
			contentType: "image/png",
		});
		const { svg } = await serializePageToSvg(
			makeIR(group([imageNode("a1")]), { assets: remoteAsset }),
			0,
			{ images: "embed", fetchAsset },
		);
		expect(svg).toContain('href="data:image/png;base64,SGk="');
	});

	it("falls back to reference and warns when embed lacks a fetchAsset", async () => {
		const { svg, warnings } = await serializePageToSvg(
			makeIR(group([imageNode("a1")]), { assets: remoteAsset }),
			0,
			{ images: "embed" },
		);
		expect(warnings.map((w) => w.code)).toContain("EMBED_NO_FETCHER");
		expect(svg).toContain('href="https://cdn.example.com/x.png"');
	});

	it("skips and warns on a missing asset", async () => {
		const { svg, warnings } = await serializePageToSvg(
			makeIR(group([imageNode("nope")])),
			0,
		);
		expect(warnings.map((w) => w.code)).toContain("MISSING_ASSET");
		expect(svg).not.toContain("<image");
	});

	it("skips and warns on a blocked URI scheme", async () => {
		const { svg, warnings } = await serializePageToSvg(
			makeIR(group([imageNode("a1")]), {
				assets: { a1: { id: "a1", uri: "javascript:alert(1)" } },
			}),
			0,
		);
		expect(warnings.map((w) => w.code)).toContain("UNSAFE_URI");
		expect(svg).not.toContain("<image");
	});

	it("emits a clipPath for a cropped image", async () => {
		const { svg } = await serializePageToSvg(
			makeIR(
				group([
					imageNode("a1", { crop: { x: 5, y: 5, width: 20, height: 20 } }),
				]),
				{
					assets: remoteAsset,
				},
			),
			0,
		);
		expect(svg).toContain('<clipPath id="crop-img1">');
		expect(svg).toContain('clip-path="url(#crop-img1)"');
	});

	it("warns for unsupported masks and filters", async () => {
		const { warnings } = await serializePageToSvg(
			makeIR(
				group([
					imageNode("a1", { maskAssetId: "m1", filters: [{ kind: "blur" }] }),
				]),
				{ assets: remoteAsset },
			),
			0,
		);
		const codes = warnings.map((w) => w.code);
		expect(codes).toContain("IMAGE_MASK_UNSUPPORTED");
		expect(codes).toContain("IMAGE_FILTERS_UNSUPPORTED");
	});
});

function svgNode(
	assetId: string,
	over: Partial<CanvasSvgNode> = {},
): CanvasSvgNode {
	return {
		id: "svg1",
		type: "svg",
		transform: identity,
		bounds: { width: 50, height: 40 },
		zIndex: 0,
		assetId,
		...over,
	};
}

describe("serializePageToSvg svg nodes", () => {
	it("references a remote svg asset via the same safe <image> path as image nodes", async () => {
		const { svg } = await serializePageToSvg(
			makeIR(group([svgNode("a1")]), { assets: remoteAsset }),
			0,
		);
		expect(svg).toContain("<image ");
		expect(svg).toContain('href="https://cdn.example.com/x.png"');
		expect(svg).toContain('width="50" height="40"');
	});

	it("always warns SVG_INLINE_UNSUPPORTED, even when the asset resolves cleanly", async () => {
		const { warnings } = await serializePageToSvg(
			makeIR(group([svgNode("a1")]), { assets: remoteAsset }),
			0,
		);
		expect(warnings.map((w) => w.code)).toContain("SVG_INLINE_UNSUPPORTED");
	});

	it("embeds a remote svg asset via fetchAsset in embed mode", async () => {
		const fetchAsset = async () => ({
			bytes: new Uint8Array([72, 105]),
			contentType: "image/svg+xml",
		});
		const { svg } = await serializePageToSvg(
			makeIR(group([svgNode("a1")]), { assets: remoteAsset }),
			0,
			{ images: "embed", fetchAsset },
		);
		expect(svg).toContain('href="data:image/svg+xml;base64,SGk="');
	});

	it("skips and warns on a missing asset", async () => {
		const { svg, warnings } = await serializePageToSvg(
			makeIR(group([svgNode("nope")])),
			0,
		);
		const codes = warnings.map((w) => w.code);
		expect(codes).toContain("MISSING_ASSET");
		expect(codes).toContain("SVG_INLINE_UNSUPPORTED");
		expect(svg).not.toContain("<image");
	});

	it("skips and warns on a blocked URI scheme", async () => {
		const { svg, warnings } = await serializePageToSvg(
			makeIR(group([svgNode("a1")]), {
				assets: { a1: { id: "a1", uri: "javascript:alert(1)" } },
			}),
			0,
		);
		expect(warnings.map((w) => w.code)).toContain("UNSAFE_URI");
		expect(svg).not.toContain("<image");
	});
});

describe("serializePageToSvg fonts", () => {
	it("emits @font-face for used fonts present in the manifest", async () => {
		const { svg } = await serializePageToSvg(makeIR(group([text])), 0, {
			fonts: [
				{ family: "Inter", src: 'url(/fonts/inter.woff2) format("woff2")' },
			],
		});
		expect(svg).toContain("<defs><style>");
		expect(svg).toContain("@font-face{");
		expect(svg).toContain('font-family:"Inter"');
		expect(svg).toContain('src:url(/fonts/inter.woff2) format("woff2")');
	});

	it("warns for a used font absent from the manifest", async () => {
		const { svg, warnings } = await serializePageToSvg(
			makeIR(group([text])),
			0,
		);
		expect(warnings.map((w) => w.code)).toContain("FONT_NOT_IN_MANIFEST");
		expect(svg).not.toContain("@font-face");
	});

	it("cannot be broken out of with a hostile @font-face src", async () => {
		const { svg } = await serializePageToSvg(makeIR(group([text])), 0, {
			fonts: [
				{ family: "Inter", src: "url(x); } body { background: url(//evil) }" },
			],
		});
		// The injected `}`/`;` are stripped, so no extra rule escapes the @font-face.
		expect(svg).not.toContain("} body {");
		expect(svg).toContain("@font-face{");
	});
});

describe("serializePageToSvg robustness", () => {
	function deepChain(levels: number): CanvasGroupNode {
		let node: CanvasGroupNode = {
			id: "leaf",
			type: "group",
			transform: identity,
			bounds: { width: 0, height: 0 },
			zIndex: 0,
			children: [],
		};
		for (let i = levels; i >= 0; i--) {
			node = {
				id: `g-${i}`,
				type: "group",
				transform: identity,
				bounds: { width: 0, height: 0 },
				zIndex: 0,
				children: [node],
			};
		}
		return node;
	}

	it("throws CanvasIRDepthError on a tree past MAX_TREE_DEPTH (no stack overflow)", async () => {
		const ir = makeIR(group([deepChain(MAX_TREE_DEPTH + 2)]));
		await expect(serializePageToSvg(ir, 0)).rejects.toBeInstanceOf(
			CanvasIRDepthError,
		);
	});

	it("validate:true rejects a non-finite IR; default coerces it to 0", async () => {
		const badRect: CanvasRectNode = {
			id: "r-nan",
			type: "rect",
			transform: { ...identity, x: Number.NaN },
			bounds: { width: 10, height: 10 },
			zIndex: 0,
			fill: "#000",
		};
		const ir = makeIR(group([badRect]));
		await expect(
			serializePageToSvg(ir, 0, { validate: true }),
		).rejects.toThrow();
		// Default (no validate): fmt coerces NaN → "0", output stays well-formed.
		const { svg } = await serializePageToSvg(ir, 0);
		expect(svg).not.toContain("NaN");
		expect(svg.endsWith("</svg>")).toBe(true);
	});

	it("preserves and XML-escapes unicode text (CJK / emoji / RTL)", async () => {
		const unicode: CanvasTextNode = {
			...text,
			id: "t-uni",
			text: "日本語 😀 مرحبا <x>",
		};
		const { svg } = await serializePageToSvg(makeIR(group([unicode])), 0);
		expect(svg).toContain("日本語 😀 مرحبا &lt;x&gt;");
	});
});

describe("serializePageToSvg accessibility", () => {
	it("emits role=img + a <title> (document title fallback) for an accessible name", async () => {
		const { svg } = await serializePageToSvg(makeIR(group([])), 0);
		expect(svg).toContain('role="img"');
		expect(svg).toContain("<title>Fixture</title>");
		// <title> is the first child, before <defs>/content.
		expect(svg.indexOf("<title>")).toBeLessThan(svg.indexOf("<rect"));
	});

	it("prefers the page name over the document title", async () => {
		const ir = makeIR(group([]));
		const [page] = ir.pages;
		if (page) page.name = "Cover";
		const { svg } = await serializePageToSvg(ir, 0);
		expect(svg).toContain("<title>Cover</title>");
	});

	it("omits role/title when there is no name (no role=img without a label)", async () => {
		const ir = makeIR(group([]));
		ir.title = "";
		const { svg } = await serializePageToSvg(ir, 0);
		expect(svg).not.toContain('role="img"');
		expect(svg).not.toContain("<title>");
	});
});

const richText: CanvasRichTextNode = {
	id: "rt1",
	type: "rich-text",
	transform: identity,
	bounds: { width: 200, height: 60 },
	zIndex: 0,
	width: 200,
	paragraphs: [{ spans: [{ text: "Hi" }] }],
};

describe("emitRichText — without a measurer", () => {
	it("emits one <tspan> line per paragraph and warns that wrapping is approximate", () => {
		const ctx = createEmitContext();
		const out = emitRichText(
			{
				...richText,
				paragraphs: [
					{ spans: [{ text: "one" }] },
					{ spans: [{ text: "two" }] },
				],
			},
			ctx,
		);
		// Defaults live on <text>; each paragraph is a positioned <tspan> line.
		expect(out).toContain('font-family="Inter" font-size="16"');
		expect(out).toContain('<tspan x="0" y="12.8"><tspan>one</tspan></tspan>');
		// Second line advances by fontSize × lineHeight (16 × 1.4 = 22.4).
		expect(out).toContain('<tspan x="0" y="35.2"><tspan>two</tspan></tspan>');
		expect(ctx.warnings.map((w) => w.code)).toEqual([
			"RICH_TEXT_WRAP_APPROXIMATE",
		]);
		expect(ctx.warnings[0]?.nodeId).toBe("rt1");
	});

	it("emits nothing at all for a node with no paragraphs", () => {
		const ctx = createEmitContext();
		expect(emitRichText({ ...richText, paragraphs: [] }, ctx)).toBe("");
		// ...and does not warn about a document that has no rich text to wrap.
		expect(ctx.warnings).toEqual([]);
	});

	it("emits only the span attributes the document actually set", () => {
		const out = emitRichText(
			{
				...richText,
				paragraphs: [
					{
						spans: [
							{ text: "plain" },
							{
								text: "styled",
								fontFamily: "Georgia",
								fontSize: 24,
								fontWeight: "700",
								italic: true,
								underline: true,
								letterSpacing: -0.5,
								fill: "#ff0000",
							},
						],
					},
				],
			},
			createEmitContext(),
		);
		// An unstyled span inherits everything from <text>.
		expect(out).toContain("<tspan>plain</tspan>");
		expect(out).toContain(
			'<tspan font-family="Georgia" font-size="24" font-weight="700" font-style="italic" text-decoration="underline" letter-spacing="-0.5" fill="#ff0000">styled</tspan>',
		);
	});

	it("maps paragraph align to text-anchor and x", () => {
		const out = emitRichText(
			{
				...richText,
				paragraphs: [
					{ align: "center", spans: [{ text: "c" }] },
					{ align: "right", spans: [{ text: "r" }] },
				],
			},
			createEmitContext(),
		);
		expect(out).toContain('x="100" y="12.8" text-anchor="middle"');
		expect(out).toContain('x="200" y="35.2" text-anchor="end"');
	});

	// SVG has no `text-transform`, so it must be baked into the emitted glyphs.
	// The IR's `span.text` is never rewritten.
	it("applies textTransform to the emitted string, not to the IR", () => {
		const node: CanvasRichTextNode = {
			...richText,
			paragraphs: [
				{
					spans: [
						{ text: "shout", textTransform: "uppercase" },
						{ text: "QUIET", textTransform: "lowercase" },
						{ text: "two words", textTransform: "capitalize" },
					],
				},
			],
		};
		const out = emitRichText(node, createEmitContext());
		expect(out).toContain(">SHOUT<");
		expect(out).toContain(">quiet<");
		expect(out).toContain(">Two Words<");
		// The source document is untouched.
		expect(node.paragraphs[0]?.spans[0]?.text).toBe("shout");
	});

	it("escapes span text", () => {
		const out = emitRichText(
			{ ...richText, paragraphs: [{ spans: [{ text: "a < b & c" }] }] },
			createEmitContext(),
		);
		expect(out).toContain(">a &lt; b &amp; c<");
	});

	// `decorate` derives its gradient id from the node id, so two gradient spans
	// on one node would collide without a synthetic per-span id.
	it("gives each gradient span its own <defs> id", () => {
		const gradient = (color: string) => ({
			kind: "linear" as const,
			from: { x: 0, y: 0 },
			to: { x: 1, y: 0 },
			stops: [
				{ offset: 0, color },
				{ offset: 1, color: "#fff" },
			],
		});
		const out = emitRichText(
			{
				...richText,
				paragraphs: [
					{
						spans: [
							{ text: "a", fill: gradient("#f00") },
							{ text: "b", fill: gradient("#0f0") },
						],
					},
				],
			},
			createEmitContext(),
		);
		expect(out).toContain('id="grad-rt1-p0s0"');
		expect(out).toContain('id="grad-rt1-p0s1"');
		expect(out).toContain('fill="url(#grad-rt1-p0s0)"');
		expect(out).toContain('fill="url(#grad-rt1-p0s1)"');
	});

	// `emitText` was the only producer of `usedFonts`; without this, rich text
	// would silently emit no @font-face and never trip FONT_NOT_IN_MANIFEST.
	it("registers every resolved span family as a used font", () => {
		const ctx = createEmitContext();
		emitRichText(
			{
				...richText,
				paragraphs: [
					{ spans: [{ text: "a" }, { text: "b", fontFamily: "Georgia" }] },
				],
			},
			ctx,
		);
		expect([...ctx.usedFonts].sort()).toEqual(["Georgia", "Inter"]);
	});

	it("advances an empty paragraph as a blank line rather than collapsing it", () => {
		const out = emitRichText(
			{
				...richText,
				paragraphs: [
					{ spans: [{ text: "one" }] },
					{ spans: [] },
					{ spans: [{ text: "three" }] },
				],
			},
			createEmitContext(),
		);
		// Blank line occupies its slot: 12.8 → 35.2 → 57.6.
		expect(out).toContain('y="12.8"');
		expect(out).toContain('y="35.2"');
		expect(out).toContain('y="57.6"');
	});

	it("honours richTextDefaults overrides", () => {
		const out = emitRichText(
			richText,
			createEmitContext({
				richTextDefaults: { fontFamily: "Georgia", fontSize: 32 },
			}),
		);
		expect(out).toContain('font-family="Georgia" font-size="32"');
	});
});

/**
 * A deterministic stub measurer. It does no real shaping — it assigns each span
 * a fixed advance per character — which is exactly what a golden needs: the
 * point is to prove the emitter honours whatever the measurer decides, not to
 * test a layout algorithm (core has none, by design).
 *
 * It breaks a paragraph into lines of at most `width / CHAR_W` characters,
 * emitting one run per span slice.
 */
const CHAR_W = 10;
const stubMeasurer: CanvasTextMeasurer = ({ paragraphs, width, defaults }) => {
	const perLine = Math.max(1, Math.floor(width / CHAR_W));
	const lines: MeasuredLine[] = [];
	let y = 0;
	paragraphs.forEach((paragraph, paragraphIndex) => {
		let col = 0;
		let runs: MeasuredRun[] = [];
		const flush = () => {
			lines.push({
				paragraphIndex,
				runs,
				x: 0,
				y,
				width: col * CHAR_W,
				height: defaults.fontSize * defaults.lineHeight,
				baseline: defaults.fontSize,
			});
			y += defaults.fontSize * defaults.lineHeight;
			runs = [];
			col = 0;
		};
		paragraph.spans.forEach((span, spanIndex) => {
			let start = 0;
			while (start < span.text.length) {
				const room = perLine - col;
				if (room <= 0) {
					flush();
					continue;
				}
				const slice = span.text.slice(start, start + room);
				runs.push({
					paragraphIndex,
					spanIndex,
					start,
					text: slice,
					x: col * CHAR_W,
					width: slice.length * CHAR_W,
				});
				start += slice.length;
				col += slice.length;
			}
		});
		flush();
	});
	return {
		lines,
		width,
		height: y,
	};
};

describe("emitRichText — with a measurer", () => {
	it("lets the measured line boxes drive tspan positions, and does not warn", () => {
		const ctx = createEmitContext({ textMeasurer: stubMeasurer });
		// width 200 ⇒ 20 chars per line; "aaaaaaaaaaaaaaaaaaaaaaaaa" is 25 ⇒ 2 lines.
		const out = emitRichText(
			{ ...richText, paragraphs: [{ spans: [{ text: "a".repeat(25) }] }] },
			ctx,
		);
		expect(out).toContain(`<tspan x="0" y="16">${"a".repeat(20)}</tspan>`);
		expect(out).toContain(`<tspan x="0" y="38.4">${"a".repeat(5)}</tspan>`);
		// The whole point: a measured export is NOT flagged as approximate.
		expect(ctx.warnings).toEqual([]);
	});

	// A span that wraps is split into several runs, each of which must still carry
	// the styling of the span it came from.
	it("carries span styling onto every run of a wrapped span", () => {
		const out = emitRichText(
			{
				...richText,
				paragraphs: [
					{ spans: [{ text: "b".repeat(25), italic: true, fill: "#f00" }] },
				],
			},
			createEmitContext({ textMeasurer: stubMeasurer }),
		);
		const runs = out.match(/<tspan [^>]*font-style="italic"[^>]*>/g) ?? [];
		expect(runs).toHaveLength(2);
		for (const run of runs) expect(run).toContain('fill="#f00"');
	});

	it("passes the node's wrap mode and width through to the measurer", () => {
		const seen: TextMeasureRequest[] = [];
		const spy: CanvasTextMeasurer = (req) => {
			seen.push(req);
			return { lines: [], width: 0, height: 0 };
		};
		emitRichText(
			{ ...richText, width: 320, wrap: "character" },
			createEmitContext({ textMeasurer: spy }),
		);
		expect(seen[0]?.width).toBe(320);
		expect(seen[0]?.wrap).toBe("character");
		// `word` is the sensible default for an unset wrap mode.
		emitRichText(richText, createEmitContext({ textMeasurer: spy }));
		expect(seen[1]?.wrap).toBe("word");
	});
});

describe("emitRichText — overflow", () => {
	it("clips to the box, reusing the frame clipPath mechanism", () => {
		const out = emitRichText(
			{ ...richText, overflow: "clip", height: 40 },
			createEmitContext(),
		);
		expect(out).toContain(
			'<defs><clipPath id="richtext-clip-rt1"><rect width="200" height="40" /></clipPath></defs>',
		);
		expect(out).toContain('clip-path="url(#richtext-clip-rt1)"');
	});

	it("derives the clip height from the measurer when the node has none", () => {
		const out = emitRichText(
			{ ...richText, overflow: "clip" },
			createEmitContext({ textMeasurer: stubMeasurer }),
		);
		// One line ⇒ measured height 16 × 1.4 = 22.4.
		expect(out).toContain('<rect width="200" height="22.4" />');
	});

	// Honest degradation: with neither an explicit height nor a measurer there is
	// nothing to clip against, so no bogus clip box is invented.
	it("emits no clip when it has neither a height nor a measurer", () => {
		const out = emitRichText(
			{ ...richText, overflow: "clip" },
			createEmitContext(),
		);
		expect(out).not.toContain("clipPath");
		expect(out).not.toContain("clip-path");
	});

	it("clips an ellipsis overflow and warns that the marker is missing", () => {
		const ctx = createEmitContext({ textMeasurer: stubMeasurer });
		const out = emitRichText(
			{ ...richText, overflow: "ellipsis", height: 20 },
			ctx,
		);
		expect(out).toContain('clip-path="url(#richtext-clip-rt1)"');
		expect(ctx.warnings.map((w) => w.code)).toEqual([
			"RICH_TEXT_ELLIPSIS_UNSUPPORTED",
		]);
		expect(ctx.warnings[0]?.nodeId).toBe("rt1");
	});

	it("clips nothing for visible or auto-height", () => {
		for (const overflow of ["visible", "auto-height"] as const) {
			const ctx = createEmitContext({ textMeasurer: stubMeasurer });
			const out = emitRichText({ ...richText, overflow, height: 40 }, ctx);
			expect(out).not.toContain("clip-path");
			expect(ctx.warnings).toEqual([]);
		}
	});
});

describe("emitRichText — font manifest", () => {
	it("reports a span family that is missing from the manifest", async () => {
		const ir = makeIR(
			group([
				{
					...richText,
					paragraphs: [{ spans: [{ text: "x", fontFamily: "Georgia" }] }],
				},
			]),
		);
		const { warnings } = await serializePageToSvg(ir, 0, {
			textMeasurer: stubMeasurer,
			fonts: [{ family: "Inter", src: "https://example.com/inter.woff2" }],
		});
		const missing = warnings.filter((w) => w.code === "FONT_NOT_IN_MANIFEST");
		expect(missing).toHaveLength(1);
		expect(missing[0]?.message).toContain("Georgia");
	});
});
