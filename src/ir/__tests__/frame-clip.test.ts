import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { serializePageToSvg } from "../../serialize/svg.js";
import { resolveFrameClipShape } from "../frame-clip.js";
import { resolveFrameClipShape as resolveFromIrBarrel } from "../index.js";
import { validateCanvasIRInvariants } from "../invariants.js";
import type {
	CanvasFrameNode,
	CanvasFrameShape,
	CanvasIR,
	CanvasNode,
} from "../types.js";
import { CanvasFrameShapeSchema, migrateCanvasIR } from "../validators.js";

/**
 * @file cp4-001 — the ONE frame-clip resolver (ADR 0008 decision 2).
 *
 * What this file has to keep honest:
 *
 *  - the precedence rules, in full: `clip` is the only on/off switch, an absent
 *    `shape` inherits the rectangle, a present one wins outright, and
 *    `radius`/`cornerRadii` reach the result for `kind: "rect"` alone;
 *  - **absent vs explicitly-rectangular stay distinguishable** — the mask
 *    counterpart of `resolveNodeEffects`' absent-vs-empty `effects` array, and
 *    the thing that lets an edit remove a mask without deleting history;
 *  - a shape this build cannot honour DEGRADES to the rectangle instead of
 *    throwing, and is reported as an invariant diagnostic;
 *  - a document written before the field existed parses byte-identically —
 *    proven against a committed on-disk fixture, not an object literal;
 *  - shape state survives parse -> serialize -> parse exactly, unknown keys
 *    included (the IR's `looseObject` posture);
 *  - ADR 0008's free-value claim — *"a square frame with `radius` equal to half
 *    its side already clips to a circle on both paths"* — which that document
 *    explicitly flags as derived from markup rather than executed, and asks
 *    cp4-001 to pin with a fixture.
 */

const identity = { x: 0, y: 0, rotation: 0, scaleX: 1, scaleY: 1 };

function frame(over: Partial<CanvasFrameNode> = {}): CanvasFrameNode {
	return {
		id: "frame-1",
		type: "frame",
		transform: identity,
		bounds: { width: 200, height: 200 },
		zIndex: 0,
		children: [],
		...over,
	};
}

function makeIR(children: CanvasNode[]): CanvasIR {
	return {
		version: "3",
		id: "doc-1",
		title: "frame clip fixture",
		pages: [
			{
				id: "page-1",
				size: { width: 400, height: 400, unit: "px" },
				background: { kind: "solid", value: "#ffffff" },
				root: {
					id: "root-1",
					type: "group",
					transform: identity,
					bounds: { width: 400, height: 400 },
					zIndex: 0,
					children,
				},
			},
		],
		assets: {},
		metadata: { createdAt: "t0", updatedAt: "t0" },
	};
}

/** Every honourable shape kind, once each. */
const EVERY_KIND: readonly CanvasFrameShape[] = [
	{ kind: "rect" },
	{ kind: "ellipse" },
	{ kind: "polygon", sides: 6 },
	{ kind: "star", points: 5, innerRadiusRatio: 0.5 },
	{ kind: "path", d: "M0 0 L10 0 L10 10 Z" },
];

