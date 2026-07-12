import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { applyCommand } from "../commands/runtime.js";
import type { CanvasCommand } from "../commands/types.js";
import {
	type AffineMatrix,
	decomposeMatrix,
	invertMatrix,
	multiplyMatrix,
	toAffineMatrix,
} from "../geometry/affine.js";
import { screenToWorld, worldToScreen } from "../geometry/viewport.js";
import {
	createCanvasIR,
	createFrame,
	createPage,
	createPolygon,
	createRect,
	createRichText,
	createStar,
} from "../ir/builders.js";
import { insertNode } from "../ir/mutations.js";
import type {
	BrandTokenRef,
	CanvasFill,
	CanvasIR,
	CanvasTransform,
} from "../ir/types.js";
import { CanvasIRSchema } from "../ir/validators.js";
import { findNode } from "../ir/walkers.js";
import { serializePageToSvg } from "../serialize/svg.js";

/**
 * Property-based round-trip suite (canvas-m0-011 / FR-006). Invariants that
 * IR v2 and extension work silently depend on:
 *   1. decompose(toAffineMatrix(t)) ≈ t   (bounded, non-degenerate transforms)
 *   2. invert(m) · m ≈ identity
 *   3. screenToWorld ∘ worldToScreen ≈ id (zoom > 0)
 *   4. batch then composite-inverse ≡ original document
 *   5. a failing batch leaves the caller's document untouched
 *   6. rich-text paragraph arrays survive a batch + composite inverse
 *
 * Bounded runs keep suite time low; fast-check logs a seed + shrunken
 * counterexample on failure, which reproduces deterministically.
 */

const RUNS = { numRuns: 200 } as const;
const EPS = 1e-6;

// Non-degenerate transform: positive scales bounded away from 0 (a negative
// scale pair is indistinguishable from a rotation in decomposition), skewY
// omitted (the decomposer folds it into skewX by design).
const transformArb = fc.record({
	x: fc.double({ min: -1000, max: 1000, noNaN: true }),
	y: fc.double({ min: -1000, max: 1000, noNaN: true }),
	rotation: fc.double({ min: -179.9, max: 179.9, noNaN: true }),
	scaleX: fc.double({ min: 0.1, max: 10, noNaN: true }),
	scaleY: fc.double({ min: 0.1, max: 10, noNaN: true }),
	skewX: fc.double({ min: -60, max: 60, noNaN: true }),
}) satisfies fc.Arbitrary<CanvasTransform>;

function expectClose(actual: number, expected: number, eps = EPS): void {
	expect(Math.abs(actual - expected)).toBeLessThanOrEqual(
		eps * Math.max(1, Math.abs(expected)),
	);
}

describe("geometry round-trips (property)", () => {
	it("decomposeMatrix(toAffineMatrix(t)) ≈ t", () => {
		fc.assert(
			fc.property(transformArb, (t) => {
				const d = decomposeMatrix(toAffineMatrix(t));
				expectClose(d.x, t.x);
				expectClose(d.y, t.y);
				expectClose(d.rotation, t.rotation, 1e-5);
				expectClose(d.scaleX, t.scaleX, 1e-5);
				expectClose(d.scaleY, t.scaleY, 1e-5);
				expectClose(d.skewX, t.skewX ?? 0, 1e-5);
			}),
			RUNS,
		);
	});

	it("multiplyMatrix(invertMatrix(m), m) ≈ identity", () => {
		fc.assert(
			fc.property(transformArb, (t) => {
				const m = toAffineMatrix(t);
				const id = multiplyMatrix(invertMatrix(m), m);
				const identity: AffineMatrix = [1, 0, 0, 1, 0, 0];
				for (let i = 0; i < 6; i += 1) {
					expectClose(id[i] as number, identity[i] as number, 1e-5);
				}
			}),
			RUNS,
		);
	});

	it("screenToWorld(v, worldToScreen(v, p)) ≈ p for zoom > 0", () => {
		fc.assert(
			fc.property(
				fc.record({
					zoom: fc.double({ min: 0.1, max: 8, noNaN: true }),
					panX: fc.double({ min: -5000, max: 5000, noNaN: true }),
					panY: fc.double({ min: -5000, max: 5000, noNaN: true }),
				}),
				fc.record({
					x: fc.double({ min: -10000, max: 10000, noNaN: true }),
					y: fc.double({ min: -10000, max: 10000, noNaN: true }),
				}),
				(v, p) => {
					const round = screenToWorld(v, worldToScreen(v, p));
					expectClose(round.x, p.x, 1e-6);
					expectClose(round.y, p.y, 1e-6);
				},
			),
			RUNS,
		);
	});
});

