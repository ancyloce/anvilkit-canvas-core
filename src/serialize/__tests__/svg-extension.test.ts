import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
	type CanvasNodeKindDefinition,
	type CanvasUnknownNode,
	createNodeKindRegistry,
} from "../../extensions/node-kind-registry.js";
import { createCanvasIR, createPage } from "../../ir/builders.js";
import { insertNode } from "../../ir/mutations.js";
import type { CanvasIR } from "../../ir/types.js";
import { serializePageToSvg } from "../svg.js";

/**
 * Fake CUSTOM (non-built-in) extension kind. Named "pinwheel", not "star" —
 * "star" is now a real built-in kind (canvas-m1-010) with its own emitter, so
 * the dispatch switch would handle it before ever reaching the toSvg-hook /
 * unknown-kind-skip paths these tests exist to exercise.
 */
interface PinwheelNode extends CanvasUnknownNode {
	type: "pinwheel";
	points: number;
}

function makePinwheel(): PinwheelNode {
	return {
		id: "s1",
		type: "pinwheel",
		transform: { x: 5, y: 7, rotation: 0, scaleX: 1, scaleY: 1 },
		bounds: { width: 20, height: 20 },
		zIndex: 0,
		points: 5,
	};
}

const pinwheelDef: CanvasNodeKindDefinition<PinwheelNode> = {
	kind: "pinwheel",
	schema: z.any() as unknown as z.ZodType<PinwheelNode>,
	toSvg: (node, ctx) =>
		`<g data-pinwheel="${node.points}" ${ctx.commonAttrs(node)}></g>`,
};

function irWithPinwheel(): CanvasIR {
	const page = createPage({ id: "p1" });
	let ir = createCanvasIR({ id: "doc", title: "t", pages: [page] });
	ir = insertNode(ir, {
		parentId: page.root.id,
		node: makePinwheel() as never,
	});
	return ir;
}

describe("serializeDocumentToSvg — custom node kinds", () => {
	it("emits a custom kind via its registered toSvg hook", async () => {
		const reg = createNodeKindRegistry([pinwheelDef]);
		const { svg, warnings } = await serializePageToSvg(irWithPinwheel(), "p1", {
			nodeKinds: reg,
		});
		expect(svg).toContain('data-pinwheel="5"');
		expect(warnings).toHaveLength(0);
	});

	it("skips an unknown kind with a warning when no hook is registered", async () => {
		const { svg, warnings } = await serializePageToSvg(
			irWithPinwheel(),
			"p1",
			{},
		);
		expect(svg).not.toContain("data-pinwheel");
		expect(warnings.map((w) => w.code)).toContain("UNKNOWN_KIND_SKIPPED");
	});
});
