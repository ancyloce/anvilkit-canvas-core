import { describe, expect, it } from "vitest";
import {
	createCanvasIR,
	createFrame,
	createPage,
	createRect,
	createText,
} from "../../ir/builders.js";
import { insertNode } from "../../ir/mutations.js";
import type {
	CanvasIR,
	CanvasLayoutAlign,
	CanvasLayoutDirection,
	CanvasLayoutPositioning,
	CanvasLayoutSizing,
	CanvasNode,
} from "../../ir/types.js";
import type { MeasuredText, TextMeasureRequest } from "../../text-contracts.js";
import { axisFor } from "../axis.js";
import { resolveCanvasLayout } from "../resolve.js";
import type { CanvasResolvedDocument } from "../types.js";
import { toResolvedNodeId } from "../types.js";

/**
 * @file T-M2-10 — property and combination suites (TS-07, TS-08, TS-14, TS-16..18).
 *
 * Generation is **seeded and deterministic**, never `Math.random`: a property
 * test that fails one run in fifty and passes on re-run teaches nothing, and a
 * shrinking library is a new runtime dependency this package will not take.
 * The generator below is a plain LCG, so a failure is reproducible from its
 * seed alone.
 */

const DIRECTIONS: readonly CanvasLayoutDirection[] = ["horizontal", "vertical"];
const ALIGNS: readonly CanvasLayoutAlign[] = ["start", "center", "end"];
const SIZINGS: readonly CanvasLayoutSizing[] = ["fixed", "hug", "fill"];
const POSITIONINGS: readonly CanvasLayoutPositioning[] = ["flow", "absolute"];

/** Deterministic 32-bit LCG (Numerical Recipes constants). */
function lcg(seed: number): () => number {
	let state = seed >>> 0;
	return () => {
		state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
		return state / 0x1_0000_0000;
	};
}

const measurer = (request: TextMeasureRequest): MeasuredText => {
	let chars = 0;
	for (const p of request.paragraphs) {
		for (const s of p.spans) chars += s.text.length;
	}
	return { lines: [], width: chars * 7, height: 19 };
};

function docOf(children: CanvasNode[]): CanvasIR {
	const page = createPage({ id: "p1" });
	let ir = createCanvasIR({ id: "doc", title: "t", pages: [page] });
	for (const child of children) {
		ir = insertNode(ir, { parentId: page.root.id, node: child });
	}
	return ir;
}

function resolve(ir: CanvasIR): CanvasResolvedDocument {
	return resolveCanvasLayout(ir, { measurement: { measureText: measurer } });
}

/** Every numeric the resolver emits, for the finiteness property. */
function assertSaneGeometry(resolved: CanvasResolvedDocument, label: string) {
	// Non-vacuity guard. A generator that produced an empty document, or a
	// resolver that returned no records, would make every assertion below pass
	// by iterating nothing — which is the failure mode a sweep of 400 seeds is
	// least likely to reveal on its own.
	expect(resolved.records.size, `${label} produced no records`).toBeGreaterThan(
		0,
	);
	for (const record of resolved.records.values()) {
		const { bounds, localTransform, worldTransform, worldAabb } =
			record.geometry;
		const where = `${label}/${record.sourceNodeId}`;
		for (const [name, value] of Object.entries({
			width: bounds.width,
			height: bounds.height,
			x: localTransform.x,
			y: localTransform.y,
			rotation: localTransform.rotation,
			scaleX: localTransform.scaleX,
			scaleY: localTransform.scaleY,
		})) {
			expect(Number.isFinite(value), `${where}.${name} = ${value}`).toBe(true);
		}
		expect(bounds.width, `${where}.width`).toBeGreaterThanOrEqual(0);
		expect(bounds.height, `${where}.height`).toBeGreaterThanOrEqual(0);
		for (const value of worldTransform) {
			expect(Number.isFinite(value), `${where}.worldTransform`).toBe(true);
		}
		for (const value of [
			worldAabb.minX,
			worldAabb.minY,
			worldAabb.maxX,
			worldAabb.maxY,
		]) {
			expect(Number.isFinite(value), `${where}.worldAabb`).toBe(true);
		}
	}
}

