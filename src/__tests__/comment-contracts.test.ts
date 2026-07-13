import { describe, expect, it } from "vitest";
import { applyCommand } from "../commands/runtime.js";
import {
	type CanvasCommentAnchor,
	CanvasCommentAnchorSchema,
	resolveCommentAnchor,
} from "../comment-contracts.js";
import { createCanvasIR, createPage, createRect } from "../ir/builders.js";
import { insertNode } from "../ir/mutations.js";
import type { CanvasIR } from "../ir/types.js";

function makeIR(): { ir: CanvasIR; pageId: string } {
	const page = createPage({ id: "p1" });
	let ir = createCanvasIR({ id: "doc", title: "t", pages: [page] });
	const rect = createRect({
		id: "r1",
		bounds: { width: 10, height: 10 },
		transform: { x: 0, y: 0 },
	});
	ir = insertNode(ir, { parentId: page.root.id, node: rect });
	return { ir, pageId: page.id };
}

describe("CanvasCommentAnchorSchema", () => {
	it("validates each of the four anchor kinds", () => {
		const anchors: CanvasCommentAnchor[] = [
			{ kind: "page", version: "1", pageId: "p1" },
			{ kind: "node", version: "1", pageId: "p1", nodeId: "r1" },
			{ kind: "coordinate", version: "1", pageId: "p1", x: 5, y: 12 },
			{
				kind: "selection",
				version: "1",
				pageId: "p1",
				nodeIds: ["r1", "r2"],
			},
		];
		for (const anchor of anchors) {
			expect(CanvasCommentAnchorSchema.parse(anchor)).toEqual(anchor);
		}
	});

	it("rejects an unknown kind and a missing version", () => {
		expect(() =>
			CanvasCommentAnchorSchema.parse({ kind: "unknown", pageId: "p1" }),
		).toThrow();
		expect(() =>
			CanvasCommentAnchorSchema.parse({ kind: "page", pageId: "p1" }),
		).toThrow();
	});
});

describe("resolveCommentAnchor", () => {
	it("resolves page/coordinate anchors as active while the page exists", () => {
		const { ir } = makeIR();
		expect(
			resolveCommentAnchor({ kind: "page", version: "1", pageId: "p1" }, ir),
		).toEqual({ status: "active" });
		expect(
			resolveCommentAnchor(
				{ kind: "coordinate", version: "1", pageId: "p1", x: 1, y: 1 },
				ir,
			),
		).toEqual({ status: "active" });
	});

	it("archives any anchor kind when the page no longer exists", () => {
		const { ir } = makeIR();
		const anchor: CanvasCommentAnchor = {
			kind: "node",
			version: "1",
			pageId: "ghost-page",
			nodeId: "r1",
		};
		expect(resolveCommentAnchor(anchor, ir)).toEqual({
			status: "archived",
			reason: "page-deleted",
		});
	});

	it("a node anchor survives a move/transform command (keyed by stable id, not position)", () => {
		const { ir: ir0 } = makeIR();
		const { ir: ir1 } = applyCommand(ir0, {
			type: "node.move",
			nodeId: "r1",
			from: { x: 0, y: 0 },
			to: { x: 500, y: 500 },
		});
		const anchor: CanvasCommentAnchor = {
			kind: "node",
			version: "1",
			pageId: "p1",
			nodeId: "r1",
		};
		expect(resolveCommentAnchor(anchor, ir1)).toEqual({ status: "active" });
	});

	it("a node anchor resolves to archived when its target node is deleted", () => {
		const { ir: ir0 } = makeIR();
		const { ir: ir1 } = applyCommand(ir0, {
			type: "node.delete",
			nodeId: "r1",
		});
		const anchor: CanvasCommentAnchor = {
			kind: "node",
			version: "1",
			pageId: "p1",
			nodeId: "r1",
		};
		expect(resolveCommentAnchor(anchor, ir1)).toEqual({
			status: "archived",
			reason: "node-deleted",
		});
	});

	it("clone rule: an anchor on the source node is unaffected by a clone's existence", () => {
		const { ir: ir0 } = makeIR();
		const clone = createRect({
			id: "r1-clone",
			bounds: { width: 10, height: 10 },
			transform: { x: 20, y: 20 },
		});
		const { ir: ir1 } = applyCommand(ir0, {
			type: "node.create",
			node: clone,
			pageId: "p1",
		});
		const anchorOnSource: CanvasCommentAnchor = {
			kind: "node",
			version: "1",
			pageId: "p1",
			nodeId: "r1",
		};
		expect(resolveCommentAnchor(anchorOnSource, ir1)).toEqual({
			status: "active",
		});

		// Deleting the clone must not archive the anchor on the source.
		const { ir: ir2 } = applyCommand(ir1, {
			type: "node.delete",
			nodeId: "r1-clone",
		});
		expect(resolveCommentAnchor(anchorOnSource, ir2)).toEqual({
			status: "active",
		});
	});

	it("selection anchor: active with missingNodeIds when some but not all targets are gone", () => {
		const { ir: ir0 } = makeIR();
		const second = createRect({
			id: "r2",
			bounds: { width: 5, height: 5 },
			transform: { x: 30, y: 30 },
		});
		const { ir: ir1 } = applyCommand(ir0, {
			type: "node.create",
			node: second,
			pageId: "p1",
		});
		const { ir: ir2 } = applyCommand(ir1, {
			type: "node.delete",
			nodeId: "r2",
		});
		const anchor: CanvasCommentAnchor = {
			kind: "selection",
			version: "1",
			pageId: "p1",
			nodeIds: ["r1", "r2"],
		};
		expect(resolveCommentAnchor(anchor, ir2)).toEqual({
			status: "active",
			missingNodeIds: ["r2"],
		});
	});

	it("selection anchor archives only once every referenced node is gone", () => {
		const { ir: ir0 } = makeIR();
		const { ir: ir1 } = applyCommand(ir0, {
			type: "node.delete",
			nodeId: "r1",
		});
		const anchor: CanvasCommentAnchor = {
			kind: "selection",
			version: "1",
			pageId: "p1",
			nodeIds: ["r1"],
		};
		expect(resolveCommentAnchor(anchor, ir1)).toEqual({
			status: "archived",
			reason: "node-deleted",
		});
	});

	it("an empty selection anchor is active (nothing to be missing)", () => {
		const { ir } = makeIR();
		const anchor: CanvasCommentAnchor = {
			kind: "selection",
			version: "1",
			pageId: "p1",
			nodeIds: [],
		};
		expect(resolveCommentAnchor(anchor, ir)).toEqual({ status: "active" });
	});
});
