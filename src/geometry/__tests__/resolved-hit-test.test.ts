import { describe, expect, it } from "vitest";
import {
	createCanvasIR,
	createGroup,
	createPage,
	createRect,
} from "../../ir/builders.js";
import { insertNode } from "../../ir/mutations.js";
import type { CanvasIR, CanvasNode } from "../../ir/types.js";
import { resolveCanvasLayout } from "../../layout/resolve.js";
import type { CanvasResolvedNodeRecord } from "../../layout/types.js";
import {
	childrenBoundsFromExtents,
	multiplyMatrix,
	toAffineMatrix,
} from "../affine.js";
import {
	hitTestResolved,
	marqueeHits,
	marqueeHitsResolved,
	nodeWorldAabb,
	pointInNode,
	pointInResolvedNode,
	type ResolvedHitTarget,
} from "../hit-test.js";
import { snapRectFromExtent } from "../snap.js";

/**
 * @file T-M3-01 (TS-40) — resolved variants of the core geometry helpers.
 *
 * The raw helpers stay valid for documents with no layout intent; the resolved
 * variants consume the resolver's precomputed world geometry. These tests pin
 * both halves of that contract: parity with the raw path where the raw path is
 * correct (top-level nodes), and hand-derived world coordinates where the raw
 * path never composed ancestors (nested transformed trees — the disagreement
 * the M0 coordinate suite documents and M3 exists to close).
 */

/**
 * A group at (10,100) containing a 20×40 rect at local (100,0) rotated 90°.
 *
 * Hand-derived: the rect's world origin is (110,100); rotating (20,0)→(0,20)
 * and (0,40)→(-40,0), its corners land at (110,100), (110,120), (70,120),
 * (70,100) — so the world AABB is 70..110 × 100..120.
 */
function nestedFixture(): CanvasIR {
	const rect = createRect({
		id: "r1",
		transform: { x: 100, y: 0, rotation: 90 },
		bounds: { width: 20, height: 40 },
	});
	const group = {
		...createGroup({ id: "g1", transform: { x: 10, y: 100 } }),
		children: [rect] as CanvasNode[],
	};
	const page = createPage({ id: "p1" });
	let ir = createCanvasIR({ id: "doc", title: "t", pages: [page] });
	ir = insertNode(ir, { parentId: page.root.id, node: group });
	return ir;
}

function recordOf(ir: CanvasIR, nodeId: string): CanvasResolvedNodeRecord {
	const resolved = resolveCanvasLayout(ir, {});
	const record = resolved.records.get(nodeId as never);
	if (!record) throw new Error(`no resolved record for ${nodeId}`);
	return record;
}

describe("pointInResolvedNode", () => {
	it("hits a nested rotated node where it actually is in world space", () => {
		const record = recordOf(nestedFixture(), "r1");
		// (100,110): inverse-translate → (-10,10); inverse-rotate 90° → (10,10),
		// inside the 20×40 local box.
		expect(pointInResolvedNode(record, { x: 100, y: 110 })).toBe(true);
		// Just outside the rotated box (right of the world AABB).
		expect(pointInResolvedNode(record, { x: 111, y: 110 })).toBe(false);
		// Inside the stored-geometry naive box (110..130 × 100..140) but NOT the
		// rotated reality — the raw path with no parent matrix gets this wrong.
		expect(pointInResolvedNode(record, { x: 120, y: 130 })).toBe(false);
	});

	it("agrees with the raw path given the composed parent matrix", () => {
		const ir = nestedFixture();
		const record = recordOf(ir, "r1");
		const page = ir.pages[0];
		if (!page) throw new Error("fixture page missing");
		const group = page.root.children[0];
		if (!group || group.type !== "group")
			throw new Error("fixture group missing");
		const rect = group.children[0];
		if (!rect) throw new Error("fixture rect missing");
		const parentMatrix = multiplyMatrix(
			toAffineMatrix(page.root.transform),
			toAffineMatrix(group.transform),
		);
		for (let x = 60; x <= 130; x += 7) {
			for (let y = 90; y <= 150; y += 7) {
				expect(pointInResolvedNode(record, { x, y })).toBe(
					pointInNode(rect, { x, y }, parentMatrix),
				);
			}
		}
	});

	it("contains nothing when the resolved transform is degenerate", () => {
		const rect = createRect({
			id: "r1",
			transform: { x: 0, y: 0, scaleX: 0 },
			bounds: { width: 20, height: 40 },
		});
		const page = createPage({ id: "p1" });
		let ir = createCanvasIR({ id: "doc", title: "t", pages: [page] });
		ir = insertNode(ir, { parentId: page.root.id, node: rect });
		const record = recordOf(ir, "r1");
		expect(pointInResolvedNode(record, { x: 0, y: 0 })).toBe(false);
	});
});

