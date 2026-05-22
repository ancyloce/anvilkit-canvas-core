import { describe, expect, it } from "vitest";
import {
	bytesToBase64,
	createEmitContext,
	emitEllipse,
	emitLine,
	emitPath,
	emitRect,
	emitText,
	escapeAttr,
	escapeCssString,
	escapeXml,
	isSafeDataImageUrl,
	isValidPathD,
	normalizeUri,
	sanitizeId,
	serializePageToSvg,
	shouldSkipNode,
	toAffineMatrix,
	transformAttr,
	unitToPx,
} from "../serialize/svg.js";
import type {
	CanvasEllipseNode,
	CanvasGroupNode,
	CanvasIR,
	CanvasLineNode,
	CanvasNode,
	CanvasPageBackground,
	CanvasPageSize,
	CanvasPathNode,
	CanvasRectNode,
	CanvasTextNode,
	CanvasTransform,
} from "../types.js";

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

describe("normalizeUri", () => {
	it("blocks dangerous schemes regardless of case", () => {
		expect(normalizeUri("javascript:alert(1)")).toBeUndefined();
		expect(normalizeUri("JavaScript:alert(1)")).toBeUndefined();
		expect(normalizeUri("vbscript:msgbox")).toBeUndefined();
		expect(normalizeUri("file:///etc/passwd")).toBeUndefined();
		expect(normalizeUri("blob:https://x/y")).toBeUndefined();
		expect(normalizeUri("filesystem:https://x")).toBeUndefined();
	});

	it("allows http(s) and relative URLs", () => {
		expect(normalizeUri("https://cdn.example.com/a.png")).toBe(
			"https://cdn.example.com/a.png",
		);
		expect(normalizeUri("/assets/a.png")).toBe("/assets/a.png");
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
	} = {},
): CanvasIR {
	return {
		version: "1",
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
		assets: {},
		metadata: { createdAt: "t0", updatedAt: "t0" },
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
