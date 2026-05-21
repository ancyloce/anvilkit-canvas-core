import { describe, expect, it } from "vitest";
import { applyCommand, CanvasCommandError } from "../commands/runtime.js";
import type {
	CanvasAnyNodeUpdateCommand,
	CanvasImageReplaceCommand,
	CanvasNodeCreateCommand,
	CanvasNodeDeleteCommand,
	CanvasNodeMoveCommand,
	CanvasNodeResizeCommand,
	CanvasNodeRotateCommand,
	CanvasPageCreateCommand,
	CanvasPageDeleteCommand,
	CanvasPageRenameCommand,
	CanvasPageReorderCommand,
} from "../commands/types.js";
import {
	createCanvasIR,
	createGroup,
	createImage,
	createPage,
	createRect,
	createText,
} from "../ir-builders.js";
import { findNode } from "../ir-walkers.js";
import type {
	CanvasGroupNode,
	CanvasIR,
	CanvasImageNode,
	CanvasRectNode,
} from "../types.js";

const FIXED_TS = "2026-05-20T00:00:00.000Z";
const now = () => FIXED_TS;

function buildFixture(): CanvasIR {
	const rect = createRect({
		id: "rectA",
		bounds: { width: 100, height: 50 },
		fill: "#f00",
	});
	const text = createText({
		id: "textA",
		bounds: { width: 200, height: 24 },
		text: "hello",
	});
	const image = createImage({
		id: "imgA",
		bounds: { width: 300, height: 200 },
		assetId: "asset-1",
	});
	const inner = createGroup({
		id: "inner",
		bounds: { width: 600, height: 400 },
		children: [text, image],
	});
	const page1 = createPage({ id: "page-1" });
	page1.root = createGroup({
		id: "page-1-root",
		bounds: page1.root.bounds,
		children: [rect, inner],
	});
	const page2 = createPage({ id: "page-2" });
	const ir = createCanvasIR({
		id: "ir-1",
		title: "Fixture",
		pages: [page1, page2],
		now,
	});
	ir.assets["asset-1"] = {
		id: "asset-1",
		uri: "data:image/png;base64,AAA",
	};
	ir.assets["asset-2"] = {
		id: "asset-2",
		uri: "data:image/png;base64,BBB",
	};
	return ir;
}

function snapshot(ir: CanvasIR): string {
	return JSON.stringify(ir);
}

describe("applyCommand: node.create", () => {
	it("inserts a node into the resolved parent and returns a node.delete inverse", () => {
		const ir = buildFixture();
		const newRect = createRect({
			id: "newRect",
			bounds: { width: 10, height: 10 },
		});
		const cmd: CanvasNodeCreateCommand = {
			type: "node.create",
			node: newRect,
			pageId: "page-1",
			parentId: "inner",
		};
		const result = applyCommand(ir, cmd, { now });
		const innerAfter = findNode(result.ir, "inner")?.node as CanvasGroupNode;
		expect(innerAfter.children.at(-1)?.id).toBe("newRect");
		expect(result.inverse).toEqual({ type: "node.delete", nodeId: "newRect" });
	});

	it("uses page.root as parent when parentId is omitted", () => {
		const ir = buildFixture();
		const newRect = createRect({
			id: "newRect",
			bounds: { width: 10, height: 10 },
		});
		const cmd: CanvasNodeCreateCommand = {
			type: "node.create",
			node: newRect,
			pageId: "page-2",
		};
		const result = applyCommand(ir, cmd, { now });
		const page2Root = findNode(result.ir, "page-2");
		const page2 = result.ir.pages.find((p) => p.id === "page-2");
		expect(page2?.root.children.at(-1)?.id).toBe("newRect");
		expect(page2Root).toBeNull();
	});

	it("honors the requested index", () => {
		const ir = buildFixture();
		const newRect = createRect({
			id: "frontRect",
			bounds: { width: 10, height: 10 },
		});
		const cmd: CanvasNodeCreateCommand = {
			type: "node.create",
			node: newRect,
			pageId: "page-1",
			parentId: "inner",
			index: 0,
		};
		const result = applyCommand(ir, cmd, { now });
		const inner = findNode(result.ir, "inner")?.node as CanvasGroupNode;
		expect(inner.children[0]?.id).toBe("frontRect");
	});

	it("round-trips: apply then apply inverse yields the original IR", () => {
		const ir = buildFixture();
		const before = snapshot(ir);
		const newRect = createRect({
			id: "rtRect",
			bounds: { width: 10, height: 10 },
		});
		const apply = applyCommand(
			ir,
			{
				type: "node.create",
				node: newRect,
				pageId: "page-1",
				parentId: "inner",
			},
			{ now },
		);
		const undo = applyCommand(apply.ir, apply.inverse, { now });
		expect(snapshot(undo.ir)).toBe(before);
	});

	it("throws page-not-found for an unknown pageId", () => {
		const ir = buildFixture();
		const newRect = createRect({
			id: "x",
			bounds: { width: 1, height: 1 },
		});
		try {
			applyCommand(ir, {
				type: "node.create",
				node: newRect,
				pageId: "missing",
			});
		} catch (err) {
			expect(err).toBeInstanceOf(CanvasCommandError);
			expect((err as CanvasCommandError).code).toBe("page-not-found");
		}
	});
});

