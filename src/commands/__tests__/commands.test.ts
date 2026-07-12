import { describe, expect, it } from "vitest";
import {
	createCanvasIR,
	createFrame,
	createGroup,
	createImage,
	createPage,
	createRect,
	createRichText,
	createText,
} from "../../ir/builders.js";
import type {
	CanvasGroupNode,
	CanvasImageNode,
	CanvasIR,
	CanvasRectNode,
	CanvasRichTextNode,
} from "../../ir/types.js";
import { findNode } from "../../ir/walkers.js";
import { commandToChange } from "../change-events.js";
import { applyCommand, CanvasCommandError } from "../runtime.js";
import type {
	CanvasAnyNodeUpdateCommand,
	CanvasImageReplaceCommand,
	CanvasNodeCreateCommand,
	CanvasNodeDeleteCommand,
	CanvasNodeGroupCommand,
	CanvasNodeMoveCommand,
	CanvasNodeResizeCommand,
	CanvasNodeRotateCommand,
	CanvasNodeUngroupCommand,
	CanvasPageCreateCommand,
	CanvasPageDeleteCommand,
	CanvasPageRenameCommand,
	CanvasPageReorderCommand,
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

// Fixture with four flat top-level siblings (a, b, c, d) for ordering tests.
function buildFlatFixture(): CanvasIR {
	const mk = (id: string) =>
		createRect({ id, bounds: { width: 10, height: 10 } });
	const page = createPage({ id: "page-1" });
	page.root = createGroup({
		id: "root",
		bounds: page.root.bounds,
		children: [mk("a"), mk("b"), mk("c"), mk("d")],
	});
	return createCanvasIR({ id: "ir-1", title: "Flat", pages: [page], now });
}

function childIdsOf(ir: CanvasIR, parentId: string): string[] {
	const parent = findNode(ir, parentId)?.node as CanvasGroupNode;
	return parent.children.map((c) => c.id);
}

// page-root("root") > frame("f1") > [a, b, c]
function buildFrameFixture(): CanvasIR {
	const mk = (id: string) =>
		createRect({ id, bounds: { width: 10, height: 10 } });
	const frame = createFrame({
		id: "f1",
		bounds: { width: 400, height: 400 },
		children: [mk("a"), mk("b"), mk("c")],
	});
	const page = createPage({ id: "page-1" });
	page.root = createGroup({
		id: "root",
		bounds: page.root.bounds,
		children: [frame],
	});
	return createCanvasIR({ id: "ir-1", title: "Framed", pages: [page], now });
}

describe("group / ungroup interplay with frames", () => {
	it("node.group wraps siblings that live INSIDE a frame, leaving them in the frame", () => {
		const ir = buildFrameFixture();
		const next = applyCommand(
			ir,
			{
				type: "node.group",
				pageId: "page-1",
				childIds: ["a", "b"],
				groupId: "g1",
			},
			{ now },
		).ir;
		// The new group takes the topmost selected slot, still parented to the frame.
		expect(childIdsOf(next, "f1")).toEqual(["g1", "c"]);
		expect(childIdsOf(next, "g1")).toEqual(["a", "b"]);
		expect(findNode(next, "f1")?.node.type).toBe("frame");
	});

	it("node.group can wrap a frame itself (a frame is a groupable child)", () => {
		const ir = buildFrameFixture();
		const next = applyCommand(
			ir,
			{
				type: "node.group",
				pageId: "page-1",
				childIds: ["f1"],
				groupId: "g1",
			},
			{ now },
		).ir;
		expect(childIdsOf(next, "root")).toEqual(["g1"]);
		expect(childIdsOf(next, "g1")).toEqual(["f1"]);
		// The frame keeps its own children through the wrap.
		expect(childIdsOf(next, "f1")).toEqual(["a", "b", "c"]);
	});

	it("node.ungroup REJECTS a frame — a frame is a container, not a group", () => {
		const ir = buildFrameFixture();
		try {
			applyCommand(ir, { type: "node.ungroup", groupId: "f1" }, { now });
			expect.unreachable("ungrouping a frame must throw");
		} catch (err) {
			expect((err as CanvasCommandError).code).toBe("kind-mismatch");
		}
	});

	it("node.ungroup splices a nested group's children back into the frame", () => {
		const ir = buildFrameFixture();
		const grouped = applyCommand(
			ir,
			{
				type: "node.group",
				pageId: "page-1",
				childIds: ["a", "b"],
				groupId: "g1",
			},
			{ now },
		).ir;
		const next = applyCommand(
			grouped,
			{ type: "node.ungroup", groupId: "g1" },
			{ now },
		).ir;
		// Back to the original frame children, in the original order.
		expect(childIdsOf(next, "f1")).toEqual(["a", "b", "c"]);
		expect(findNode(next, "g1")).toBeNull();
	});

	it("group → ungroup inside a frame round-trips the frame's children exactly", () => {
		const ir = buildFrameFixture();
		const before = snapshot(ir);
		const grouped = applyCommand(
			ir,
			{
				type: "node.group",
				pageId: "page-1",
				childIds: ["b", "c"],
				groupId: "g1",
			},
			{ now },
		);
		const restored = applyCommand(grouped.ir, grouped.inverse, { now });
		expect(snapshot(restored.ir)).toBe(before);
	});
});

describe("applyCommand: node.group", () => {
	it("wraps contiguous siblings into a new group at the topmost slot", () => {
		const ir = buildFlatFixture();
		const cmd: CanvasNodeGroupCommand = {
			type: "node.group",
			pageId: "page-1",
			childIds: ["b", "c"],
			groupId: "g1",
			groupName: "My Group",
		};
		const result = applyCommand(ir, cmd, { now });
		expect(childIdsOf(result.ir, "root")).toEqual(["a", "g1", "d"]);
		const group = findNode(result.ir, "g1")?.node as CanvasGroupNode;
		expect(group.type).toBe("group");
		expect(group.name).toBe("My Group");
		expect(group.children.map((c) => c.id)).toEqual(["b", "c"]);
		// identity transform — grouping never shifts children.
		expect(group.transform).toEqual({
			x: 0,
			y: 0,
			rotation: 0,
			scaleX: 1,
			scaleY: 1,
		});
	});

	it("preserves sibling z-order regardless of childIds order", () => {
		const ir = buildFlatFixture();
		const result = applyCommand(
			ir,
			{
				type: "node.group",
				pageId: "page-1",
				childIds: ["c", "a"],
				groupId: "g1",
			},
			{ now },
		);
		// a is at index 0 so the group takes slot 0; children keep tree order.
		expect(childIdsOf(result.ir, "root")).toEqual(["g1", "b", "d"]);
		const group = findNode(result.ir, "g1")?.node as CanvasGroupNode;
		expect(group.children.map((c) => c.id)).toEqual(["a", "c"]);
	});

	it("returns a node.ungroup inverse that round-trips a contiguous selection", () => {
		const ir = buildFlatFixture();
		const before = snapshot(ir);
		const apply = applyCommand(
			ir,
			{
				type: "node.group",
				pageId: "page-1",
				childIds: ["b", "c"],
				groupId: "g1",
			},
			{ now },
		);
		expect(apply.inverse.type).toBe("node.ungroup");
		const undo = applyCommand(apply.ir, apply.inverse, { now });
		expect(snapshot(undo.ir)).toBe(before);
	});

	it("round-trips a NON-contiguous selection back to the exact original tree", () => {
		const ir = buildFlatFixture();
		const before = snapshot(ir);
		const apply = applyCommand(
			ir,
			{
				type: "node.group",
				pageId: "page-1",
				childIds: ["a", "c"],
				groupId: "g1",
			},
			{ now },
		);
		expect(childIdsOf(apply.ir, "root")).toEqual(["g1", "b", "d"]);
		const undo = applyCommand(apply.ir, apply.inverse, { now });
		expect(childIdsOf(undo.ir, "root")).toEqual(["a", "b", "c", "d"]);
		expect(snapshot(undo.ir)).toBe(before);
	});

	it("supports a full undo→redo cycle for a non-contiguous selection", () => {
		const ir = buildFlatFixture();
		const grouped = snapshot(
			applyCommand(
				ir,
				{
					type: "node.group",
					pageId: "page-1",
					childIds: ["a", "c"],
					groupId: "g1",
				},
				{ now },
			).ir,
		);
		const apply = applyCommand(
			ir,
			{
				type: "node.group",
				pageId: "page-1",
				childIds: ["a", "c"],
				groupId: "g1",
			},
			{ now },
		);
		const undo = applyCommand(apply.ir, apply.inverse, { now });
		const redo = applyCommand(undo.ir, undo.inverse, { now });
		expect(snapshot(redo.ir)).toBe(grouped);
	});

	it("throws on an empty selection", () => {
		const ir = buildFlatFixture();
		expect(() =>
			applyCommand(
				ir,
				{ type: "node.group", pageId: "page-1", childIds: [], groupId: "g1" },
				{ now },
			),
		).toThrowError(/at least one/);
	});

	it("throws invariant-violated for childIds spanning different parents", () => {
		const ir = buildFixture();
		try {
			applyCommand(
				ir,
				{
					type: "node.group",
					pageId: "page-1",
					childIds: ["rectA", "textA"],
					groupId: "g1",
				},
				{ now },
			);
			throw new Error("expected throw");
		} catch (err) {
			expect((err as CanvasCommandError).code).toBe("invariant-violated");
		}
	});

	it("throws invariant-violated on duplicate childIds", () => {
		const ir = buildFlatFixture();
		try {
			applyCommand(
				ir,
				{
					type: "node.group",
					pageId: "page-1",
					childIds: ["a", "a"],
					groupId: "g1",
				},
				{ now },
			);
			throw new Error("expected throw");
		} catch (err) {
			expect((err as CanvasCommandError).code).toBe("invariant-violated");
		}
	});

	it("throws invariant-violated when groupId already exists", () => {
		const ir = buildFlatFixture();
		try {
			applyCommand(
				ir,
				{
					type: "node.group",
					pageId: "page-1",
					childIds: ["a", "b"],
					groupId: "root",
				},
				{ now },
			);
			throw new Error("expected throw");
		} catch (err) {
			expect((err as CanvasCommandError).code).toBe("invariant-violated");
		}
	});

	it("throws node-not-found for an unknown childId", () => {
		const ir = buildFlatFixture();
		try {
			applyCommand(
				ir,
				{
					type: "node.group",
					pageId: "page-1",
					childIds: ["a", "ghost"],
					groupId: "g1",
				},
				{ now },
			);
			throw new Error("expected throw");
		} catch (err) {
			expect((err as CanvasCommandError).code).toBe("node-not-found");
		}
	});
});

describe("applyCommand: node.ungroup", () => {
	it("dissolves a group, spilling children contiguously at the group's slot", () => {
		// root: [a, g(=[x,y]), d]
		const x = createRect({ id: "x", bounds: { width: 10, height: 10 } });
		const y = createRect({ id: "y", bounds: { width: 10, height: 10 } });
		const g = createGroup({
			id: "g",
			name: "Grp",
			bounds: { width: 20, height: 20 },
			children: [x, y],
		});
		const a = createRect({ id: "a", bounds: { width: 10, height: 10 } });
		const d = createRect({ id: "d", bounds: { width: 10, height: 10 } });
		const page = createPage({ id: "page-1" });
		page.root = createGroup({
			id: "root",
			bounds: page.root.bounds,
			children: [a, g, d],
		});
		const ir = createCanvasIR({ id: "ir-1", title: "G", pages: [page], now });

		const result = applyCommand(
			ir,
			{ type: "node.ungroup", groupId: "g" },
			{ now },
		);
		expect(childIdsOf(result.ir, "root")).toEqual(["a", "x", "y", "d"]);
		expect(findNode(result.ir, "g")).toBeNull();
		expect(result.inverse.type).toBe("node.group");
	});

	it("round-trips: ungroup then undo restores the exact group (incl. custom fields)", () => {
		const x = createRect({ id: "x", bounds: { width: 10, height: 10 } });
		const g = createGroup({
			id: "g",
			name: "Keep Me",
			transform: { x: 12, y: 34 },
			bounds: { width: 99, height: 88 },
			children: [x],
		});
		const page = createPage({ id: "page-1" });
		page.root = createGroup({
			id: "root",
			bounds: page.root.bounds,
			children: [g],
		});
		const ir = createCanvasIR({ id: "ir-1", title: "G", pages: [page], now });
		const before = snapshot(ir);

		const apply = applyCommand(
			ir,
			{ type: "node.ungroup", groupId: "g" },
			{ now },
		);
		const undo = applyCommand(apply.ir, apply.inverse, { now });
		expect(snapshot(undo.ir)).toBe(before);
		const restored = findNode(undo.ir, "g")?.node as CanvasGroupNode;
		expect(restored.name).toBe("Keep Me");
		expect(restored.transform.x).toBe(12);
		expect(restored.bounds).toEqual({ width: 99, height: 88 });
	});

	it("throws kind-mismatch when the target is not a group", () => {
		const ir = buildFixture();
		try {
			applyCommand(ir, { type: "node.ungroup", groupId: "rectA" }, { now });
			throw new Error("expected throw");
		} catch (err) {
			expect((err as CanvasCommandError).code).toBe("kind-mismatch");
		}
	});

	it("throws invariant-violated when ungrouping a page root", () => {
		const ir = buildFlatFixture();
		try {
			applyCommand(ir, { type: "node.ungroup", groupId: "root" }, { now });
			throw new Error("expected throw");
		} catch (err) {
			expect((err as CanvasCommandError).code).toBe("invariant-violated");
		}
	});

	it("throws node-not-found for an unknown group", () => {
		const ir = buildFlatFixture();
		const cmd: CanvasNodeUngroupCommand = {
			type: "node.ungroup",
			groupId: "ghost",
		};
		try {
			applyCommand(ir, cmd, { now });
			throw new Error("expected throw");
		} catch (err) {
			expect((err as CanvasCommandError).code).toBe("node-not-found");
		}
	});
});

describe("applyCommand: node.update inverse restores absent optionals (P3-1)", () => {
	it("undo of adding an optional field removes the key, not key:undefined", () => {
		const ir = buildFixture();
		// rectA has no `stroke`; add it, then undo must restore exact absence.
		const cmd: CanvasAnyNodeUpdateCommand = {
			type: "node.update",
			nodeId: "rectA",
			kind: "rect",
			patch: { stroke: "#000" },
		};
		const applied = applyCommand(ir, cmd, { now });
		const updated = findNode(applied.ir, "rectA")?.node as
			| CanvasRectNode
			| undefined;
		if (!updated) throw new Error("expected rectA to exist after the update");
		expect(updated.stroke).toBe("#000");

		const undone = applyCommand(applied.ir, applied.inverse, { now });
		const restored = findNode(undone.ir, "rectA")?.node as CanvasRectNode;
		expect("stroke" in restored).toBe(false);
		// Exact structural round-trip (Object.keys, not just JSON which drops undefined).
		const original = findNode(ir, "rectA")?.node as CanvasRectNode;
		expect(Object.keys(restored).sort()).toEqual(Object.keys(original).sort());
	});
});

describe("applyCommand: node.group transform-aware bounds (P3-2)", () => {
	it("group bounds reflect a rotated child's extent, not just x + width", () => {
		// A 100×40 rect rotated 90° occupies a 40-wide × 100-tall box.
		const rotated = createRect({
			id: "rot",
			bounds: { width: 100, height: 40 },
			transform: { rotation: 90 },
		});
		const page = createPage({ id: "pg" });
		page.root = createGroup({
			id: "pg-root",
			bounds: page.root.bounds,
			children: [rotated],
		});
		const ir = createCanvasIR({ id: "g-ir", pages: [page], now });
		const result = applyCommand(
			ir,
			{ type: "node.group", pageId: "pg", childIds: ["rot"], groupId: "grp" },
			{ now },
		);
		const group = findNode(result.ir, "grp")?.node as CanvasGroupNode;
		expect(Math.round(group.bounds.width)).toBe(40);
		expect(Math.round(group.bounds.height)).toBe(100);
	});
});

describe("applyCommand: node.update over rich-text paragraphs", () => {
	/**
	 * `paragraphs` is the first ARRAY-valued patch key any built-in kind has. The
	 * inverse capture in `applyNodeUpdate` is a shallow, top-level key copy — it
	 * stores a *reference* to the prior array — and `mergeNodePatch` is a shallow
	 * spread that REPLACES the array rather than mutating it. Together those two
	 * facts make undo correct, but only so long as nobody mutates an array that is
	 * (or was) inside the IR.
	 *
	 * Hence the contract, which these tests pin: **never mutate a paragraph array
	 * in place.** Build a new one and patch with that. An editor that did
	 * `node.paragraphs.push(p)` and then dispatched `node.update` with the same
	 * array would corrupt undo silently — the "prior" value the inverse captured
	 * would be the very array it was meant to restore.
	 */
	function richFixture(): CanvasIR {
		const rt = createRichText({
			id: "rt1",
			bounds: { width: 200, height: 60 },
			paragraphs: [{ spans: [{ text: "hello" }] }],
		});
		const page = createPage({ id: "pg" });
		page.root = createGroup({
			id: "pg-root",
			bounds: { width: 500, height: 500 },
			children: [rt],
		});
		return createCanvasIR({ id: "doc", title: "t", pages: [page], now });
	}

	const richTextAt = (ir: CanvasIR, id = "rt1"): CanvasRichTextNode => {
		const found = findNode(ir, id);
		if (!found || found.node.type !== "rich-text") {
			throw new Error(`expected a rich-text node "${id}"`);
		}
		return found.node;
	};

	const update = (
		paragraphs: CanvasRichTextNode["paragraphs"],
	): CanvasAnyNodeUpdateCommand => ({
		type: "node.update",
		nodeId: "rt1",
		kind: "rich-text",
		patch: { paragraphs },
	});

	it("replaces the whole paragraph array and undoes back to the original IR", () => {
		const ir = richFixture();
		const before = snapshot(ir);

		const applied = applyCommand(
			ir,
			update([
				{ align: "center", spans: [{ text: "goodbye", fontSize: 24 }] },
				{ spans: [{ text: "second" }] },
			]),
			{ now },
		);
		expect(richTextAt(applied.ir).paragraphs).toHaveLength(2);
		expect(richTextAt(applied.ir).paragraphs[0]?.spans[0]?.text).toBe(
			"goodbye",
		);

		const undone = applyCommand(applied.ir, applied.inverse, { now });
		expect(snapshot(undone.ir)).toBe(before);
	});

	it("does not mutate the source IR's paragraph array", () => {
		const ir = richFixture();
		const original = richTextAt(ir).paragraphs;
		applyCommand(ir, update([{ spans: [{ text: "changed" }] }]), { now });
		// Structural sharing means the OLD node object must still hold the OLD array.
		expect(original).toEqual([{ spans: [{ text: "hello" }] }]);
		expect(richTextAt(ir).paragraphs[0]?.spans[0]?.text).toBe("hello");
	});

	it("round-trips adding a span", () => {
		const ir = richFixture();
		const before = snapshot(ir);
		const applied = applyCommand(
			ir,
			update([
				{ spans: [{ text: "hello" }, { text: " world", italic: true }] },
			]),
			{ now },
		);
		expect(richTextAt(applied.ir).paragraphs[0]?.spans).toHaveLength(2);
		const undone = applyCommand(applied.ir, applied.inverse, { now });
		expect(snapshot(undone.ir)).toBe(before);
	});

	it("round-trips removing every paragraph", () => {
		const ir = richFixture();
		const before = snapshot(ir);
		const applied = applyCommand(ir, update([]), { now });
		expect(richTextAt(applied.ir).paragraphs).toEqual([]);
		const undone = applyCommand(applied.ir, applied.inverse, { now });
		expect(snapshot(undone.ir)).toBe(before);
	});

	it("round-trips the non-paragraph fields too (width / overflow / wrap)", () => {
		const ir = richFixture();
		const before = snapshot(ir);
		const applied = applyCommand(
			ir,
			{
				type: "node.update",
				nodeId: "rt1",
				kind: "rich-text",
				patch: { width: 320, overflow: "ellipsis", wrap: "character" },
			},
			{ now },
		);
		expect(richTextAt(applied.ir)).toMatchObject({
			width: 320,
			overflow: "ellipsis",
			wrap: "character",
		});

		const undone = applyCommand(applied.ir, applied.inverse, { now });
		// `overflow`/`wrap` were ABSENT before, so undo must delete the keys rather
		// than leave them as `key: undefined`.
		const restored = richTextAt(undone.ir);
		expect("overflow" in restored).toBe(false);
		expect("wrap" in restored).toBe(false);
		expect(snapshot(undone.ir)).toBe(before);
	});

	it("survives a batch of successive paragraph edits, undone as one composite", () => {
		const ir = richFixture();
		const before = snapshot(ir);
		const applied = applyCommand(
			ir,
			{
				type: "batch",
				label: "Type",
				commands: [
					update([{ spans: [{ text: "h" }] }]),
					update([{ spans: [{ text: "he" }] }]),
					update([{ spans: [{ text: "hel" }] }]),
				],
			},
			{ now },
		);
		expect(richTextAt(applied.ir).paragraphs[0]?.spans[0]?.text).toBe("hel");

		const undone = applyCommand(applied.ir, applied.inverse, { now });
		expect(snapshot(undone.ir)).toBe(before);
	});

	it("emits an `updated` change naming the patched keys", () => {
		const change = commandToChange(update([{ spans: [{ text: "x" }] }]));
		expect(change).toEqual({
			kind: "updated",
			nodeId: "rt1",
			keys: ["paragraphs"],
		});
	});
});
