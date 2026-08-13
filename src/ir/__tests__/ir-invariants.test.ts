import { describe, expect, it } from "vitest";
import {
	createCanvasIR,
	createFrame,
	createGroup,
	createImage,
	createPage,
	createRect,
} from "../builders.js";
import {
	assertCanvasIRInvariants,
	CANVAS_LAYOUT_AUTO_CAPABILITY,
	CanvasIRInvariantError,
	validateCanvasIRInvariants,
} from "../invariants.js";
import { insertNode } from "../mutations.js";
import type { CanvasIR } from "../types.js";
import { CANVAS_IR_VERSION, migrateCanvasIR } from "../validators.js";

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

describe("missing-required-capability (capability completeness, AC-013)", () => {
	const declared = {
		schemaVersion: CANVAS_IR_VERSION,
		minReaderSchemaVersion: "3",
		requiredCapabilities: [CANVAS_LAYOUT_AUTO_CAPABILITY],
	} as const;

	const autoLayout = {
		version: 1,
		direction: "horizontal",
		padding: { top: 0, right: 0, bottom: 0, left: 0 },
		gap: 0,
		primaryAlign: "start",
		crossAlign: "start",
	} as const;

	/** A document whose frame carries Auto Layout intent. */
	function layoutIR(compatibility?: CanvasIR["compatibility"]): CanvasIR {
		const page = createPage({ id: "p1" });
		let ir = createCanvasIR({ id: "doc", title: "t", pages: [page] });
		ir = insertNode(ir, {
			parentId: page.root.id,
			node: {
				...createFrame({ id: "f1", bounds: { width: 40, height: 40 } }),
				autoLayout,
			},
		});
		return compatibility ? { ...ir, compatibility } : ir;
	}

	it("flags a frame carrying autoLayout when the capability is not declared", () => {
		const issues = validateCanvasIRInvariants(layoutIR());
		expect(issues).toContainEqual(
			expect.objectContaining({
				code: "missing-required-capability",
				nodeId: "f1",
				pageId: "p1",
			}),
		);
	});

	it("does NOT flag when the capability is declared", () => {
		expect(validateCanvasIRInvariants(layoutIR(declared))).toEqual([]);
	});

	it("flags when compatibility exists but lists only OTHER capabilities", () => {
		const issues = validateCanvasIRInvariants(
			layoutIR({
				schemaVersion: CANVAS_IR_VERSION,
				minReaderSchemaVersion: "3",
				requiredCapabilities: ["test.future.v9"],
			}),
		);
		expect(issues.map((i) => i.code)).toContain("missing-required-capability");
	});

	it("flags a non-default layoutItem on an ordinary node", () => {
		const page = createPage({ id: "p1" });
		let ir = createCanvasIR({ id: "doc", title: "t", pages: [page] });
		ir = insertNode(ir, {
			parentId: page.root.id,
			node: {
				...createRect({ id: "r1", bounds: { width: 10, height: 10 } }),
				layoutItem: { widthSizing: "fill" },
			},
		});
		expect(validateCanvasIRInvariants(ir).map((i) => i.code)).toContain(
			"missing-required-capability",
		);
	});

	it("does NOT flag a layoutItem whose every field is at its default", () => {
		// An all-default record is semantically identical to no record at all, so
		// a normalizer emitting `{}` must not silently make a plain document
		// layout-bearing.
		const page = createPage({ id: "p1" });
		let ir = createCanvasIR({ id: "doc", title: "t", pages: [page] });
		ir = insertNode(ir, {
			parentId: page.root.id,
			node: {
				...createRect({ id: "r1", bounds: { width: 10, height: 10 } }),
				layoutItem: {
					positioning: "flow",
					widthSizing: "fixed",
					heightSizing: "fixed",
				},
			},
		});
		expect(validateCanvasIRInvariants(ir)).toEqual([]);

		const page2 = createPage({ id: "p9" });
		const withEmpty = insertNode(
			createCanvasIR({ id: "doc2", title: "t", pages: [page2] }),
			{
				parentId: page2.root.id,
				node: {
					...createRect({ id: "r9", bounds: { width: 10, height: 10 } }),
					layoutItem: {},
				},
			},
		);
		expect(validateCanvasIRInvariants(withEmpty)).toEqual([]);
	});

	it("leaves a document with no layout intent completely untouched", () => {
		expect(validateCanvasIRInvariants(baseIR())).toEqual([]);
	});

	it("reports one document-level issue naming the pre-order-first offender", () => {
		const page = createPage({ id: "p1" });
		let ir = createCanvasIR({ id: "doc", title: "t", pages: [page] });
		ir = insertNode(ir, {
			parentId: page.root.id,
			node: {
				...createFrame({ id: "outer", bounds: { width: 80, height: 80 } }),
				autoLayout,
			},
		});
		ir = insertNode(ir, {
			parentId: "outer",
			node: {
				...createFrame({ id: "inner", bounds: { width: 40, height: 40 } }),
				autoLayout,
				layoutItem: { widthSizing: "fill" },
			},
		});
		const found = validateCanvasIRInvariants(ir).filter(
			(i) => i.code === "missing-required-capability",
		);
		expect(found).toHaveLength(1);
		expect(found[0]?.nodeId).toBe("outer");
		expect(found[0]?.message).toContain("2 node(s)");
	});

	it("migration never ADDS a capability to a layout-free document (the converse)", () => {
		// A v2 document has no layout intent by construction, so migrating it
		// forward must not synthesize a compatibility record — a document that
		// falsely claims to need `layout.auto.v1` would be rejected by readers
		// that could in fact open it perfectly well.
		const v2 = { ...baseIR(), version: "2" };
		const migrated = migrateCanvasIR(v2);
		expect(migrated.compatibility).toBeUndefined();
		expect(validateCanvasIRInvariants(migrated)).toEqual([]);
	});
});