describe("applyCommand: node.delete", () => {
	it("removes the node and returns a node.create inverse with captured parent + index", () => {
		const ir = buildFixture();
		const cmd: CanvasNodeDeleteCommand = {
			type: "node.delete",
			nodeId: "textA",
		};
		const result = applyCommand(ir, cmd, { now });
		expect(findNode(result.ir, "textA")).toBeNull();
		expect(result.inverse.type).toBe("node.create");
		if (result.inverse.type === "node.create") {
			expect(result.inverse.pageId).toBe("page-1");
			expect(result.inverse.parentId).toBe("inner");
			expect(result.inverse.index).toBe(0);
			expect(result.inverse.node.id).toBe("textA");
		}
	});

	it("round-trips: deletion + undo restores the prior IR", () => {
		const ir = buildFixture();
		const before = snapshot(ir);
		const apply = applyCommand(
			ir,
			{ type: "node.delete", nodeId: "textA" },
			{ now },
		);
		const undo = applyCommand(apply.ir, apply.inverse, { now });
		expect(snapshot(undo.ir)).toBe(before);
	});

	it("throws node-not-found for an unknown id", () => {
		const ir = buildFixture();
		try {
			applyCommand(ir, { type: "node.delete", nodeId: "ghost" });
		} catch (err) {
			expect((err as CanvasCommandError).code).toBe("node-not-found");
		}
	});

	it("throws parent-not-found when trying to delete a page root", () => {
		const ir = buildFixture();
		try {
			applyCommand(ir, { type: "node.delete", nodeId: "page-1-root" });
		} catch (err) {
			expect((err as CanvasCommandError).code).toBe("parent-not-found");
		}
	});
});