describe("hitTestResolved", () => {
	function targets(
		ir: CanvasIR,
		ids: readonly string[],
	): CanvasResolvedNodeRecord[] {
		const resolved = resolveCanvasLayout(ir, {});
		return ids.map((id) => {
			const record = resolved.records.get(id as never);
			if (!record) throw new Error(`no resolved record for ${id}`);
			return record;
		});
	}

	function overlappingDoc(
		overrides: readonly Partial<CanvasNode>[] = [{}, {}],
	): CanvasIR {
		const page = createPage({ id: "p1" });
		let ir = createCanvasIR({ id: "doc", title: "t", pages: [page] });
		overrides.forEach((override, i) => {
			ir = insertNode(ir, {
				parentId: page.root.id,
				node: {
					...createRect({
						id: `r${i}`,
						transform: { x: 0, y: 0 },
						bounds: { width: 50, height: 50 },
					}),
					...override,
				} as CanvasNode,
			});
		});
		return ir;
	}

	it("returns the top-most (last painted) overlapping record", () => {
		const ir = overlappingDoc();
		const [a, b] = targets(ir, ["r0", "r1"]);
		const hit = hitTestResolved([a, b] as CanvasResolvedNodeRecord[], {
			x: 10,
			y: 10,
		});
		expect(hit?.sourceNodeId).toBe("r1");
	});

	it("honours skipInvisible and skipLocked from the source node", () => {
		const ir = overlappingDoc([{}, { visible: false }, { locked: true }]);
		const all = targets(ir, ["r0", "r1", "r2"]);
		const hit = hitTestResolved(
			all,
			{ x: 10, y: 10 },
			{
				skipInvisible: true,
				skipLocked: true,
			},
		);
		expect(hit?.sourceNodeId).toBe("r0");
		// Without skip flags the locked top-most record wins.
		expect(hitTestResolved(all, { x: 10, y: 10 })?.sourceNodeId).toBe("r2");
	});
});

describe("marqueeHitsResolved", () => {
	it("uses the resolver's ancestor-composed world AABB", () => {
		const record = recordOf(nestedFixture(), "r1");
		expect(record.geometry.worldAabb).toEqual({
			minX: 70,
			minY: 100,
			maxX: 110,
			maxY: 120,
		});
		// Overlaps the true world box but NOT the un-composed local extent
		// (60..100 × -20..0 relative world) the raw no-parent path would use.
		const overlap = marqueeHitsResolved([record], {
			minX: 60,
			minY: 95,
			maxX: 80,
			maxY: 125,
		});
		expect(overlap.map((r) => r.sourceNodeId)).toEqual(["r1"]);
		// Partial overlap fails `contained`; the exact box passes it.
		expect(
			marqueeHitsResolved(
				[record],
				{ minX: 60, minY: 95, maxX: 80, maxY: 125 },
				{ contained: true },
			),
		).toEqual([]);
		expect(
			marqueeHitsResolved(
				[record],
				{ minX: 70, minY: 100, maxX: 110, maxY: 120 },
				{ contained: true },
			).map((r) => r.sourceNodeId),
		).toEqual(["r1"]);
	});

	it("agrees with raw marqueeHits for top-level nodes", () => {
		const rect = createRect({
			id: "r1",
			transform: { x: 30, y: 40, rotation: 45 },
			bounds: { width: 20, height: 10 },
		});
		const page = createPage({ id: "p1" });
		let ir = createCanvasIR({ id: "doc", title: "t", pages: [page] });
		ir = insertNode(ir, { parentId: page.root.id, node: rect });
		const record = recordOf(ir, "r1");
		expect(record.geometry.worldAabb).toEqual(nodeWorldAabb(rect));
		const marquee = { minX: 0, minY: 0, maxX: 35, maxY: 45 };
		expect(
			marqueeHitsResolved([record], marquee).map((r) => r.sourceNodeId),
		).toEqual(marqueeHits([rect], marquee).map((n) => n.id));
	});
});

describe("snapRectFromExtent", () => {
	it("converts an extent into the equivalent SnapRect", () => {
		expect(
			snapRectFromExtent({ minX: 70, minY: 100, maxX: 110, maxY: 120 }),
		).toEqual({
			x: 70,
			y: 100,
			width: 40,
			height: 20,
		});
	});
});

describe("childrenBoundsFromExtents", () => {
	it("anchors to the origin for fully-positive content", () => {
		expect(
			childrenBoundsFromExtents([{ minX: 10, minY: 5, maxX: 30, maxY: 25 }]),
		).toEqual({ width: 30, height: 25 });
	});

	it("covers negative spill", () => {
		expect(
			childrenBoundsFromExtents([
				{ minX: -5, minY: -2, maxX: 30, maxY: 25 },
				{ minX: 0, minY: 0, maxX: 12, maxY: 40 },
			]),
		).toEqual({ width: 35, height: 42 });
	});

	it("returns a zero box for no extents", () => {
		expect(childrenBoundsFromExtents([])).toEqual({ width: 0, height: 0 });
	});
});

// Compile-time: the real resolved record satisfies the structural target shape.
const _assertAssignable = (
	record: CanvasResolvedNodeRecord,
): ResolvedHitTarget => record;
void _assertAssignable;