const FIXED_TS = "2026-07-09T00:00:00.000Z";
const NOW = () => FIXED_TS;
const NODE_IDS = ["r0", "r1", "r2"] as const;

function baseIR(): CanvasIR {
	const page = createPage({ id: "p1" });
	let ir = createCanvasIR({
		id: "doc",
		title: "prop",
		pages: [page],
		now: NOW,
	});
	for (const [i, id] of NODE_IDS.entries()) {
		ir = insertNode(ir, {
			parentId: page.root.id,
			node: createRect({
				id,
				bounds: { width: 20 + i, height: 10 + i },
			}),
			now: NOW,
		});
	}
	return ir;
}

/**
 * Build a semantically-valid `node.move` sequence: each step's `from` is read
 * from the WORKING document (a `node.move` inverse depends on `from` being the
 * live position), then the step is applied to keep the next `from` honest.
 */
function buildMoveBatch(
	base: CanvasIR,
	steps: readonly { idx: number; dx: number; dy: number }[],
): { commands: CanvasCommand[]; expected: CanvasIR } {
	let working = base;
	const commands: CanvasCommand[] = [];
	for (const step of steps) {
		const nodeId = NODE_IDS[step.idx % NODE_IDS.length] as string;
		const found = findNode(working, nodeId);
		if (!found) throw new Error(`fixture node ${nodeId} missing`);
		const { x, y } = found.node.transform;
		const cmd: CanvasCommand = {
			type: "node.move",
			nodeId,
			from: { x, y },
			to: { x: x + step.dx, y: y + step.dy },
		};
		commands.push(cmd);
		working = applyCommand(working, cmd, { now: NOW }).ir;
	}
	return { commands, expected: working };
}

const stepsArb = fc.array(
	fc.record({
		idx: fc.integer({ min: 0, max: 2 }),
		dx: fc.integer({ min: -50, max: 50 }),
		dy: fc.integer({ min: -50, max: 50 }),
	}),
	{ minLength: 1, maxLength: 8 },
);

describe("batch transaction round-trips (property)", () => {
	it("apply batch then its composite inverse ≡ original document", () => {
		fc.assert(
			fc.property(stepsArb, (steps) => {
				const base = baseIR();
				const { commands, expected } = buildMoveBatch(base, steps);
				const applied = applyCommand(
					base,
					{ type: "batch", commands },
					{ now: NOW },
				);
				expect(applied.ir).toEqual(expected);
				const undone = applyCommand(applied.ir, applied.inverse, {
					now: NOW,
				});
				expect(undone.ir).toEqual(base);
			}),
			RUNS,
		);
	});

	it("a mid-batch failure propagates AND leaves the input document untouched", () => {
		fc.assert(
			fc.property(stepsArb, (steps) => {
				const base = baseIR();
				const snapshot = structuredClone(base);
				const { commands } = buildMoveBatch(base, steps);
				const poisoned: CanvasCommand[] = [
					...commands,
					{
						type: "node.move",
						nodeId: "no-such-node",
						from: { x: 0, y: 0 },
						to: { x: 1, y: 1 },
					},
				];
				expect(() =>
					applyCommand(
						base,
						{ type: "batch", commands: poisoned },
						{ now: NOW },
					),
				).toThrow();
				expect(base).toEqual(snapshot);
			}),
			{ numRuns: 50 },
		);
	});
});

/**
 * Property 6 — rich-text paragraph arrays survive a batch + composite inverse.
 *
 * `paragraphs` is the first ARRAY-valued patch key any built-in kind has, and
 * `node.update`'s inverse capture is a shallow, top-level key copy that stores a
 * *reference* to the prior array. That is only sound because the IR layer never
 * mutates in place. This property hammers that with randomly-shaped documents:
 * if any code path ever starts mutating a paragraph array instead of replacing
 * it, the composite inverse stops restoring the original and this goes red.
 */
const spanArb = fc.record(
	{
		text: fc.string({ maxLength: 12 }),
		fontSize: fc.option(fc.integer({ min: 1, max: 96 }), { nil: undefined }),
		italic: fc.option(fc.boolean(), { nil: undefined }),
		letterSpacing: fc.option(fc.integer({ min: -4, max: 8 }), {
			nil: undefined,
		}),
	},
	{ requiredKeys: ["text"] },
);

const paragraphsArb = fc.array(
	fc.record(
		{
			align: fc.option(fc.constantFrom("left", "center", "right"), {
				nil: undefined,
			}),
			spans: fc.array(spanArb, { maxLength: 4 }),
		},
		{ requiredKeys: ["spans"] },
	),
	{ maxLength: 4 },
);