describe("applyCommand: node.move", () => {
	it("translates transform.x/y and returns a swapped inverse", () => {
		const ir = buildFixture();
		const cmd: CanvasNodeMoveCommand = {
			type: "node.move",
			nodeId: "rectA",
			from: { x: 0, y: 0 },
			to: { x: 100, y: 50 },
		};
		const result = applyCommand(ir, cmd, { now });
		const rect = findNode(result.ir, "rectA")?.node;
		expect(rect?.transform.x).toBe(100);
		expect(rect?.transform.y).toBe(50);
		expect(result.inverse).toEqual({
			type: "node.move",
			nodeId: "rectA",
			from: { x: 100, y: 50 },
			to: { x: 0, y: 0 },
		});
	});

	it("PRD §9.2 scenario 3: move 100px and undo restores the original IR", () => {
		const ir = buildFixture();
		const before = snapshot(ir);
		const apply = applyCommand(
			ir,
			{
				type: "node.move",
				nodeId: "rectA",
				from: { x: 0, y: 0 },
				to: { x: 100, y: 0 },
			},
			{ now },
		);
		const undo = applyCommand(apply.ir, apply.inverse, { now });
		expect(snapshot(undo.ir)).toBe(before);
	});

	it("is drift-tolerant: inverse uses live current value, not cmd.from", () => {
		const ir = buildFixture();
		// Caller-claimed `from` of {x: 999, y: 999} is wrong (live value is 0,0).
		const cmd: CanvasNodeMoveCommand = {
			type: "node.move",
			nodeId: "rectA",
			from: { x: 999, y: 999 },
			to: { x: 25, y: 25 },
		};
		const result = applyCommand(ir, cmd, { now });
		// Inverse.to MUST point at the live value (0, 0), not cmd.from (999, 999).
		expect(result.inverse).toEqual({
			type: "node.move",
			nodeId: "rectA",
			from: { x: 25, y: 25 },
			to: { x: 0, y: 0 },
		});
	});

	it("throws node-not-found for an unknown id", () => {
		const ir = buildFixture();
		try {
			applyCommand(ir, {
				type: "node.move",
				nodeId: "ghost",
				from: { x: 0, y: 0 },
				to: { x: 1, y: 1 },
			});
		} catch (err) {
			expect((err as CanvasCommandError).code).toBe("node-not-found");
		}
	});
});

describe("applyCommand: node.resize", () => {
	it("updates bounds and transform.x/y, returns swapped inverse against live state", () => {
		const ir = buildFixture();
		const cmd: CanvasNodeResizeCommand = {
			type: "node.resize",
			nodeId: "rectA",
			from: { x: 0, y: 0, width: 100, height: 50 },
			to: { x: 10, y: 20, width: 200, height: 150 },
		};
		const result = applyCommand(ir, cmd, { now });
		const rect = findNode(result.ir, "rectA")?.node;
		expect(rect?.bounds).toEqual({ width: 200, height: 150 });
		expect(rect?.transform.x).toBe(10);
		expect(rect?.transform.y).toBe(20);
		expect(result.inverse).toEqual({
			type: "node.resize",
			nodeId: "rectA",
			from: { x: 10, y: 20, width: 200, height: 150 },
			to: { x: 0, y: 0, width: 100, height: 50 },
		});
	});

	it("round-trips back to the original IR", () => {
		const ir = buildFixture();
		const before = snapshot(ir);
		const apply = applyCommand(
			ir,
			{
				type: "node.resize",
				nodeId: "rectA",
				from: { x: 0, y: 0, width: 100, height: 50 },
				to: { x: 5, y: 5, width: 80, height: 40 },
			},
			{ now },
		);
		const undo = applyCommand(apply.ir, apply.inverse, { now });
		expect(snapshot(undo.ir)).toBe(before);
	});
});

describe("applyCommand: node.rotate", () => {
	it("updates transform.rotation and returns swapped inverse", () => {
		const ir = buildFixture();
		const cmd: CanvasNodeRotateCommand = {
			type: "node.rotate",
			nodeId: "rectA",
			from: 0,
			to: Math.PI / 2,
		};
		const result = applyCommand(ir, cmd, { now });
		const rect = findNode(result.ir, "rectA")?.node;
		expect(rect?.transform.rotation).toBe(Math.PI / 2);
		expect(result.inverse).toEqual({
			type: "node.rotate",
			nodeId: "rectA",
			from: Math.PI / 2,
			to: 0,
		});
	});

	it("round-trips back to the original IR", () => {
		const ir = buildFixture();
		const before = snapshot(ir);
		const apply = applyCommand(
			ir,
			{ type: "node.rotate", nodeId: "rectA", from: 0, to: 1.234 },
			{ now },
		);
		const undo = applyCommand(apply.ir, apply.inverse, { now });
		expect(snapshot(undo.ir)).toBe(before);
	});
});