describe("resolveFrameClipShape — precedence", () => {
	it("resolves an unclipped, unshaped frame to an inert rectangle", () => {
		expect(resolveFrameClipShape(frame())).toEqual({
			clipped: false,
			shape: { kind: "rect" },
			source: "default",
		});
	});

	it("treats `clip` as the ONLY on/off switch — a shape never clips on its own", () => {
		for (const shape of EVERY_KIND) {
			expect(resolveFrameClipShape(frame({ shape })).clipped).toBe(false);
			expect(resolveFrameClipShape(frame({ clip: true, shape })).clipped).toBe(
				true,
			);
		}
		// ...and an explicit `clip: false` is not a truthy accident either.
		expect(
			resolveFrameClipShape(frame({ clip: false, shape: { kind: "ellipse" } }))
				.clipped,
		).toBe(false);
	});

	it("inherits the rectangle, with rounding, when no shape is declared", () => {
		expect(resolveFrameClipShape(frame({ clip: true, radius: 12 }))).toEqual({
			clipped: true,
			shape: { kind: "rect" },
			radius: 12,
			source: "default",
		});
	});

	it("lets per-corner radii win over the scalar radius, as both clip paths do", () => {
		const cornerRadii = {
			topLeft: 1,
			topRight: 2,
			bottomRight: 3,
			bottomLeft: 4,
		};
		expect(
			resolveFrameClipShape(frame({ clip: true, radius: 12, cornerRadii })),
		).toEqual({
			clipped: true,
			shape: { kind: "rect" },
			cornerRadii,
			source: "default",
		});
	});

	it("drops a zero radius rather than resolving a rounding of nothing", () => {
		const resolved = resolveFrameClipShape(frame({ clip: true, radius: 0 }));
		expect(resolved.radius).toBeUndefined();
		expect(resolved.cornerRadii).toBeUndefined();
	});

	it("carries a declared shape through untouched, kind by kind", () => {
		for (const shape of EVERY_KIND) {
			const resolved = resolveFrameClipShape(frame({ clip: true, shape }));
			expect(resolved.source).toBe("declared");
			expect(resolved.shape).toEqual(shape);
			expect(resolved.degradation).toBeUndefined();
		}
	});

	it("applies radius/cornerRadii to `rect` ONLY, ignoring them for every other kind", () => {
		const cornerRadii = {
			topLeft: 5,
			topRight: 5,
			bottomRight: 5,
			bottomLeft: 5,
		};
		for (const shape of EVERY_KIND) {
			const resolved = resolveFrameClipShape(
				frame({ clip: true, shape, radius: 40, cornerRadii }),
			);
			if (shape.kind === "rect") {
				expect(resolved.cornerRadii).toEqual(cornerRadii);
			} else {
				expect(resolved.radius).toBeUndefined();
				expect(resolved.cornerRadii).toBeUndefined();
			}
		}
	});

	it("preserves a newer peer's unknown keys on the shape object", () => {
		const shape = {
			kind: "ellipse",
			vendorHint: 7,
		} as unknown as CanvasFrameShape;
		const resolved = resolveFrameClipShape(frame({ clip: true, shape }));
		expect((resolved.shape as Record<string, unknown>).vendorHint).toBe(7);
	});

	it("is reachable from the `ir/` barrel — one resolver, publicly", () => {
		expect(resolveFromIrBarrel).toBe(resolveFrameClipShape);
	});
});

describe("resolveFrameClipShape — absent vs explicitly rectangular", () => {
	const absent = resolveFrameClipShape(frame({ clip: true, radius: 12 }));
	const explicit = resolveFrameClipShape(
		frame({ clip: true, radius: 12, shape: { kind: "rect" } }),
	);

	it("resolves both to the same geometry", () => {
		expect(explicit.shape).toEqual(absent.shape);
		expect(explicit.radius).toBe(absent.radius);
		expect(explicit.clipped).toBe(absent.clipped);
	});

	it("keeps them distinguishable by `source`", () => {
		expect(absent.source).toBe("default");
		expect(explicit.source).toBe("declared");
		expect(explicit).not.toEqual(absent);
	});

	it("survives a mask being removed by writing the rectangle, not by deleting the field", () => {
		const masked = frame({
			clip: true,
			shape: { kind: "star", points: 5, innerRadiusRatio: 0.4 },
		});
		const unmasked = frame({ clip: true, shape: { kind: "rect" } });
		expect(resolveFrameClipShape(masked).shape).toEqual({
			kind: "star",
			points: 5,
			innerRadiusRatio: 0.4,
		});
		// The edit is still on the record: the frame says "rectangle", it does
		// not merely fail to say anything.
		expect(resolveFrameClipShape(unmasked).source).toBe("declared");
		expect(resolveFrameClipShape(unmasked).shape).toEqual({ kind: "rect" });
	});
});

