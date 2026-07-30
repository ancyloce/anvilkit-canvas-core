/**
 * plan 0023 M3-01: `CanvasTreeAccess` — one read/write surface over a page
 * tree or a Component Source tree, delegating every write to the shared
 * `ir/mutations.ts` engine (no forked mutation logic).
 */

import { describe, expect, it } from "vitest";
import {
	createCanvasIR,
	createFrame,
	createGroup,
	createPage,
	createRect,
	createText,
} from "../../ir/builders.js";
import type {
	CanvasComponentDefinition,
	CanvasFrameNode,
	CanvasGroupNode,
	CanvasIR,
} from "../../ir/types.js";
import { createTreeAccess } from "../location.js";

function sampleIR(): CanvasIR {
	const page = createPage({ id: "p1" });
	page.root = createGroup({
		id: "pg-root",
		bounds: page.root.bounds,
		children: [
			createRect({ id: "r1", bounds: { width: 10, height: 10 } }),
			createGroup({
				id: "g1",
				bounds: { width: 50, height: 50 },
				children: [
					createText({
						id: "t1",
						bounds: { width: 100, height: 24 },
						text: "hi",
					}),
				],
			}),
		],
	});
	const definition: CanvasComponentDefinition = {
		id: "cmp-a",
		name: "Card",
		revision: 2,
		root: createFrame({
			id: "croot",
			bounds: { width: 120, height: 90 },
			children: [createRect({ id: "c1", bounds: { width: 10, height: 10 } })],
		}),
		properties: [],
	};
	const ir = createCanvasIR({
		id: "ir-1",
		pages: [page],
		now: () => "2026-07-29T00:00:00.000Z",
	});
	return { ...ir, components: { "cmp-a": definition } };
}

describe("createTreeAccess", () => {
	it("getRoot resolves a page root, a definition root, and undefined for a missing location", () => {
		const ir = sampleIR();
		expect(createTreeAccess(ir, { kind: "page", id: "p1" }).getRoot()?.id).toBe(
			"pg-root",
		);
		expect(
			createTreeAccess(ir, { kind: "component", id: "cmp-a" }).getRoot()?.id,
		).toBe("croot");
		expect(
			createTreeAccess(ir, { kind: "page", id: "nope" }).getRoot(),
		).toBeUndefined();
		expect(
			createTreeAccess(ir, { kind: "component", id: "nope" }).getRoot(),
		).toBeUndefined();
	});

	it("findNode is scoped to its tree and reports the in-scope parent (null at the root)", () => {
		const ir = sampleIR();
		const pageAccess = createTreeAccess(ir, { kind: "page", id: "p1" });
		const defAccess = createTreeAccess(ir, { kind: "component", id: "cmp-a" });

		expect(pageAccess.findNode("pg-root")?.parent).toBeNull();
		expect(pageAccess.findNode("t1")?.parent?.id).toBe("g1");
		// Cross-tree ids are invisible in both directions.
		expect(pageAccess.findNode("c1")).toBeUndefined();
		expect(defAccess.findNode("r1")).toBeUndefined();
		expect(defAccess.findNode("c1")?.parent?.id).toBe("croot");
	});

	it("replaceNode and updateChildren write through the shared mutation engine", () => {
		const ir = sampleIR();
		const defAccess = createTreeAccess(ir, { kind: "component", id: "cmp-a" });
		const swapped = defAccess.replaceNode(
			"c1",
			createText({
				id: "c1-text",
				bounds: { width: 20, height: 8 },
				text: "x",
			}),
		);
		const swappedDef = swapped.components?.["cmp-a"];
		if (!swappedDef) throw new Error("missing definition cmp-a");
		expect(
			(swappedDef.root as CanvasFrameNode).children.map((c) => c.id),
		).toEqual(["c1-text"]);
		// Same engine semantics as a direct scoped mutation: revision untouched.
		expect(swappedDef.revision).toBe(2);

		const pageAccess = createTreeAccess(ir, { kind: "page", id: "p1" });
		const reordered = pageAccess.updateChildren("pg-root", (children) =>
			[...children].reverse(),
		);
		const reorderedRoot: CanvasGroupNode | undefined = reordered.pages[0]?.root;
		expect(reorderedRoot?.children.map((c) => c.id)).toEqual(["g1", "r1"]);
	});

	it("writes against a missing location throw location-not-found instead of no-oping", () => {
		const ir = sampleIR();
		const access = createTreeAccess(ir, { kind: "component", id: "nope" });
		expect(() =>
			access.updateChildren("croot", (children) => [...children]),
		).toThrowError(expect.objectContaining({ code: "location-not-found" }));
	});
});
