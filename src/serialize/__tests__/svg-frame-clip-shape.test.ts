import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import type {
	CanvasFrameNode,
	CanvasFrameShape,
	CanvasIR,
	CanvasNode,
	CanvasTransform,
} from "../../ir/types.js";
import { serializePageToSvg } from "../svg.js";

/**
 * SVG emission for `CanvasFrameNode.shape` (ADR 0008 decision 2, PLAN-0035
 * `cp4-002`).
 *
 * The mechanism under test is deliberately NOT a new one: a shaped frame emits
 * the same `<clipPath>` over the same `<g>` a rectangular `clip` has emitted
 * since canvas-m1-003 — only the child of that `<clipPath>` changes. So these
 * tests pin two things: that each kind produces the right geometry, and that
 * nothing about the surrounding frame contract moved. The pre-ADR-0008 frame
 * golden (`canvas-frames.snap.svg`) staying byte-identical is the other half of
 * that proof and lives in `svg-golden.test.ts`.
 *
 * `<mask>` emission is deliberately absent: ADR 0008 decision 3 deprecates
 * `CanvasImageNode.maskAssetId` rather than implementing it, so
 * `IMAGE_MASK_UNSUPPORTED` survives untouched and no alpha-mask path exists to
 * test.
 */

/** Same well-formedness scan the frame golden uses; duplicated rather than exported so neither file constrains the other. */
function assertWellFormed(svg: string): void {
	const stack: string[] = [];
	const tagRe = /<(\/?)([a-zA-Z][\w-]*)([^>]*?)(\/?)>/g;
	for (const match of svg.matchAll(tagRe)) {
		const closing = match[1] === "/";
		const name = match[2];
		const selfClosing = match[4] === "/";
		if (closing) {
			expect(stack.pop()).toBe(name);
		} else if (!selfClosing) {
			stack.push(name);
		}
		if (!closing) {
			const attrNames = Array.from(
				match[3].matchAll(/([\w:-]+)=/g),
				(m) => m[1],
			);
			expect(attrNames).toEqual(Array.from(new Set(attrNames)));
		}
	}
	expect(stack).toEqual([]);
}

function t(x = 0, y = 0): CanvasTransform {
	return { x, y, rotation: 0, scaleX: 1, scaleY: 1 };
}

const PIXEL_PNG =
	"data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";

/** A clipping frame carrying `shape`, with whatever extra fields a case needs. */
function shapedFrame(
	id: string,
	shape: CanvasFrameShape | undefined,
	extra: Partial<CanvasFrameNode> = {},
): CanvasFrameNode {
	return {
		id,
		type: "frame",
		transform: t(),
		bounds: { width: 100, height: 80 },
		zIndex: 0,
		clip: true,
		...(shape ? { shape } : {}),
		children: [],
		...extra,
	};
}

/** A one-page document wrapping `children` — the minimum a serializer call needs. */
function docWith(children: CanvasNode[], id = "doc-shape"): CanvasIR {
	return {
		version: "3",
		id,
		title: "Frame clip shapes",
		pages: [
			{
				id: "p1",
				size: { width: 400, height: 320, unit: "px" },
				background: { kind: "solid", value: "#ffffff" },
				root: {
					id: "root",
					type: "group",
					transform: t(),
					bounds: { width: 400, height: 320 },
					zIndex: 0,
					children,
				},
			},
		],
		assets: {
			"pixel-asset": {
				id: "pixel-asset",
				uri: PIXEL_PNG,
				mimeType: "image/png",
				width: 1,
				height: 1,
			},
		},
		metadata: {
			createdAt: "2026-01-01T00:00:00.000Z",
			updatedAt: "2026-01-01T00:00:00.000Z",
		},
	};
}

/**
 * Golden fixture: every honourable `CanvasFrameShape` kind in one page, plus the
 * three compositions the acceptance criteria name.
 *
 *  - `ellipse-well`  — the headline case: a shape-clipping frame holding an
 *                      IMAGE. The image must stay a real `<image>` clipped by
 *                      the ellipse, never baked into a raster.
 *  - `hexagon`       — `polygon`, with a solid background painted behind it.
 *  - `starred`       — `star`, with a GRADIENT background, so the shape clip and
 *                      the gradient both have to land in `<defs>` without
 *                      tripping over each other.
 *  - `blade`         — `path`, whose `d` passes `PATH_D_RE`, with an
 *                      overflowing child that the path must trim.
 *  - `declared-rect` — an EXPLICIT `{ kind: "rect" }` plus `radius`: byte-wise
 *                      the pre-ADR-0008 rounded clip. "Deliberately no shape
 *                      mask" must cost nothing.
 *  - `inert`         — a shape on an UNCLIPPED frame. No `<clipPath>` at all,
 *                      and the background keeps the frame's own rounding: ADR
 *                      0008 decision 2 forbids `shape` acting as a second,
 *                      silent clip trigger.
 *  - `nest-outer` /
 *    `nest-inner`    — nested SHAPES: an ellipse clip containing a triangle
 *                      clip. SVG composes these as an intersection natively.
 *  - `rect-outer` /
 *    `shape-inner`   — a shaped frame inside a plain rectangular clip.
 */