function richBaseIR(): CanvasIR {
	const page = createPage({ id: "p1" });
	let ir = createCanvasIR({
		id: "doc",
		title: "prop-rich",
		pages: [page],
		now: NOW,
	});
	ir = insertNode(ir, {
		parentId: page.root.id,
		node: createRichText({
			id: "rt0",
			bounds: { width: 200, height: 60 },
			paragraphs: [{ spans: [{ text: "seed" }] }],
		}),
		now: NOW,
	});
	return ir;
}

describe("rich-text paragraph round-trips (property)", () => {
	it("a batch of paragraph edits, then its composite inverse, ≡ original", () => {
		fc.assert(
			fc.property(
				fc.array(paragraphsArb, { minLength: 1, maxLength: 5 }),
				(edits) => {
					const base = richBaseIR();
					const before = JSON.stringify(base);

					const commands: CanvasCommand[] = edits.map((paragraphs) => ({
						type: "node.update",
						nodeId: "rt0",
						kind: "rich-text",
						patch: { paragraphs },
					}));

					const applied = applyCommand(
						base,
						{ type: "batch", commands },
						{ now: NOW },
					);
					const undone = applyCommand(applied.ir, applied.inverse, {
						now: NOW,
					});

					expect(JSON.stringify(undone.ir)).toBe(before);
					// And the caller's document was never touched.
					expect(JSON.stringify(base)).toBe(before);
				},
			),
			RUNS,
		);
	});

	it("every intermediate paragraph document validates", () => {
		fc.assert(
			fc.property(paragraphsArb, (paragraphs) => {
				const applied = applyCommand(
					richBaseIR(),
					{
						type: "node.update",
						nodeId: "rt0",
						kind: "rich-text",
						patch: { paragraphs },
					},
					{ now: NOW },
				);
				expect(CanvasIRSchema.safeParse(applied.ir).success).toBe(true);
			}),
			RUNS,
		);
	});
});

/**
 * Property 7 — brand-token refs (canvas-m1-012) round-trip like any other
 * fill value: a `node.update` patch never special-cases `CanvasFill`'s third
 * member, so a token survives the same batch + composite-inverse machinery
 * `RichTextSpan.paragraphs` already proved works for an array-valued field.
 */
const brandTokenArb: fc.Arbitrary<BrandTokenRef> = fc.record({
	type: fc.constant("brand-token" as const),
	tokenType: fc.constantFrom("color", "font", "spacing", "asset", "logo"),
	id: fc
		.string({ minLength: 1, maxLength: 12 })
		.filter((s) => s.trim().length > 0),
});

const fillArb: fc.Arbitrary<CanvasFill> = fc.oneof(
	fc.constantFrom("#ff0000", "#00ff00", "#0000ff"),
	brandTokenArb,
);

function tokenBaseIR(): CanvasIR {
	const page = createPage({ id: "p1" });
	let ir = createCanvasIR({
		id: "doc",
		title: "prop-token",
		pages: [page],
		now: NOW,
	});
	ir = insertNode(ir, {
		parentId: page.root.id,
		node: createRect({ id: "rect0", bounds: { width: 50, height: 50 } }),
		now: NOW,
	});
	return ir;
}

describe("brand-token round-trips (property)", () => {
	it("a batch of fill edits (including brand-token refs), then its composite inverse, ≡ original", () => {
		fc.assert(
			fc.property(
				fc.array(fillArb, { minLength: 1, maxLength: 5 }),
				(edits) => {
					const base = tokenBaseIR();
					const before = JSON.stringify(base);

					const commands: CanvasCommand[] = edits.map((fill) => ({
						type: "node.update",
						nodeId: "rect0",
						kind: "rect",
						patch: { fill },
					}));

					const applied = applyCommand(
						base,
						{ type: "batch", commands },
						{ now: NOW },
					);
					const undone = applyCommand(applied.ir, applied.inverse, {
						now: NOW,
					});

					expect(JSON.stringify(undone.ir)).toBe(before);
					expect(JSON.stringify(base)).toBe(before);
				},
			),
			RUNS,
		);
	});

	it("every intermediate document (including brand-token fills) validates", () => {
		fc.assert(
			fc.property(fillArb, (fill) => {
				const applied = applyCommand(
					tokenBaseIR(),
					{
						type: "node.update",
						nodeId: "rect0",
						kind: "rect",
						patch: { fill },
					},
					{ now: NOW },
				);
				expect(CanvasIRSchema.safeParse(applied.ir).success).toBe(true);
			}),
			RUNS,
		);
	});

	it("a brand-token fill survives parse -> mutate -> serialize, and resolves via the injected resolver", async () => {
		const token: BrandTokenRef = {
			type: "brand-token",
			tokenType: "color",
			id: "brand.primary",
		};
		const mutated = applyCommand(
			tokenBaseIR(),
			{
				type: "node.update",
				nodeId: "rect0",
				kind: "rect",
				patch: { fill: token },
			},
			{ now: NOW },
		).ir;

		// Parse: the mutated document survives an untrusted JSON round-trip.
		const parsed = CanvasIRSchema.parse(JSON.parse(JSON.stringify(mutated)));
		const rect = findNode(parsed, "rect0")?.node;
		expect(rect?.type).toBe("rect");
		expect((rect as { fill?: unknown })?.fill).toEqual(token);

		// Serialize: resolves through the injected resolver, no warning.
		const { svg, warnings } = await serializePageToSvg(parsed, 0, {
			resolveBrandToken: (ref) =>
				ref.id === "brand.primary" ? "#abc123" : undefined,
		});
		expect(svg).toContain('fill="#abc123"');
		expect(warnings.map((w) => w.code)).not.toContain("BRAND_TOKEN_UNRESOLVED");
	});
});