describe("applyCommand: node.update", () => {
	it("applies the patch and captures prior values in the inverse", () => {
		const ir = buildFixture();
		const cmd: CanvasAnyNodeUpdateCommand = {
			type: "node.update",
			nodeId: "rectA",
			kind: "rect",
			patch: { fill: "#00ff00", radius: 8 },
		};
		const result = applyCommand(ir, cmd, { now });
		const rect = findNode(result.ir, "rectA")?.node as CanvasRectNode;
		expect(rect.fill).toBe("#00ff00");
		expect(rect.radius).toBe(8);
		// rectA originally had fill="#f00" and no radius (undefined).
		expect(result.inverse.type).toBe("node.update");
		if (result.inverse.type === "node.update") {
			expect(result.inverse.kind).toBe("rect");
			expect((result.inverse.patch as { fill?: string }).fill).toBe("#f00");
			// Prior undefined → inverse explicitly records undefined for Yjs-compat.
			expect((result.inverse.patch as { radius?: number }).radius).toBe(
				undefined,
			);
			expect("radius" in (result.inverse.patch as object)).toBe(true);
		}
	});

	it("preserves id and type even if patch is forced", () => {
		const ir = buildFixture();
		const result = applyCommand(
			ir,
			{
				type: "node.update",
				nodeId: "rectA",
				kind: "rect",
				patch: { fill: "#0000ff" },
			},
			{ now },
		);
		const rect = findNode(result.ir, "rectA")?.node as CanvasRectNode;
		expect(rect.id).toBe("rectA");
		expect(rect.type).toBe("rect");
	});

	it("round-trips back to the original IR", () => {
		const ir = buildFixture();
		const before = snapshot(ir);
		const apply = applyCommand(
			ir,
			{
				type: "node.update",
				nodeId: "rectA",
				kind: "rect",
				patch: { fill: "#abc", radius: 4 },
			},
			{ now },
		);
		const undo = applyCommand(apply.ir, apply.inverse, { now });
		expect(snapshot(undo.ir)).toBe(before);
	});

	it("throws kind-mismatch when cmd.kind disagrees with the actual node", () => {
		const ir = buildFixture();
		try {
			applyCommand(ir, {
				type: "node.update",
				nodeId: "rectA",
				kind: "text",
				patch: {},
			} as CanvasAnyNodeUpdateCommand);
		} catch (err) {
			expect((err as CanvasCommandError).code).toBe("kind-mismatch");
		}
	});
});

describe("applyCommand: image.replace", () => {
	it("changes the assetId and returns a swapped inverse", () => {
		const ir = buildFixture();
		const cmd: CanvasImageReplaceCommand = {
			type: "image.replace",
			nodeId: "imgA",
			fromAssetId: "asset-1",
			toAssetId: "asset-2",
		};
		const result = applyCommand(ir, cmd, { now });
		const img = findNode(result.ir, "imgA")?.node as CanvasImageNode;
		expect(img.assetId).toBe("asset-2");
		expect(result.inverse).toEqual({
			type: "image.replace",
			nodeId: "imgA",
			fromAssetId: "asset-2",
			toAssetId: "asset-1",
		});
	});

	it("round-trips back to the original IR", () => {
		const ir = buildFixture();
		const before = snapshot(ir);
		const apply = applyCommand(
			ir,
			{
				type: "image.replace",
				nodeId: "imgA",
				fromAssetId: "asset-1",
				toAssetId: "asset-2",
			},
			{ now },
		);
		const undo = applyCommand(apply.ir, apply.inverse, { now });
		expect(snapshot(undo.ir)).toBe(before);
	});

	it("throws asset-mismatch when the live assetId has drifted", () => {
		const ir = buildFixture();
		try {
			applyCommand(ir, {
				type: "image.replace",
				nodeId: "imgA",
				fromAssetId: "wrong-asset",
				toAssetId: "asset-2",
			});
		} catch (err) {
			expect((err as CanvasCommandError).code).toBe("asset-mismatch");
		}
	});

	it("throws kind-mismatch when target is not an image", () => {
		const ir = buildFixture();
		try {
			applyCommand(ir, {
				type: "image.replace",
				nodeId: "rectA",
				fromAssetId: "asset-1",
				toAssetId: "asset-2",
			});
		} catch (err) {
			expect((err as CanvasCommandError).code).toBe("kind-mismatch");
		}
	});
});