describe("resolveFrameClipShape — degradation, never a crash", () => {
	const unhonourable: ReadonlyArray<
		readonly [label: string, shape: CanvasFrameShape, reason: string]
	> = [
		[
			"a kind this build has never heard of",
			{ kind: "squircle" } as unknown as CanvasFrameShape,
			"unknown-shape-kind",
		],
		[
			"a polygon with too few sides",
			{ kind: "polygon", sides: 2 },
			"invalid-shape-geometry",
		],
		[
			"a polygon with a fractional side count",
			{ kind: "polygon", sides: 5.5 },
			"invalid-shape-geometry",
		],
		[
			"a star with too few points",
			{ kind: "star", points: 2, innerRadiusRatio: 0.5 },
			"invalid-shape-geometry",
		],
		[
			"a star whose inner radius leaves the unit interval",
			{ kind: "star", points: 5, innerRadiusRatio: 1.5 },
			"invalid-shape-geometry",
		],
		[
			"a path with no data",
			{ kind: "path", d: "   " },
			"invalid-shape-geometry",
		],
	];

	for (const [label, shape, reason] of unhonourable) {
		it(`degrades ${label} to the rectangle with a reason`, () => {
			const resolved = resolveFrameClipShape(
				frame({ clip: true, shape, radius: 8 }),
			);
			expect(resolved.clipped).toBe(true);
			expect(resolved.shape).toEqual({ kind: "rect" });
			expect(resolved.source).toBe("degraded");
			expect(resolved.degradation).toBe(reason);
			// Degrading to the rectangle means degrading to the WHOLE rectangle,
			// rounding included — not to a bare box.
			expect(resolved.radius).toBe(8);
		});
	}

	it("never throws, whatever it is handed", () => {
		const hostile = [
			undefined,
			null,
			{},
			{ kind: null },
			{ kind: "polygon" },
			{ kind: "star", points: 5 },
			{ kind: "path" },
		];
		for (const shape of hostile) {
			expect(() =>
				resolveFrameClipShape(
					frame({ clip: true, shape: shape as unknown as CanvasFrameShape }),
				),
			).not.toThrow();
		}
	});
});

describe("frame clip diagnostics via the IR invariants", () => {
	it("reports an unhonourable shape rather than letting it render silently", () => {
		const ir = makeIR([
			frame({
				id: "bad-shape",
				clip: true,
				shape: { kind: "hexagram" } as unknown as CanvasFrameShape,
			}),
		]);
		const issues = validateCanvasIRInvariants(ir);
		expect(issues).toContainEqual(
			expect.objectContaining({
				code: "unsupported-frame-clip-shape",
				nodeId: "bad-shape",
				pageId: "page-1",
			}),
		);
		expect(issues[0]?.message).toContain("hexagram");
		expect(issues[0]?.message).toContain("unknown-shape-kind");
	});

	it("shares the resolver's verdict — every honourable shape is issue-free", () => {
		for (const shape of EVERY_KIND) {
			const ir = makeIR([frame({ clip: true, shape })]);
			expect(validateCanvasIRInvariants(ir)).toEqual([]);
		}
	});

	it("reports a mask whose image well references a missing asset, and still resolves the mask", () => {
		const masked = frame({
			id: "well",
			clip: true,
			shape: { kind: "ellipse" },
			placeholder: { kind: "image", assetId: "asset-that-does-not-exist" },
		});
		const issues = validateCanvasIRInvariants(makeIR([masked]));
		expect(issues).toContainEqual(
			expect.objectContaining({ code: "dangling-asset-reference" }),
		);
		// Degrades, never crashes: the geometry still resolves, so the frame
		// clips to its ellipse and paints the empty-well fallback inside it.
		expect(resolveFrameClipShape(masked)).toEqual({
			clipped: true,
			shape: { kind: "ellipse" },
			source: "declared",
		});
	});
});

