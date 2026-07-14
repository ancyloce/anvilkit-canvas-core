import { describe, expect, it } from "vitest";
import {
	createCanvasIR,
	createGroup,
	createImage,
	createPage,
	createRect,
} from "../builders.js";
import {
	assertCanvasIRInvariants,
	CanvasIRInvariantError,
	validateCanvasIRInvariants,
} from "../invariants.js";
import { insertNode } from "../mutations.js";
import type { CanvasIR } from "../types.js";

function baseIR(): CanvasIR {
	const page = createPage({ id: "p1" });
	let ir = createCanvasIR({ id: "doc", title: "t", pages: [page] });
	ir = insertNode(ir, {
		parentId: page.root.id,
		node: createRect({ id: "r1", bounds: { width: 10, height: 10 } }),
	});
	return ir;
}

describe("validateCanvasIRInvariants", () => {
	it("returns no issues for a well-formed IR", () => {
		expect(validateCanvasIRInvariants(baseIR())).toEqual([]);
	});

	it("flags duplicate page ids", () => {
		const page = createPage({ id: "p1" });
		const dupe = createPage({ id: "p1" });
		const ir = createCanvasIR({ id: "doc", title: "t", pages: [page, dupe] });
		const issues = validateCanvasIRInvariants(ir);
		expect(issues).toContainEqual(
			expect.objectContaining({ code: "duplicate-page-id", pageId: "p1" }),
		);
	});

	it("flags a duplicate node id across two different pages", () => {
		const page1 = createPage({ id: "p1" });
		const page2 = createPage({ id: "p2" });
		let ir = createCanvasIR({ id: "doc", title: "t", pages: [page1, page2] });
		const node = createRect({ id: "shared", bounds: { width: 5, height: 5 } });
		ir = insertNode(ir, { parentId: page1.root.id, node });
		ir = insertNode(ir, { parentId: page2.root.id, node });
		const issues = validateCanvasIRInvariants(ir);
		expect(issues).toContainEqual(
			expect.objectContaining({ code: "duplicate-node-id", nodeId: "shared" }),
		);
	});

	it("flags a duplicate node id nested within the same page", () => {
		const page = createPage({ id: "p1" });
		let ir = createCanvasIR({ id: "doc", title: "t", pages: [page] });
		const inner = createGroup({ id: "g1", bounds: { width: 20, height: 20 } });
		ir = insertNode(ir, { parentId: page.root.id, node: inner });
		ir = insertNode(ir, {
			parentId: "g1",
			node: createRect({ id: "dup", bounds: { width: 5, height: 5 } }),
		});
		ir = insertNode(ir, {
			parentId: page.root.id,
			node: createRect({ id: "dup", bounds: { width: 5, height: 5 } }),
		});
		const issues = validateCanvasIRInvariants(ir);
		expect(issues).toContainEqual(
			expect.objectContaining({ code: "duplicate-node-id", nodeId: "dup" }),
		);
	});

	it("flags an invalid page root (not a group)", () => {
		const ir = baseIR();
		const badIr: CanvasIR = {
			...ir,
			pages: [{ ...ir.pages[0], root: { ...ir.pages[0].root, type: "frame" } }],
		} as unknown as CanvasIR;
		const issues = validateCanvasIRInvariants(badIr);
		expect(issues).toContainEqual(
			expect.objectContaining({ code: "invalid-page-root", pageId: "p1" }),
		);
	});

	it("flags an asset record whose key does not match its own id", () => {
		const ir = baseIR();
		const withAsset: CanvasIR = {
			...ir,
			assets: {
				"key-a": { id: "different-id", uri: "https://example.com/a.png" },
			},
		};
		const issues = validateCanvasIRInvariants(withAsset);
		expect(issues).toContainEqual(
			expect.objectContaining({ code: "asset-key-id-mismatch" }),
		);
	});

	it("flags a dangling asset reference from an image node", () => {
		const page = createPage({ id: "p1" });
		let ir = createCanvasIR({ id: "doc", title: "t", pages: [page] });
		ir = insertNode(ir, {
			parentId: page.root.id,
			node: createImage({
				id: "img1",
				bounds: { width: 10, height: 10 },
				assetId: "missing-asset",
			}),
		});
		const issues = validateCanvasIRInvariants(ir);
		expect(issues).toContainEqual(
			expect.objectContaining({
				code: "dangling-asset-reference",
				message: expect.stringContaining("missing-asset"),
			}),
		);
	});

	it("does not flag a resolved asset reference", () => {
		const page = createPage({ id: "p1" });
		let ir = createCanvasIR({ id: "doc", title: "t", pages: [page] });
		ir = {
			...ir,
			assets: {
				"asset-1": { id: "asset-1", uri: "https://example.com/a.png" },
			},
		};
		ir = insertNode(ir, {
			parentId: page.root.id,
			node: createImage({
				id: "img1",
				bounds: { width: 10, height: 10 },
				assetId: "asset-1",
			}),
		});
		expect(validateCanvasIRInvariants(ir)).toEqual([]);
	});

	it("flags excessive tree depth instead of throwing", () => {
		// `insertNode` itself enforces MAX_TREE_DEPTH, so an over-deep tree can
		// only arise from a document assembled directly (e.g. deserialized from
		// an untrusted source) rather than built up through mutations — construct
		// the nested group chain by hand to exercise that path.
		let innermost = createGroup({
			id: "g80",
			bounds: { width: 1, height: 1 },
		});
		for (let i = 79; i >= 0; i--) {
			innermost = createGroup({
				id: `g${i}`,
				bounds: { width: 1, height: 1 },
				children: [innermost],
			});
		}
		const page = createPage({ id: "p1", root: innermost });
		const ir = createCanvasIR({ id: "doc", title: "t", pages: [page] });
		const issues = validateCanvasIRInvariants(ir);
		expect(issues).toContainEqual(
			expect.objectContaining({ code: "excessive-tree-depth" }),
		);
	});

	it("aggregates multiple issues in one pass (adversarial)", () => {
		const page1 = createPage({ id: "p1" });
		const page2 = createPage({ id: "p1" }); // duplicate page id
		let ir = createCanvasIR({ id: "doc", title: "t", pages: [page1, page2] });
		ir = insertNode(ir, {
			parentId: page1.root.id,
			node: createImage({
				id: "img1",
				bounds: { width: 10, height: 10 },
				assetId: "ghost-asset",
			}),
		});
		ir = { ...ir, assets: { wrong: { id: "right", uri: "u" } } };
		const issues = validateCanvasIRInvariants(ir);
		const codes = issues.map((i) => i.code).sort();
		expect(codes).toEqual(
			[
				"asset-key-id-mismatch",
				"dangling-asset-reference",
				"duplicate-page-id",
			].sort(),
		);
	});
});

describe("assertCanvasIRInvariants", () => {
	it("does not throw for a well-formed IR", () => {
		expect(() => assertCanvasIRInvariants(baseIR())).not.toThrow();
	});

	it("throws CanvasIRInvariantError carrying every issue found", () => {
		const page = createPage({ id: "p1" });
		const dupe = createPage({ id: "p1" });
		const ir = createCanvasIR({ id: "doc", title: "t", pages: [page, dupe] });
		try {
			assertCanvasIRInvariants(ir);
			expect.unreachable("assertCanvasIRInvariants must throw");
		} catch (err) {
			expect(err).toBeInstanceOf(CanvasIRInvariantError);
			expect((err as CanvasIRInvariantError).issues).toHaveLength(1);
			expect((err as CanvasIRInvariantError).issues[0]?.code).toBe(
				"duplicate-page-id",
			);
		}
	});
});