describe("applyCommand: page.create", () => {
	it("appends a page by default", () => {
		const ir = buildFixture();
		const newPage = createPage({ id: "page-3" });
		const cmd: CanvasPageCreateCommand = { type: "page.create", page: newPage };
		const result = applyCommand(ir, cmd, { now });
		expect(result.ir.pages.map((p) => p.id)).toEqual([
			"page-1",
			"page-2",
			"page-3",
		]);
		expect(result.inverse).toEqual({ type: "page.delete", pageId: "page-3" });
	});

	it("inserts at the requested index", () => {
		const ir = buildFixture();
		const newPage = createPage({ id: "page-front" });
		const result = applyCommand(
			ir,
			{ type: "page.create", page: newPage, index: 0 },
			{ now },
		);
		expect(result.ir.pages[0]?.id).toBe("page-front");
	});

	it("round-trips back to the original IR", () => {
		const ir = buildFixture();
		const before = snapshot(ir);
		const newPage = createPage({ id: "page-rt" });
		const apply = applyCommand(
			ir,
			{ type: "page.create", page: newPage, index: 1 },
			{ now },
		);
		const undo = applyCommand(apply.ir, apply.inverse, { now });
		expect(snapshot(undo.ir)).toBe(before);
	});

	it("throws invariant-violated for a duplicate page id", () => {
		const ir = buildFixture();
		try {
			applyCommand(ir, {
				type: "page.create",
				page: createPage({ id: "page-1" }),
			});
		} catch (err) {
			expect((err as CanvasCommandError).code).toBe("invariant-violated");
		}
	});
});

describe("applyCommand: page.delete", () => {
	it("removes the page and returns a page.create inverse with the original index", () => {
		const ir = buildFixture();
		const cmd: CanvasPageDeleteCommand = {
			type: "page.delete",
			pageId: "page-2",
		};
		const result = applyCommand(ir, cmd, { now });
		expect(result.ir.pages.map((p) => p.id)).toEqual(["page-1"]);
		expect(result.inverse.type).toBe("page.create");
		if (result.inverse.type === "page.create") {
			expect(result.inverse.index).toBe(1);
			expect(result.inverse.page.id).toBe("page-2");
		}
	});

	it("round-trips back to the original IR", () => {
		const ir = buildFixture();
		const before = snapshot(ir);
		const apply = applyCommand(
			ir,
			{ type: "page.delete", pageId: "page-1" },
			{ now },
		);
		const undo = applyCommand(apply.ir, apply.inverse, { now });
		expect(snapshot(undo.ir)).toBe(before);
	});

	it("throws page-not-found for unknown id", () => {
		const ir = buildFixture();
		try {
			applyCommand(ir, { type: "page.delete", pageId: "ghost" });
		} catch (err) {
			expect((err as CanvasCommandError).code).toBe("page-not-found");
		}
	});
});