describe("TS-07 — no NaN, Infinity or negative bound for any generated input", () => {
	it("holds across 400 seeded random documents", () => {
		for (let seed = 1; seed <= 400; seed++) {
			const rand = lcg(seed);
			const pick = <T>(list: readonly T[]): T =>
				list[Math.floor(rand() * list.length)] as T;
			// Deliberately hostile magnitudes: zero and near-zero containers, huge
			// children, huge gaps and padding that alone exceed the container.
			const size = () =>
				[0, 0.0001, 1, 40, 500, 9_999][Math.floor(rand() * 6)] as number;

			const childCount = Math.floor(rand() * 5);
			const children: CanvasNode[] = [];
			for (let i = 0; i < childCount; i++) {
				children.push({
					...createRect({
						id: `c${i}`,
						bounds: { width: size(), height: size() },
					}),
					transform: {
						x: rand() * 100 - 50,
						y: rand() * 100 - 50,
						rotation: rand() * 720 - 360,
						scaleX: rand() * 4,
						scaleY: rand() * 4,
						skewX: rand() * 2 - 1,
					},
					layoutItem: {
						positioning: pick(POSITIONINGS),
						widthSizing: pick(SIZINGS),
						heightSizing: pick(SIZINGS),
					},
				} as CanvasNode);
			}

			const ir = docOf([
				{
					...createFrame({
						id: "f",
						bounds: { width: size(), height: size() },
					}),
					autoLayout: {
						version: 1,
						direction: pick(DIRECTIONS),
						padding: {
							top: rand() * 200,
							right: rand() * 200,
							bottom: rand() * 200,
							left: rand() * 200,
						},
						gap: rand() * 300,
						primaryAlign: pick(ALIGNS),
						crossAlign: pick(ALIGNS),
					},
					layoutItem: {
						widthSizing: pick(SIZINGS),
						heightSizing: pick(SIZINGS),
					},
					children,
				} as CanvasNode,
			]);

			assertSaneGeometry(resolve(ir), `seed ${seed}`);
		}
	});

	it("holds for a zero-size container with Fill children", () => {
		const ir = docOf([
			{
				...createFrame({ id: "f", bounds: { width: 0, height: 0 } }),
				autoLayout: {
					version: 1,
					direction: "horizontal",
					padding: { top: 0, right: 0, bottom: 0, left: 0 },
					gap: 0,
					primaryAlign: "start",
					crossAlign: "start",
				},
				children: [
					{
						...createRect({ id: "a", bounds: { width: 10, height: 10 } }),
						layoutItem: { widthSizing: "fill", heightSizing: "fill" },
					} as CanvasNode,
				],
			} as CanvasNode,
		]);
		const resolved = resolve(ir);

		assertSaneGeometry(resolved, "zero-container");
		expect(
			resolved.records.get(toResolvedNodeId("a"))?.geometry.bounds,
		).toEqual({ width: 0, height: 0 });
	});
});

describe("TS-08 — the footprint invariant", () => {
	/**
	 * For every layout-controlled axis, the resolved footprint extent equals
	 * the size the solver allocated. Checked here for Fill children, where the
	 * allocation is knowable independently: the container's inner size.
	 */
	const transforms = [
		{ label: "identity", rotation: 0, scaleX: 1, scaleY: 1 },
		{ label: "scaled", rotation: 0, scaleX: 2.5, scaleY: 0.4 },
		{ label: "rotated", rotation: 37, scaleX: 1, scaleY: 1 },
		{ label: "skewed", rotation: 0, scaleX: 1, scaleY: 1, skewX: 0.35 },
		{ label: "scaled+skewed", rotation: 0, scaleX: 1.7, scaleY: 1, skewY: 0.2 },
	];

	for (const direction of DIRECTIONS) {
		for (const t of transforms) {
			it(`holds for a ${t.label} single Fill child (${direction})`, () => {
				const axis = axisFor(direction);
				const frameBounds = { width: 320, height: 320 };
				const pad = 20;
				const ir = docOf([
					{
						...createFrame({ id: "f", bounds: frameBounds }),
						autoLayout: {
							version: 1,
							direction,
							padding: { top: pad, right: pad, bottom: pad, left: pad },
							gap: 0,
							primaryAlign: "start",
							crossAlign: "start",
						},
						children: [
							{
								...createRect({
									id: "a",
									bounds: { width: 60, height: 60 },
								}),
								transform: {
									x: 0,
									y: 0,
									rotation: t.rotation,
									scaleX: t.scaleX,
									scaleY: t.scaleY,
									...(t.skewX ? { skewX: t.skewX } : {}),
									...(t.skewY ? { skewY: t.skewY } : {}),
								},
								layoutItem: { widthSizing: "fill", heightSizing: "fill" },
							} as CanvasNode,
						],
					} as CanvasNode,
				]);

				const geometry = resolve(ir).records.get(
					toResolvedNodeId("a"),
				)?.geometry;
				if (!geometry) throw new Error("child was not resolved");
				const inner = axis.mainSize(frameBounds) - 2 * pad;

				expect(axis.mainExtent(geometry.layoutFootprint)).toBeCloseTo(inner, 3);
				// Rotation and skew survive normalisation; only scale is reset on a
				// layout-controlled axis.
				expect(geometry.localTransform.rotation).toBe(t.rotation);
				expect(geometry.localTransform.skewX ?? 0).toBe(t.skewX ?? 0);
				expect(geometry.localTransform.scaleX).toBe(1);
				expect(geometry.localTransform.scaleY).toBe(1);
			});
		}
	}

	it("leaves scale alone on an axis layout does not own", () => {
		const ir = docOf([
			{
				...createFrame({ id: "f", bounds: { width: 300, height: 300 } }),
				autoLayout: {
					version: 1,
					direction: "horizontal",
					padding: { top: 0, right: 0, bottom: 0, left: 0 },
					gap: 0,
					primaryAlign: "start",
					crossAlign: "start",
				},
				children: [
					{
						...createRect({ id: "a", bounds: { width: 50, height: 50 } }),
						transform: { x: 0, y: 0, rotation: 0, scaleX: 3, scaleY: 4 },
						layoutItem: { widthSizing: "fill" },
					} as CanvasNode,
				],
			} as CanvasNode,
		]);
		const geometry = resolve(ir).records.get(toResolvedNodeId("a"))?.geometry;

		expect(geometry?.localTransform.scaleX).toBe(1);
		// Height is Fixed here, so its scale is untouched and its footprint is
		// still 50 x 4.
		expect(geometry?.localTransform.scaleY).toBe(4);
		expect(
			(geometry?.layoutFootprint.maxY ?? 0) -
				(geometry?.layoutFootprint.minY ?? 0),
		).toBeCloseTo(200, 3);
	});
});