/**
 * Severity — the distinction that keeps a rendering diagnostic from rejecting a
 * document at the trust boundary.
 *
 * `unsupported-frame-clip-shape` is the code that forced this: the frame-clip
 * resolver is documented as "pure, total, and never throwing — a frame it
 * cannot honour degrades rather than failing", and the IR's `looseObject`
 * posture exists so a newer peer's shape kind survives a round trip. Throwing
 * on that issue rejected exactly the forward-compatible documents both of those
 * were built to admit, and rejected them with the same violence as a duplicate
 * node id.
 */
describe("invariant severity", () => {
	function withUnhonourableClipShape(): CanvasIR {
		const page = createPage({ id: "p1" });
		let ir = createCanvasIR({ id: "doc", title: "t", pages: [page] });
		ir = insertNode(ir, {
			parentId: page.root.id,
			node: {
				...createFrame({ id: "f1", bounds: { width: 10, height: 10 } }),
				clip: true,
				// A kind from a build that shipped after this one.
				shape: { kind: "squircle" } as never,
			},
		});
		return ir;
	}

	it("stamps every issue with a severity", () => {
		const issues = validateCanvasIRInvariants(withUnhonourableClipShape());
		expect(issues).toHaveLength(1);
		expect(issues[0]).toMatchObject({
			code: "unsupported-frame-clip-shape",
			severity: "warning",
		});
	});

	it("does NOT throw at the trust boundary for a warning-only document", () => {
		expect(() =>
			assertCanvasIRInvariants(withUnhonourableClipShape()),
		).not.toThrow();
	});

	it("still throws for structural corruption, and reports only the errors", () => {
		// A duplicate node id AND an unhonourable clip shape in one document.
		const page = createPage({ id: "p1" });
		let ir = createCanvasIR({ id: "doc", title: "t", pages: [page] });
		ir = insertNode(ir, {
			parentId: page.root.id,
			node: {
				...createFrame({ id: "dupe", bounds: { width: 10, height: 10 } }),
				clip: true,
				shape: { kind: "squircle" } as never,
			},
		});
		ir = insertNode(ir, {
			parentId: page.root.id,
			node: createRect({ id: "dupe", bounds: { width: 10, height: 10 } }),
		});

		const issues = validateCanvasIRInvariants(ir);
		expect(issues.map((i) => i.code).sort()).toEqual([
			"duplicate-node-id",
			"unsupported-frame-clip-shape",
		]);

		let thrown: unknown;
		try {
			assertCanvasIRInvariants(ir);
		} catch (err) {
			thrown = err;
		}
		expect(thrown).toBeInstanceOf(CanvasIRInvariantError);
		// The warning rode along in `validate`, but it is not why the document was
		// rejected, so it is not in the error.
		expect((thrown as CanvasIRInvariantError).issues.map((i) => i.code)).toEqual(
			["duplicate-node-id"],
		);
	});
});