const shapesFixture: CanvasIR = docWith(
	[
		shapedFrame("ellipse-well", { kind: "ellipse" }, {
			transform: t(8, 8),
			bounds: { width: 100, height: 100 },
			placeholder: { kind: "image", assetId: "pixel-asset" },
			children: [
				{
					id: "well-image",
					type: "image",
					transform: t(),
					bounds: { width: 140, height: 140 },
					zIndex: 0,
					assetId: "pixel-asset",
				},
			],
		} satisfies Partial<CanvasFrameNode>),
		shapedFrame(
			"hexagon",
			{ kind: "polygon", sides: 6 },
			{ transform: t(120, 8), background: "#f1f5f9" },
		),
		shapedFrame(
			"starred",
			{ kind: "star", points: 5, innerRadiusRatio: 0.5 },
			{
				transform: t(232, 8),
				bounds: { width: 100, height: 100 },
				background: {
					kind: "linear",
					stops: [
						{ offset: 0, color: "#0ea5e9" },
						{ offset: 1, color: "#8b5cf6" },
					],
					from: { x: 0, y: 0 },
					to: { x: 1, y: 1 },
				},
			},
		),
		shapedFrame(
			"blade",
			{ kind: "path", d: "M 0 0 L 80 0 L 80 60 Z" },
			{
				transform: t(8, 120),
				bounds: { width: 80, height: 60 },
				children: [
					{
						id: "blade-child",
						type: "rect",
						transform: t(20, 20),
						bounds: { width: 80, height: 80 },
						zIndex: 0,
						fill: "#ef4444",
					},
				],
			},
		),
		shapedFrame(
			"declared-rect",
			{ kind: "rect" },
			{
				transform: t(100, 120),
				bounds: { width: 80, height: 60 },
				radius: 12,
				background: "#fde047",
			},
		),
		shapedFrame(
			"inert",
			{ kind: "ellipse" },
			{
				transform: t(192, 120),
				bounds: { width: 80, height: 60 },
				clip: false,
				radius: 10,
				background: "#e2e8f0",
			},
		),
		shapedFrame(
			"nest-outer",
			{ kind: "ellipse" },
			{
				transform: t(8, 200),
				bounds: { width: 120, height: 100 },
				children: [
					shapedFrame(
						"nest-inner",
						{ kind: "polygon", sides: 3 },
						{
							transform: t(10, 10),
							bounds: { width: 80, height: 60 },
							background: "#0ea5e9",
						},
					),
				],
			},
		),
		shapedFrame("rect-outer", undefined, {
			transform: t(160, 200),
			bounds: { width: 140, height: 100 },
			background: "#e2e8f0",
			children: [
				shapedFrame(
					"shape-inner",
					{ kind: "star", points: 6, innerRadiusRatio: 0.4 },
					{
						transform: t(12, 12),
						bounds: { width: 90, height: 70 },
						background: "#fb7185",
					},
				),
			],
		}),
	],
	"doc-golden-frame-shapes",
);