describe("TS-16/TS-18 — the full combination matrix", () => {
	function build(
		direction: CanvasLayoutDirection,
		primaryAlign: CanvasLayoutAlign,
		crossAlign: CanvasLayoutAlign,
		widthSizing: CanvasLayoutSizing,
		heightSizing: CanvasLayoutSizing,
		positioning: CanvasLayoutPositioning,
	): CanvasIR {
		return docOf([
			{
				...createFrame({ id: "f", bounds: { width: 240, height: 180 } }),
				autoLayout: {
					version: 1,
					direction,
					padding: { top: 6, right: 7, bottom: 8, left: 9 },
					gap: 11,
					primaryAlign,
					crossAlign,
				},
				children: [
					{
						...createRect({ id: "a", bounds: { width: 30, height: 20 } }),
						layoutItem: { positioning, widthSizing, heightSizing },
					} as CanvasNode,
					{
						...createText({
							id: "b",
							text: "matrix",
							bounds: { width: 30, height: 20 },
						}),
						layoutItem: { widthSizing: "hug", heightSizing: "hug" },
					} as CanvasNode,
					createRect({ id: "c", bounds: { width: 30, height: 20 } }),
				],
			} as CanvasNode,
		]);
	}

	it("resolves every direction × align × align × sizing × sizing × positioning", () => {
		let combinations = 0;
		for (const direction of DIRECTIONS) {
			for (const primaryAlign of ALIGNS) {
				for (const crossAlign of ALIGNS) {
					for (const widthSizing of SIZINGS) {
						for (const heightSizing of SIZINGS) {
							for (const positioning of POSITIONINGS) {
								combinations++;
								const label = [
									direction,
									primaryAlign,
									crossAlign,
									widthSizing,
									heightSizing,
									positioning,
								].join("/");
								const resolved = resolve(
									build(
										direction,
										primaryAlign,
										crossAlign,
										widthSizing,
										heightSizing,
										positioning,
									),
								);
								assertSaneGeometry(resolved, label);
								// Every child is present in the resolved tree regardless of
								// how it is positioned — an Absolute child must stay
								// reachable, which is what keeps it selectable in the
								// layer tree (§7.6).
								for (const id of ["a", "b", "c"]) {
									expect(
										resolved.records.has(toResolvedNodeId(id)),
										`${label} missing ${id}`,
									).toBe(true);
								}
							}
						}
					}
				}
			}
		}
		// 2 x 3 x 3 x 3 x 3 x 2
		expect(combinations).toBe(324);
	});

	it("resolves a vertical fixture as the transpose of its horizontal twin", () => {
		// TS-16 at fixture level. The adapter half is asserted in axis.test.ts;
		// this is the claim that the SOLVER contains no direction branch either.
		const square = (id: string) =>
			createRect({ id, bounds: { width: 40, height: 40 } });
		const make = (direction: CanvasLayoutDirection, align: CanvasLayoutAlign) =>
			docOf([
				{
					...createFrame({ id: "f", bounds: { width: 200, height: 200 } }),
					autoLayout: {
						version: 1,
						direction,
						padding:
							direction === "horizontal"
								? { top: 3, right: 4, bottom: 5, left: 6 }
								: // insets rotated a quarter turn
									{ top: 6, right: 5, bottom: 4, left: 3 },
						gap: 9,
						primaryAlign: align,
						crossAlign: "start",
					},
					children: [square("a"), square("b")],
				} as CanvasNode,
			]);

		for (const align of ALIGNS) {
			const h = resolve(make("horizontal", align));
			const v = resolve(make("vertical", align));
			for (const id of ["a", "b"]) {
				const hg = h.records.get(toResolvedNodeId(id))?.geometry.localTransform;
				const vg = v.records.get(toResolvedNodeId(id))?.geometry.localTransform;
				expect(vg?.y, `${align}/${id}.y`).toBeCloseTo(hg?.x ?? -1, 6);
				expect(vg?.x, `${align}/${id}.x`).toBeCloseTo(hg?.y ?? -1, 6);
			}
		}
	});
});

