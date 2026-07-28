import { describe, expect, it } from "vitest";
import {
	createCanvasIR,
	createFrame,
	createPage,
	createRect,
} from "../../ir/builders.js";
import { insertNode } from "../../ir/mutations.js";
import type { CanvasIR, CanvasNode } from "../../ir/types.js";
import { materializeCanvasLayout } from "../../layout/materialize.js";
import { resolveCanvasLayout } from "../../layout/resolve.js";
import { serializePageToSvg } from "../svg.js";

/**
 * @file T-M3-02 (TS-44) — the SVG resolved-document option and
 * `LAYOUT_UNRESOLVED`.
 *
 * The layout fixture's stored child geometry is deliberately STALE (both
 * children at x=0) while its resolved flow places the second child at x=50 —
 * so which geometry a given serialization used is directly observable in the
 * emitted `transform` attributes, not inferred.
 */

/** Horizontal frame, gap 10, two 40×20 children with stale stored transforms. */
function layoutDoc(): CanvasIR {
	const frame: CanvasNode = {
		...createFrame({ id: "f1", bounds: { width: 200, height: 100 } }),
		autoLayout: {
			version: 1,
			direction: "horizontal",
			padding: { top: 0, right: 0, bottom: 0, left: 0 },
			gap: 10,
			primaryAlign: "start",
			crossAlign: "start",
		},
		children: [
			createRect({ id: "r1", bounds: { width: 40, height: 20 } }),
			createRect({ id: "r2", bounds: { width: 40, height: 20 } }),
		],
	} as CanvasNode;
	const page = createPage({ id: "p1" });
	let ir = createCanvasIR({ id: "doc", title: "t", pages: [page] });
	ir = insertNode(ir, { parentId: page.root.id, node: frame });
	return ir;
}

function plainDoc(): CanvasIR {
	const page = createPage({ id: "p1" });
	let ir = createCanvasIR({ id: "doc", title: "t", pages: [page] });
	ir = insertNode(ir, {
		parentId: page.root.id,
		node: createRect({
			id: "r1",
			transform: { x: 25, y: 5 },
			bounds: { width: 40, height: 20 },
		}),
	});
	return ir;
}

function codes(warnings: readonly { code: string }[]): string[] {
	return warnings.map((w) => w.code);
}

describe("LAYOUT_UNRESOLVED", () => {
	it("fires for a layout-bearing page serialized without a resolved document", async () => {
		const ir = layoutDoc();
		const { svg, warnings } = await serializePageToSvg(ir, "p1");
		expect(codes(warnings)).toContain("LAYOUT_UNRESOLVED");
		// Stored (stale) geometry was emitted: r2 never moved to its flow slot.
		expect(svg).not.toContain("translate(50 0)");
		// Unstamped document → the fallback says the geometry is untrustworthy.
		const warning = warnings.find((w) => w.code === "LAYOUT_UNRESOLVED");
		expect(warning?.fallback).toContain("no materialization stamp");
	});

	it("does not fire when a resolved document covering the page is supplied", async () => {
		const ir = layoutDoc();
		const resolved = resolveCanvasLayout(ir, {});
		const { svg, warnings } = await serializePageToSvg(ir, "p1", {
			resolvedDocument: resolved,
		});
		expect(codes(warnings)).not.toContain("LAYOUT_UNRESOLVED");
		// Resolved geometry was emitted: r2 sits at x = 40 + gap 10.
		expect(svg).toContain("translate(50 0)");
	});

	it("fires when the resolved document does not cover the serialized page", async () => {
		const ir = layoutDoc();
		// Restricting resolution to a page that does not exist yields a resolved
		// document with no coverage of p1 — as unusable for p1 as no document.
		const resolved = resolveCanvasLayout(ir, { pageIds: ["p-other"] });
		const { warnings } = await serializePageToSvg(ir, "p1", {
			resolvedDocument: resolved,
		});
		expect(codes(warnings)).toContain("LAYOUT_UNRESOLVED");
	});

	it("fires on a materialized document with the cache-fallback message", async () => {
		const ir = layoutDoc();
		const materialized = materializeCanvasLayout(
			ir,
			resolveCanvasLayout(ir, {}),
		);
		const { svg, warnings } = await serializePageToSvg(materialized, "p1");
		const warning = warnings.find((w) => w.code === "LAYOUT_UNRESOLVED");
		expect(warning).toBeDefined();
		expect(warning?.fallback).toContain("materialized layout cache");
		// The materialized stored geometry IS the resolved geometry.
		expect(svg).toContain("translate(50 0)");
	});

	it("never fires for a document with no layout intent", async () => {
		const ir = plainDoc();
		const { warnings } = await serializePageToSvg(ir, "p1");
		expect(codes(warnings)).not.toContain("LAYOUT_UNRESOLVED");
	});

	it("treats an all-default layoutItem as no layout intent", async () => {
		const base = plainDoc();
		const page = base.pages[0];
		if (!page) throw new Error("fixture page missing");
		const rect = page.root.children[0];
		if (!rect) throw new Error("fixture rect missing");
		const ir: CanvasIR = {
			...base,
			pages: [
				{
					...page,
					root: {
						...page.root,
						children: [{ ...rect, layoutItem: {} } as CanvasNode],
					},
				},
			],
		};
		const { warnings } = await serializePageToSvg(ir, "p1");
		expect(codes(warnings)).not.toContain("LAYOUT_UNRESOLVED");
	});
});

describe("resolved-document geometry substitution", () => {
	it("changes nothing for a document without layout intent", async () => {
		const ir = plainDoc();
		const bare = await serializePageToSvg(ir, "p1");
		const withResolved = await serializePageToSvg(ir, "p1", {
			resolvedDocument: resolveCanvasLayout(ir, {}),
		});
		expect(withResolved.svg).toBe(bare.svg);
		expect(withResolved.warnings).toEqual(bare.warnings);
	});

	it("keeps style and content from the source node", async () => {
		const ir = layoutDoc();
		const resolved = resolveCanvasLayout(ir, {});
		const { svg } = await serializePageToSvg(ir, "p1", {
			resolvedDocument: resolved,
		});
		// Two rects and the frame still emit; only geometry moved.
		expect(svg).toContain("<rect");
		expect((svg.match(/<rect/g) ?? []).length).toBeGreaterThanOrEqual(2);
	});
});
