import { describe, expect, it } from "vitest";
import { createCanvasIR, createFrame, createPage } from "../../ir/builders.js";
import { insertNode } from "../../ir/mutations.js";
import type {
	CanvasFrameNode,
	CanvasFrameShape,
	CanvasIR,
} from "../../ir/types.js";
import { findNode } from "../../ir/walkers.js";
import { applyCommand } from "../runtime.js";
import type { CanvasCommand } from "../types.js";

/**
 * @file A `path` frame clip has to track its frame's box.
 *
 * Four of the five `CanvasFrameShape` kinds are derived from `bounds` at render
 * time, so they track a resize for free. `path` cannot be — its `d` is authored
 * in the frame's LOCAL units — so before this, picking the `path` shape on a
 * 200x200 frame and resizing it to 400x400 left a 200-unit mask in the
 * top-left quadrant and clipped away the other three quarters of the frame's
 * own content.
 *
 * The rewrite lives in the COMMAND layer rather than in the editor's transform
 * handler because every resize passes through here: the transformer, keyboard
 * nudges, the inspector's size fields, a collab peer and a host script. Fixing
 * it at one editor call site would have left the others desynced.
 */

/** The picker's seeded diamond for a 200x200 frame. */
const DIAMOND = "M 100 0 L 200 100 L 100 200 L 0 100 Z";

function irWith(shape: CanvasFrameShape | undefined): CanvasIR {
	const page = createPage({ id: "p1" });
	const ir = createCanvasIR({ id: "doc", title: "t", pages: [page] });
	return insertNode(ir, {
		parentId: page.root.id,
		node: {
			...createFrame({ id: "f1", bounds: { width: 200, height: 200 } }),
			clip: true,
			...(shape ? { shape } : {}),
		},
	});
}

function shapeOf(ir: CanvasIR, id = "f1"): CanvasFrameShape | undefined {
	return (findNode(ir, id)?.node as CanvasFrameNode | undefined)?.shape;
}

const resizeTo = (width: number, height: number): CanvasCommand => ({
	type: "node.resize",
	nodeId: "f1",
	from: { x: 0, y: 0, width: 200, height: 200 },
	to: { x: 0, y: 0, width, height },
});

describe("node.resize rescales a path clip with the frame", () => {
	it("scales the mask by the same factors as the box", () => {
		const result = applyCommand(
			irWith({ kind: "path", d: DIAMOND }),
			resizeTo(400, 400),
		);
		expect(shapeOf(result.ir)).toEqual({
			kind: "path",
			d: "M 200 0 L 400 200 L 200 400 L 0 200 Z",
		});
	});

	it("scales each axis independently", () => {
		const result = applyCommand(
			irWith({ kind: "path", d: DIAMOND }),
			resizeTo(400, 100),
		);
		expect(shapeOf(result.ir)).toEqual({
			kind: "path",
			d: "M 200 0 L 400 50 L 200 100 L 0 50 Z",
		});
	});

	it("undo restores the EXACT prior path, not a scaled-back approximation", () => {
		// `k` then `1/k` is not exactly 1 in floating point, so the inverse
		// restores the original string rather than trusting the round trip.
		const before = irWith({ kind: "path", d: DIAMOND });
		const resized = applyCommand(before, resizeTo(300, 700));
		expect(shapeOf(resized.ir)).not.toEqual({ kind: "path", d: DIAMOND });

		const undone = applyCommand(resized.ir, resized.inverse);
		expect(shapeOf(undone.ir)).toEqual({ kind: "path", d: DIAMOND });
		const frame = findNode(undone.ir, "f1")?.node as CanvasFrameNode;
		expect(frame.bounds).toEqual({ width: 200, height: 200 });
	});

	it("leaves the other four kinds alone — they derive from bounds already", () => {
		for (const shape of [
			{ kind: "rect" },
			{ kind: "ellipse" },
			{ kind: "polygon", sides: 6 },
			{ kind: "star", points: 5, innerRadiusRatio: 0.5 },
		] as CanvasFrameShape[]) {
			const result = applyCommand(irWith(shape), resizeTo(400, 400));
			expect(shapeOf(result.ir), shape.kind).toEqual(shape);
			// And the inverse stays the plain `node.resize` it always was.
			expect(result.inverse.type).toBe("node.resize");
		}
	});

	it("leaves an unshaped frame alone, inverse included", () => {
		const result = applyCommand(irWith(undefined), resizeTo(400, 400));
		expect(shapeOf(result.ir)).toBeUndefined();
		expect(result.inverse.type).toBe("node.resize");
	});
});

describe("node.update rescales a path clip when it resizes the frame", () => {
	// The inspector's size fields, the auto-layout branch of the editor's
	// transform commit, and auto-layout reflow all resize through `node.update`
	// rather than `node.resize`.
	const update = (patch: Record<string, unknown>): CanvasCommand =>
		({
			type: "node.update",
			nodeId: "f1",
			kind: "frame",
			patch,
		}) as CanvasCommand;

	it("scales the mask when the patch carries new bounds", () => {
		const result = applyCommand(
			irWith({ kind: "path", d: DIAMOND }),
			update({ bounds: { width: 400, height: 400 } }),
		);
		expect(shapeOf(result.ir)).toEqual({
			kind: "path",
			d: "M 200 0 L 400 200 L 200 400 L 0 200 Z",
		});
	});

	it("undo restores the exact prior path", () => {
		const before = irWith({ kind: "path", d: DIAMOND });
		const resized = applyCommand(
			before,
			update({ bounds: { width: 333, height: 777 } }),
		);
		const undone = applyCommand(resized.ir, resized.inverse);
		expect(shapeOf(undone.ir)).toEqual({ kind: "path", d: DIAMOND });
	});

	it("never second-guesses a patch that authors the shape itself", () => {
		// Setting `shape` and `bounds` together is a deliberate authoring act —
		// the picker seeding a fresh diamond for the new box, for instance.
		const result = applyCommand(
			irWith({ kind: "path", d: DIAMOND }),
			update({
				bounds: { width: 400, height: 400 },
				shape: { kind: "path", d: "M 0 0 L 10 10 Z" },
			}),
		);
		expect(shapeOf(result.ir)).toEqual({
			kind: "path",
			d: "M 0 0 L 10 10 Z",
		});
	});

	it("leaves a patch that does not touch bounds alone", () => {
		const result = applyCommand(
			irWith({ kind: "path", d: DIAMOND }),
			update({ clip: false }),
		);
		expect(shapeOf(result.ir)).toEqual({ kind: "path", d: DIAMOND });
	});

	it("refuses to rewrite path data it cannot parse, rather than half-scaling it", () => {
		const result = applyCommand(
			irWith({ kind: "path", d: "garbage" }),
			update({ bounds: { width: 400, height: 400 } }),
		);
		expect(shapeOf(result.ir)).toEqual({ kind: "path", d: "garbage" });
	});
});