/**
 * Property 8 — frame/polygon/star kind-specific fields (canvas-m1-010,
 * canvas-m1-002) round-trip through the same batch + composite-inverse
 * machinery Property 4 already proved for `rect`. Each of these three kinds
 * added its own node-specific patch keys (frame `clip`/`radius`, polygon
 * `sides`, star `points`/`innerRadiusRatio`) — this closes the M1 rollup gap
 * where only `rect`/`rich-text` fixtures were exercised.
 */
function kindFixtureIR(): CanvasIR {
	const page = createPage({ id: "p1" });
	let ir = createCanvasIR({
		id: "doc",
		title: "prop-kinds",
		pages: [page],
		now: NOW,
	});
	ir = insertNode(ir, {
		parentId: page.root.id,
		node: createFrame({ id: "frame0", bounds: { width: 100, height: 100 } }),
		now: NOW,
	});
	ir = insertNode(ir, {
		parentId: page.root.id,
		node: createPolygon({ id: "polygon0", bounds: { width: 40, height: 40 } }),
		now: NOW,
	});
	ir = insertNode(ir, {
		parentId: page.root.id,
		node: createStar({ id: "star0", bounds: { width: 40, height: 40 } }),
		now: NOW,
	});
	return ir;
}

const kindPatchArb: fc.Arbitrary<CanvasCommand> = fc.oneof(
	fc.record({
		type: fc.constant("node.update" as const),
		nodeId: fc.constant("frame0" as const),
		kind: fc.constant("frame" as const),
		patch: fc.record({
			clip: fc.boolean(),
			radius: fc.double({ min: 0, max: 64, noNaN: true }),
		}),
	}),
	fc.record({
		type: fc.constant("node.update" as const),
		nodeId: fc.constant("polygon0" as const),
		kind: fc.constant("polygon" as const),
		patch: fc.record({
			sides: fc.integer({ min: 3, max: 12 }),
		}),
	}),
	fc.record({
		type: fc.constant("node.update" as const),
		nodeId: fc.constant("star0" as const),
		kind: fc.constant("star" as const),
		patch: fc.record({
			points: fc.integer({ min: 3, max: 12 }),
			innerRadiusRatio: fc.double({ min: 0, max: 1, noNaN: true }),
		}),
	}),
) as fc.Arbitrary<CanvasCommand>;

describe("frame/polygon/star kind-field round-trips (property)", () => {
	it("a batch of kind-specific field edits, then its composite inverse, ≡ original", () => {
		fc.assert(
			fc.property(
				fc.array(kindPatchArb, { minLength: 1, maxLength: 6 }),
				(commands) => {
					const base = kindFixtureIR();
					const before = JSON.stringify(base);

					const applied = applyCommand(
						base,
						{ type: "batch", commands },
						{ now: NOW },
					);
					const undone = applyCommand(applied.ir, applied.inverse, {
						now: NOW,
					});

					expect(JSON.stringify(undone.ir)).toBe(before);
					expect(JSON.stringify(base)).toBe(before);
				},
			),
			RUNS,
		);
	});

	it("every intermediate document (frame/polygon/star fields) validates", () => {
		fc.assert(
			fc.property(kindPatchArb, (command) => {
				const applied = applyCommand(kindFixtureIR(), command, { now: NOW });
				expect(CanvasIRSchema.safeParse(applied.ir).success).toBe(true);
			}),
			RUNS,
		);
	});
});