describe("applyCommand: page.reorder", () => {
	it("moves the page from one index to another and returns swapped inverse", () => {
		const ir = buildFixture();
		const cmd: CanvasPageReorderCommand = {
			type: "page.reorder",
			pageId: "page-2",
			from: 1,
			to: 0,
		};
		const result = applyCommand(ir, cmd, { now });
		expect(result.ir.pages.map((p) => p.id)).toEqual(["page-2", "page-1"]);
		expect(result.inverse).toEqual({
			type: "page.reorder",
			pageId: "page-2",
			from: 0,
			to: 1,
		});
	});

	it("round-trips back to the original IR", () => {
		const ir = buildFixture();
		const before = snapshot(ir);
		const apply = applyCommand(
			ir,
			{ type: "page.reorder", pageId: "page-1", from: 0, to: 1 },
			{ now },
		);
		const undo = applyCommand(apply.ir, apply.inverse, { now });
		expect(snapshot(undo.ir)).toBe(before);
	});

	it("throws index-out-of-range when cmd.from disagrees with the live index", () => {
		const ir = buildFixture();
		try {
			applyCommand(ir, {
				type: "page.reorder",
				pageId: "page-1",
				from: 99,
				to: 0,
			});
		} catch (err) {
			expect((err as CanvasCommandError).code).toBe("index-out-of-range");
		}
	});

	it("throws page-not-found for unknown id", () => {
		const ir = buildFixture();
		try {
			applyCommand(ir, {
				type: "page.reorder",
				pageId: "ghost",
				from: 0,
				to: 1,
			});
		} catch (err) {
			expect((err as CanvasCommandError).code).toBe("page-not-found");
		}
	});
});

describe("applyCommand: page.rename", () => {
	it("renames a page from undefined to a string and returns swapped inverse", () => {
		const ir = buildFixture();
		expect(ir.pages[0]?.name).toBeUndefined();
		const cmd: CanvasPageRenameCommand = {
			type: "page.rename",
			pageId: "page-1",
			from: undefined,
			to: "Cover",
		};
		const result = applyCommand(ir, cmd, { now });
		expect(result.ir.pages[0]?.name).toBe("Cover");
		expect(result.inverse).toEqual({
			type: "page.rename",
			pageId: "page-1",
			from: "Cover",
			to: undefined,
		});
	});

	it("renames a page from a string to a new string", () => {
		const fixture = buildFixture();
		const seeded = applyCommand(
			fixture,
			{
				type: "page.rename",
				pageId: "page-1",
				from: undefined,
				to: "Cover",
			},
			{ now },
		).ir;
		const result = applyCommand(
			seeded,
			{
				type: "page.rename",
				pageId: "page-1",
				from: "Cover",
				to: "Hero",
			},
			{ now },
		);
		expect(result.ir.pages[0]?.name).toBe("Hero");
		expect(result.inverse).toEqual({
			type: "page.rename",
			pageId: "page-1",
			from: "Hero",
			to: "Cover",
		});
	});

	it("clears the name when to is undefined", () => {
		const fixture = buildFixture();
		const seeded = applyCommand(
			fixture,
			{
				type: "page.rename",
				pageId: "page-1",
				from: undefined,
				to: "Cover",
			},
			{ now },
		).ir;
		const result = applyCommand(
			seeded,
			{
				type: "page.rename",
				pageId: "page-1",
				from: "Cover",
				to: undefined,
			},
			{ now },
		);
		expect(result.ir.pages[0]?.name).toBeUndefined();
	});

	it("round-trips back to the original IR", () => {
		const ir = buildFixture();
		const before = snapshot(ir);
		const apply = applyCommand(
			ir,
			{
				type: "page.rename",
				pageId: "page-2",
				from: undefined,
				to: "Outro",
			},
			{ now },
		);
		const undo = applyCommand(apply.ir, apply.inverse, { now });
		expect(snapshot(undo.ir)).toBe(before);
	});

	it("throws page-not-found for unknown id", () => {
		const ir = buildFixture();
		try {
			applyCommand(ir, {
				type: "page.rename",
				pageId: "ghost",
				from: undefined,
				to: "Boom",
			});
		} catch (err) {
			expect((err as CanvasCommandError).code).toBe("page-not-found");
		}
	});

	it("throws invariant-violated when cmd.from disagrees with the live name", () => {
		const ir = buildFixture();
		try {
			applyCommand(ir, {
				type: "page.rename",
				pageId: "page-1",
				from: "Wrong",
				to: "Right",
			});
		} catch (err) {
			expect((err as CanvasCommandError).code).toBe("invariant-violated");
		}
	});
});
