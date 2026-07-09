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
} from "../geometry.js";
import { createCanvasIR, createPage, createRect } from "../ir-builders.js";
import { insertNode } from "../ir-mutations.js";
import { findNode } from "../ir-walkers.js";
import type { CanvasIR, CanvasTransform } from "../types.js";
import { screenToWorld, worldToScreen } from "../viewport.js";

/**
 * Property-based round-trip suite (canvas-m0-011 / FR-006). Invariants that
 * IR v2 and extension work silently depend on:
 *   1. decompose(toAffineMatrix(t)) ≈ t   (bounded, non-degenerate transforms)
 *   2. invert(m) · m ≈ identity
 *   3. screenToWorld ∘ worldToScreen ≈ id (zoom > 0)
 *   4. batch then composite-inverse ≡ original document
 *   5. a failing batch leaves the caller's document untouched
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