describe("the field is optional and additive — existing documents parse unchanged", () => {
	const readFixture = (name: string): unknown =>
		JSON.parse(
			readFileSync(new URL(`./fixtures/${name}.json`, import.meta.url), "utf8"),
		);

	it("parses a committed pre-cp4-001 v3 document to a byte-identical value", () => {
		const raw = readFixture("v3-layout-declared");
		expect(migrateCanvasIR(structuredClone(raw))).toEqual(raw);
	});

	it("leaves the fixture's frame with no `shape` key at all", () => {
		const ir = migrateCanvasIR(
			structuredClone(readFixture("v3-layout-declared")),
		);
		const frames =
			ir.pages[0]?.root.type === "group"
				? ir.pages[0].root.children.filter(
						(node): node is CanvasFrameNode => node.type === "frame",
					)
				: [];
		expect(frames.length).toBeGreaterThan(0);
		for (const node of frames) {
			expect("shape" in node).toBe(false);
			expect(resolveFrameClipShape(node).source).toBe("default");
		}
	});

	it("still upgrades a v2 document carrying unknown keys", () => {
		const ir = migrateCanvasIR(
			structuredClone(readFixture("v2-with-unknown-keys")),
		);
		expect(ir.version).toBe("3");
	});

	it("rejects a malformed shape at the schema boundary", () => {
		expect(CanvasFrameShapeSchema.safeParse({ kind: "rect" }).success).toBe(
			true,
		);
		expect(
			CanvasFrameShapeSchema.safeParse({ kind: "polygon", sides: 2 }).success,
		).toBe(false);
		expect(CanvasFrameShapeSchema.safeParse({ kind: "blob" }).success).toBe(
			false,
		);
	});
});

describe("round-trip: parse -> serialize -> parse preserves mask state exactly", () => {
	for (const shape of EVERY_KIND) {
		it(`preserves \`${shape.kind}\``, () => {
			const source = makeIR([frame({ clip: true, shape, radius: 9 })]);
			const once = migrateCanvasIR(source);
			const twice = migrateCanvasIR(JSON.parse(JSON.stringify(once)));
			expect(twice).toEqual(once);

			const frameOf = (ir: CanvasIR): CanvasFrameNode => {
				const root = ir.pages[0]?.root;
				const node = root?.type === "group" ? root.children[0] : undefined;
				if (node?.type !== "frame") throw new Error("expected a frame");
				return node;
			};
			expect(frameOf(twice).shape).toEqual(shape);
			expect(resolveFrameClipShape(frameOf(twice))).toEqual(
				resolveFrameClipShape(frameOf(once)),
			);
		});
	}

	it("preserves an unknown key inside the shape across the round-trip", () => {
		const shape = {
			kind: "polygon",
			sides: 6,
			vendorHint: "keep me",
		} as unknown as CanvasFrameShape;
		const twice = migrateCanvasIR(
			JSON.parse(
				JSON.stringify(migrateCanvasIR(makeIR([frame({ clip: true, shape })]))),
			),
		);
		const root = twice.pages[0]?.root;
		const node = root?.type === "group" ? root.children[0] : undefined;
		expect(
			(node as CanvasFrameNode).shape as unknown as Record<string, unknown>,
		).toEqual({ kind: "polygon", sides: 6, vendorHint: "keep me" });
	});
});

describe("ADR 0008: radius = half the side already clips a square frame to a circle", () => {
	/**
	 * ADR 0008 decision 1 records this as free value nobody can find, and
	 * flags it as *derived from the emitted markup, not from an executed
	 * render*. This pins the half of it canvas-core can execute: the resolver's
	 * verdict, and the SVG the serializer actually produces. The Konva half —
	 * `CanvasRenderingContext2D.roundRect` scaling overlapping radii down
	 * proportionally — needs a browser and belongs to cp4-003's parity work.
	 */
	const SIDE = 200;

	it("resolves to a rectangle whose radius is exactly half the side", () => {
		const resolved = resolveFrameClipShape(
			frame({ clip: true, radius: SIDE / 2 }),
		);
		expect(resolved).toEqual({
			clipped: true,
			shape: { kind: "rect" },
			radius: SIDE / 2,
			source: "default",
		});
	});

	it("emits rx/ry equal to half the box, which SVG renders as a circle", async () => {
		const { svg } = await serializePageToSvg(
			makeIR([
				frame({
					id: "circle-well",
					clip: true,
					radius: SIDE / 2,
					bounds: { width: SIDE, height: SIDE },
				}),
			]),
			0,
		);
		expect(svg).toContain(
			`<clipPath id="frame-clip-circle-well"><rect width="${SIDE}" height="${SIDE}" rx="${SIDE / 2}" ry="${SIDE / 2}" /></clipPath>`,
		);
	});
});

