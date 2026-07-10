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

interface StarNode extends CanvasUnknownNode {
	type: "star";
	points: number;
}

function makeStar(): StarNode {
	return {
		id: "s1",
		type: "star",
		transform: { x: 5, y: 7, rotation: 0, scaleX: 1, scaleY: 1 },
		bounds: { width: 20, height: 20 },
		zIndex: 0,
		points: 5,
	};
}

const starDef: CanvasNodeKindDefinition<StarNode> = {
	kind: "star",
	schema: z.any() as unknown as z.ZodType<StarNode>,
	toSvg: (node, ctx) =>
		`<g data-star="${node.points}" ${ctx.commonAttrs(node)}></g>`,
};

function irWithStar(): CanvasIR {
	const page = createPage({ id: "p1" });
	let ir = createCanvasIR({ id: "doc", title: "t", pages: [page] });
	ir = insertNode(ir, { parentId: page.root.id, node: makeStar() as never });
	return ir;
}

describe("serializeDocumentToSvg — custom node kinds", () => {
	it("emits a custom kind via its registered toSvg hook", async () => {
		const reg = createNodeKindRegistry([starDef]);
		const { svg, warnings } = await serializePageToSvg(irWithStar(), "p1", {
			nodeKinds: reg,
		});
		expect(svg).toContain('data-star="5"');
		expect(warnings).toHaveLength(0);
	});

	it("skips an unknown kind with a warning when no hook is registered", async () => {
		const { svg, warnings } = await serializePageToSvg(irWithStar(), "p1", {});
		expect(svg).not.toContain("data-star");
		expect(warnings.map((w) => w.code)).toContain("UNKNOWN_KIND_SKIPPED");
	});
});
