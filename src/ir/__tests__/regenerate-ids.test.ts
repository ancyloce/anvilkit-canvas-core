import fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
	createGroup,
	createPage,
	createRect,
	createText,
} from "../builders.js";
import { regenerateNodeIds } from "../regenerate-ids.js";
import type { CanvasNode } from "../types.js";
import { CanvasIRDepthError, isContainerNode, walkPage } from "../walkers.js";

function seqFactory(prefix = "n"): () => string {
	let i = 0;
	return () => `${prefix}${++i}`;
}

function fixture() {
	return createGroup({
		id: "root",
		children: [
			createRect({ id: "r1", transform: { x: 5 } }),
			createGroup({
				id: "inner",
				children: [
					createRect({ id: "r2", transform: { x: 7 } }),
					createText({ id: "t1", text: "hello" }),
				],
			}),
		],
	});
}

/** Collect ids + kinds in pre-order (parent first, children in order). */
function preorder(node: CanvasNode): { id: string; type: string }[] {
	const out: { id: string; type: string }[] = [];
	const visit = (n: CanvasNode): void => {
		out.push({ id: n.id, type: n.type });
		if (isContainerNode(n)) {
			for (const c of n.children) visit(c);
		}
	};
	visit(node);
	return out;
}

describe("regenerateNodeIds", () => {
	it("assigns fresh ids in pre-order and preserves structure + fields", () => {
		const input = fixture();
		const { node, idMap } = regenerateNodeIds(input, {
			idFactory: seqFactory(),
		});
		expect(preorder(node)).toEqual([
			{ id: "n1", type: "group" },
			{ id: "n2", type: "rect" },
			{ id: "n3", type: "group" },
			{ id: "n4", type: "rect" },
			{ id: "n5", type: "text" },
		]);
		expect(Object.fromEntries(idMap)).toEqual({
			root: "n1",
			r1: "n2",
			inner: "n3",
			r2: "n4",
			t1: "n5",
		});
		// Non-id fields survive untouched.
		expect(preorder(node).length).toBe(5);
		const remapped = node.children[0];
		if (!remapped || remapped.type !== "rect") throw new Error("shape drift");
		expect(remapped.transform.x).toBe(5);
	});

	it("never mutates the input subtree", () => {
		const input = fixture();
		const before = JSON.stringify(input);
		regenerateNodeIds(input, { idFactory: seqFactory() });
		expect(JSON.stringify(input)).toBe(before);
	});

	it("preserves the container type of the input (generic)", () => {
		const group = regenerateNodeIds(fixture()).node;
		// Type-level: RegenerateNodeIdsResult<CanvasGroupNode>.
		expect(group.type).toBe("group");
		expect(group.children).toHaveLength(2);
	});

	it("throws CanvasIRDepthError on hostile depth", () => {
		let node: CanvasNode = createRect({ id: "leaf" });
		for (let i = 0; i < 66; i++) {
			node = createGroup({ id: `g${i}`, children: [node] });
		}
		expect(() => regenerateNodeIds(node)).toThrow(CanvasIRDepthError);
	});

	it("matches walkPage visitation order (walker parity)", () => {
		const input = fixture();
		const { node } = regenerateNodeIds(input, { idFactory: seqFactory() });
		const page = createPage({ id: "p" });
		page.root = node;
		const walked: string[] = [];
		walkPage(page, ({ node: n }) => walked.push(n.id));
		expect(walked).toEqual(["n1", "n2", "n3", "n4", "n5"]);
	});

	// ── property-based ────────────────────────────────────────────────────────
	type Spec = { leaf: true } | { leaf: false; children: Spec[] };

	const specArb: fc.Arbitrary<Spec> = fc.letrec<{ spec: Spec }>((tie) => ({
		spec: fc.oneof(
			{ maxDepth: 4, withCrossShrink: true },
			fc.constant<Spec>({ leaf: true }),
			fc
				.array(tie("spec"), { minLength: 0, maxLength: 4 })
				.map((children): Spec => ({ leaf: false, children })),
		),
	})).spec;

	function buildFromSpec(spec: Spec, nextId: () => string): CanvasNode {
		if (spec.leaf) return createRect({ id: nextId() });
		return createGroup({
			id: nextId(),
			children: spec.children.map((c) => buildFromSpec(c, nextId)),
		});
	}

	it("property: bijective id map, disjoint id sets, isomorphic shape", () => {
		fc.assert(
			fc.property(specArb, (spec) => {
				const input = buildFromSpec(spec, seqFactory("old-"));
				const oldIds = preorder(input).map((n) => n.id);
				const { node, idMap } = regenerateNodeIds(input, {
					idFactory: seqFactory("new-"),
				});
				const newEntries = preorder(node);
				const newIds = newEntries.map((n) => n.id);

				// One idMap entry per node; keys are exactly the old ids.
				expect(idMap.size).toBe(oldIds.length);
				expect([...idMap.keys()].sort()).toEqual([...oldIds].sort());
				// Every new id is fresh (disjoint from every old id) and unique.
				expect(newIds.some((id) => oldIds.includes(id))).toBe(false);
				expect(new Set(newIds).size).toBe(newIds.length);
				// Shape isomorphism: pre-order kind sequence is unchanged and the
				// idMap translates the old pre-order exactly onto the new one.
				expect(newEntries.map((n) => n.type)).toEqual(
					preorder(input).map((n) => n.type),
				);
				expect(oldIds.map((id) => idMap.get(id))).toEqual(newIds);
			}),
		);
	});
});