/**
 * The `path` kind, whose "can this be honoured" question the resolver did NOT
 * own until defect D-1 forced the issue.
 *
 * D-1: the SVG emitter vetted path CHARACTERS (`PATH_D_RE`) and the Konva
 * renderer vetted path GEOMETRY (Konva's parser), so `d: "Z"` passed one and
 * failed the other — the export emitted an empty `<clipPath>` that erased the
 * frame's whole content while the stage drew it normally. `cp4-001` had left
 * both checks outside `ir/` because rank 1 could not import rank 5's regex;
 * both now live at rank 0 (`path-data.ts`) and BOTH are applied here, so no
 * renderer decides for itself any more.
 */
describe("resolveFrameClipShape — path clip vetting (D-1)", () => {
	const shaped = (d: string): CanvasFrameNode =>
		frame({ clip: true, shape: { kind: "path", d } });

	it("honours a path that describes real geometry", () => {
		const resolved = resolveFrameClipShape(shaped("M 100 0 L 200 100 Z"));
		expect(resolved.source).toBe("declared");
		expect(resolved.degradation).toBeUndefined();
		expect(resolved.shape).toEqual({
			kind: "path",
			d: "M 100 0 L 200 100 Z",
		});
	});

	it('degrades an UNDRAWABLE path ("Z") to the rectangle instead of an empty region', () => {
		const resolved = resolveFrameClipShape(shaped("Z"));
		expect(resolved).toMatchObject({
			clipped: true,
			shape: { kind: "rect" },
			source: "degraded",
			degradation: "invalid-shape-geometry",
		});
	});

	it("degrades every other shape of undrawable data the schema still admits", () => {
		// `CanvasFrameShapeSchema` requires only a non-empty `d`, so each of these
		// is a legal document reachable from an import, a template, AI output or a
		// peer.
		for (const d of ["M", "garbage", "M0 0 L10", "   "]) {
			expect(resolveFrameClipShape(shaped(d)).source, d).toBe("degraded");
		}
	});

	it("degrades HOSTILE data with its own reason, distinct from undrawable", () => {
		// Kept distinct because they are different authoring mistakes and the SVG
		// warning quotes the reason — "outside the allowed character set" must not
		// become "does not describe a real outline".
		const resolved = resolveFrameClipShape(shaped('M0 0" onload="alert(1)'));
		expect(resolved).toMatchObject({
			shape: { kind: "rect" },
			source: "degraded",
			degradation: "unsafe-path-data",
		});
	});

	it("carries the frame's OWN rounding into the degraded rectangle", () => {
		// This is what makes the two render paths agree on a degraded frame: SVG's
		// fallback is `frameBoxElement(node)` (the frame's own rounding) and
		// Konva's is the resolved rect, so the resolver has to supply it.
		const resolved = resolveFrameClipShape(
			frame({ clip: true, radius: 16, shape: { kind: "path", d: "Z" } }),
		);
		expect(resolved.radius).toBe(16);
	});

	it("still never throws — degradation is a rendering decision, not a failure", () => {
		expect(() =>
			resolveFrameClipShape(shaped(undefined as unknown as string)),
		).not.toThrow();
		expect(resolveFrameClipShape(shaped(undefined as unknown as string)).source).toBe(
			"degraded",
		);
	});
});

describe("SVG ↔ resolver agreement on a degraded path clip", () => {
	it("emits the frame box and warns, rather than an empty clip region", async () => {
		const { svg, warnings } = await serializePageToSvg(
			makeIR([
				frame({
					id: "undrawable",
					clip: true,
					shape: { kind: "path", d: "Z" },
					bounds: { width: 60, height: 40 },
				}),
			]),
			0,
		);
		expect(svg).toContain(
			'<clipPath id="frame-clip-undrawable"><rect width="60" height="40" /></clipPath>',
		);
		// The bug was that this was silent: `isValidPathD("Z")` is true, so nothing
		// on the SVG path knew the region it had just written was empty.
		const degraded = warnings.filter(
			(w) => w.code === "FRAME_CLIP_SHAPE_DEGRADED",
		);
		expect(degraded).toHaveLength(1);
		expect(degraded[0]?.message).toContain("does not describe a real outline");
	});
});