describe("TS-14 — precision stability", () => {
	it("produces bit-identical output across repeated runs of a lossy layout", () => {
		// Fill division and Center alignment are the two inherently lossy steps
		// (§6.1); 7 children over 200px is deliberately non-terminating in
		// binary.
		const children: CanvasNode[] = [];
		for (let i = 0; i < 7; i++) {
			children.push({
				...createRect({ id: `c${i}`, bounds: { width: 3, height: 3 } }),
				layoutItem: { widthSizing: "fill", heightSizing: "fill" },
			} as CanvasNode);
		}
		const ir = docOf([
			{
				...createFrame({ id: "f", bounds: { width: 200, height: 100 } }),
				autoLayout: {
					version: 1,
					direction: "horizontal",
					padding: { top: 1, right: 1, bottom: 1, left: 1 },
					gap: 3,
					primaryAlign: "center",
					crossAlign: "center",
				},
				children,
			} as CanvasNode,
		]);

		const first = resolve(ir);
		const serialize = (doc: CanvasResolvedDocument) =>
			JSON.stringify(
				[...doc.records.entries()].map(([id, r]) => [id, r.geometry]),
			);
		const baseline = serialize(first);
		for (let i = 0; i < 8; i++) {
			expect(serialize(resolve(ir))).toBe(baseline);
		}
	});

	it("quantises every emitted coordinate to the 1e-4 grid", () => {
		const ir = docOf([
			{
				...createFrame({ id: "f", bounds: { width: 100, height: 100 } }),
				autoLayout: {
					version: 1,
					direction: "horizontal",
					padding: { top: 0, right: 0, bottom: 0, left: 0 },
					gap: 0,
					primaryAlign: "center",
					crossAlign: "center",
				},
				children: [
					createRect({ id: "a", bounds: { width: 33, height: 33 } }),
					createRect({ id: "b", bounds: { width: 33, height: 33 } }),
					createRect({ id: "c", bounds: { width: 33, height: 33 } }),
				],
			} as CanvasNode,
		]);

		for (const record of resolve(ir).records.values()) {
			for (const value of [
				record.geometry.localTransform.x,
				record.geometry.localTransform.y,
				record.geometry.bounds.width,
				record.geometry.bounds.height,
			]) {
				// On the grid means `value * 10000` is an integer.
				expect(
					Number.isInteger(Math.round(value * 10_000 * 1e6) / 1e6),
					`${record.sourceNodeId}: ${value}`,
				).toBe(true);
			}
		}
	});
});

describe("TS-17 — convergence bound", () => {
	it("sizes each node at most twice, however deeply Hug and Fill nest", () => {
		// §7.8 bounds a pass at two sizings per node. The observable proxy: the
		// pass terminates and produces sane geometry for a chain that alternates
		// Hug and Fill all the way down, which is the shape that would otherwise
		// iterate.
		let inner: CanvasNode = createText({
			id: "leaf",
			text: "converge",
			bounds: { width: 20, height: 10 },
		}) as CanvasNode;
		for (let i = 0; i < 10; i++) {
			inner = {
				...createFrame({ id: `f${i}`, bounds: { width: 300, height: 300 } }),
				autoLayout: {
					version: 1,
					direction: i % 2 === 0 ? "horizontal" : "vertical",
					padding: { top: 2, right: 2, bottom: 2, left: 2 },
					gap: 2,
					primaryAlign: "start",
					crossAlign: "start",
				},
				layoutItem:
					i % 2 === 0
						? { widthSizing: "hug", heightSizing: "hug" }
						: { widthSizing: "fill", heightSizing: "fill" },
				children: [inner],
			} as CanvasNode;
		}

		const started = Date.now();
		const resolved = resolve(docOf([inner]));

		assertSaneGeometry(resolved, "hug/fill chain");
		expect(resolved.records.size).toBeGreaterThan(10);
		expect(Date.now() - started).toBeLessThan(1_000);
	});
});