describe("serializePageToSvg — frame clip shapes (golden)", () => {
	it("pins the clip geometry of every shape kind, and their compositions", async () => {
		const { svg, warnings } = await serializePageToSvg(shapesFixture, 0, {
			pretty: true,
			images: "embed",
		});

		assertWellFormed(svg);

		// Every shape here is honourable, so NOTHING degrades. This is the
		// "no warning fires for a supported case" acceptance criterion.
		expect(warnings.map((w) => w.code)).not.toContain(
			"FRAME_CLIP_SHAPE_DEGRADED",
		);
		// And no shape kind falls through to the unknown-kind path either.
		expect(warnings.map((w) => w.code)).not.toContain("UNKNOWN_KIND_SKIPPED");

		// One clip id per node, on the SAME `frame-clip-<id>` scheme rectangular
		// clips have always used — a shaped clip is not a new namespace.
		expect(svg).toContain(
			'<clipPath id="frame-clip-ellipse-well"><ellipse cx="50" cy="50" rx="50" ry="50" /></clipPath>',
		);
		expect(svg).toContain('clip-path="url(#frame-clip-ellipse-well)"');

		// polygon/star reuse the SAME vertex maths `emitPolygon`/`emitStar` use.
		expect(svg).toContain(
			'<clipPath id="frame-clip-hexagon"><polygon points="50,0 93.3013,20 93.3013,60 50,80 6.6987,60 6.6987,20" /></clipPath>',
		);
		expect(svg).toMatch(
			/<clipPath id="frame-clip-starred"><polygon points="50,0 [^"]+" \/><\/clipPath>/,
		);

		// `path` is emitted verbatim once it clears the allowlist.
		expect(svg).toContain(
			'<clipPath id="frame-clip-blade"><path d="M 0 0 L 80 0 L 80 60 Z" /></clipPath>',
		);

		// An EXPLICIT rect is byte-wise the pre-ADR-0008 rounded clip.
		expect(svg).toContain(
			'<clipPath id="frame-clip-declared-rect"><rect width="80" height="60" rx="12" ry="12" /></clipPath>',
		);

		// A shape on an unclipped frame emits no clip path at all, and leaves the
		// background rounded by the frame's OWN radius.
		expect(svg).not.toContain('id="frame-clip-inert"');
		expect(svg).toContain('<rect width="80" height="60" rx="10" ry="10"');

		// Nested shapes, and a shape inside a rectangular clip: distinct ids,
		// each `<g>` carrying its own `clip-path`, so SVG intersects them.
		expect(svg).toContain('<clipPath id="frame-clip-nest-outer"><ellipse ');
		expect(svg).toContain('<clipPath id="frame-clip-nest-inner"><polygon ');
		expect(svg).toContain(
			'<clipPath id="frame-clip-rect-outer"><rect width="140" height="100" /></clipPath>',
		);
		expect(svg).toContain('<clipPath id="frame-clip-shape-inner"><polygon ');

		// The image in the ellipse well is still a real <image>, clipped by the
		// frame — never flattened into the shape.
		expect(svg).toContain("<image ");

		await expect(svg).toMatchFileSnapshot(
			fileURLToPath(
				new URL(
					"./__snapshots__/canvas-frame-shapes.snap.svg",
					import.meta.url,
				),
			),
		);
	});

	it("keeps a shape-clipped image a real <image> inside the clipped <g>", async () => {
		const { svg } = await serializePageToSvg(shapesFixture, 0, {
			images: "embed",
		});
		// The clip attribute and the <image> must be on/inside the same group:
		// find the group carrying the ellipse clip and assert the image follows it
		// before the group closes.
		const open = svg.indexOf('clip-path="url(#frame-clip-ellipse-well)"');
		expect(open).toBeGreaterThan(-1);
		const close = svg.indexOf("</g>", open);
		expect(svg.slice(open, close)).toContain("<image ");
	});
});

describe("serializePageToSvg — frame clip shape degradation", () => {
	it("rejects path data outside PATH_D_RE and clips to the frame box instead", async () => {
		const doc = docWith([
			shapedFrame(
				"hostile",
				// `"` and `>` would break out of the attribute; `url(` is the classic
				// SVG injection vector. The allowlist rejects all of it.
				{ kind: "path", d: 'M0 0" onload="alert(1)' },
				{ bounds: { width: 60, height: 40 } },
			),
		]);
		const { svg, warnings } = await serializePageToSvg(doc, 0);

		// Degraded, not dropped: the frame still clips, to its box.
		expect(svg).toContain(
			'<clipPath id="frame-clip-hostile"><rect width="60" height="40" /></clipPath>',
		);
		expect(svg).toContain('clip-path="url(#frame-clip-hostile)"');
		// The hostile data reaches neither the attribute nor the markup.
		expect(svg).not.toContain("onload");
		expect(svg).not.toContain("<path ");

		const degraded = warnings.filter(
			(w) => w.code === "FRAME_CLIP_SHAPE_DEGRADED",
		);
		expect(degraded).toHaveLength(1);
		expect(degraded[0]?.nodeId).toBe("hostile");
		expect(degraded[0]?.message).toContain("allowed character set");
	});

	it("degrades a kind this build does not implement, without throwing", async () => {
		const doc = docWith([
			shapedFrame(
				"future",
				// A newer peer's shape kind surviving `looseObject` round-tripping —
				// exactly the case `FrameClipDegradation` names.
				{ kind: "squircle" } as unknown as CanvasFrameShape,
				{ bounds: { width: 60, height: 40 } },
			),
		]);
		const { svg, warnings } = await serializePageToSvg(doc, 0);

		expect(svg).toContain(
			'<clipPath id="frame-clip-future"><rect width="60" height="40" /></clipPath>',
		);
		const degraded = warnings.filter(
			(w) => w.code === "FRAME_CLIP_SHAPE_DEGRADED",
		);
		expect(degraded).toHaveLength(1);
		expect(degraded[0]?.message).toContain("does not implement");
	});

	it("degrades geometry that describes no outline, keeping the frame's rounding", async () => {
		const doc = docWith([
			shapedFrame(
				"two-sided",
				{ kind: "polygon", sides: 2 },
				{ bounds: { width: 60, height: 40 }, radius: 8 },
			),
		]);
		const { svg, warnings } = await serializePageToSvg(doc, 0);

		// The rectangle a degraded shape falls back to is the one the RESOLVER
		// falls back to — which carries the frame's own rounding.
		expect(svg).toContain(
			'<clipPath id="frame-clip-two-sided"><rect width="60" height="40" rx="8" ry="8" /></clipPath>',
		);
		const degraded = warnings.filter(
			(w) => w.code === "FRAME_CLIP_SHAPE_DEGRADED",
		);
		expect(degraded).toHaveLength(1);
		expect(degraded[0]?.message).toContain("does not describe a real outline");
	});

	it("stays silent about an unhonourable shape on an UNCLIPPED frame", async () => {
		const doc = docWith([
			shapedFrame("inert-bad", { kind: "polygon", sides: 2 }, { clip: false }),
		]);
		const { svg, warnings } = await serializePageToSvg(doc, 0);

		// Nothing was going to clip, so nothing was lost — warning here would be
		// noise on a working document.
		expect(warnings.map((w) => w.code)).not.toContain(
			"FRAME_CLIP_SHAPE_DEGRADED",
		);
		expect(svg).not.toContain("clipPath");
	});
});

describe("serializePageToSvg — clip id uniqueness across pages", () => {
	/** A two-page document whose pages each hold one shaped clipping frame. */
	function twoPageDoc(frameIds: readonly [string, string]): CanvasIR {
		return {
			version: "3",
			id: "doc-multipage-shapes",
			title: "Multi-page shapes",
			pages: frameIds.map((frameId, index) => ({
				id: `page-${index + 1}`,
				size: { width: 200, height: 160, unit: "px" },
				background: { kind: "solid" as const, value: "#ffffff" },
				root: {
					id: `root-${index + 1}`,
					type: "group" as const,
					transform: t(),
					bounds: { width: 200, height: 160 },
					zIndex: 0,
					children: [
						shapedFrame(
							frameId,
							{ kind: "ellipse" },
							{ bounds: { width: 80, height: 60 } },
						),
					],
				},
			})),
			assets: {},
			metadata: {
				createdAt: "2026-01-01T00:00:00.000Z",
				updatedAt: "2026-01-01T00:00:00.000Z",
			},
		};
	}

	const clipIds = (svg: string): string[] =>
		Array.from(svg.matchAll(/<clipPath id="([^"]+)"/g), (m) => m[1]);

	it("emits a different clip id on every page of a multi-page export", async () => {
		// Node ids are unique across the WHOLE document (INV-2), so ids derived
		// from them cannot collide between pages.
		const doc = twoPageDoc(["hero-frame", "footer-frame"]);
		const first = await serializePageToSvg(doc, 0);
		const second = await serializePageToSvg(doc, 1);

		expect(clipIds(first.svg)).toEqual(["frame-clip-hero-frame"]);
		expect(clipIds(second.svg)).toEqual(["frame-clip-footer-frame"]);
		// The proof that matters if the two pages are ever inlined into one host
		// document: no id appears in both.
		const overlap = clipIds(first.svg).filter((id) =>
			clipIds(second.svg).includes(id),
		);
		expect(overlap).toEqual([]);
	});

	it("keeps ids apart when two pages' frame ids differ only by an unsafe character", async () => {
		// `sanitizeId` cleans both `:` and `.` to `_`, so these two would collide
		// on the cleaned string alone; the appended fingerprint of the ORIGINAL id
		// is what keeps them distinct (C-18).
		const doc = twoPageDoc(["hero:frame", "hero.frame"]);
		const first = await serializePageToSvg(doc, 0);
		const second = await serializePageToSvg(doc, 1);

		const [firstId] = clipIds(first.svg);
		const [secondId] = clipIds(second.svg);
		expect(firstId).toMatch(/^frame-clip-hero_frame-/);
		expect(secondId).toMatch(/^frame-clip-hero_frame-/);
		expect(firstId).not.toBe(secondId);
	});
});
