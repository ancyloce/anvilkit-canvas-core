import { describe, expect, it } from "vitest";
import { applyBrandColors } from "../../brand/apply.js";
import { generateBrandComplianceReport } from "../../brand/compliance.js";
import type { BrandKitDefinition } from "../../brand/types.js";
import {
	createCanvasIR,
	createFrame,
	createGroup,
	createRect,
} from "../builders.js";
import { validateCanvasIRInvariants } from "../invariants.js";
import type {
	CanvasComponentDefinition,
	CanvasComponentInstanceNode,
	CanvasFrameNode,
	CanvasGroupNode,
	CanvasIR,
	CanvasNode,
	CanvasRectNode,
} from "../types.js";
import {
	CanvasIRDepthError,
	MAX_TREE_DEPTH,
	walkDocument,
} from "../walkers.js";

/**
 * M1-08 (plan 0023): `walkDocument` reaches every tree the document owns —
 * pages in document order, then Source trees in sorted component-id order —
 * and the consumers migrated onto it (invariants, brand transforms, brand
 * compliance) stop being Registry-blind. `walk` itself stays pages-only by
 * contract (pinned by the existing ir-walkers suite).
 */

const NOW = () => "2026-07-29T00:00:00.000Z";

function rect(id: string, fill?: string): CanvasRectNode {
	const node = createRect({ id, bounds: { width: 10, height: 10 } });
	return fill === undefined ? node : { ...node, fill };
}

function definitionOf(id: string, root: CanvasNode): CanvasComponentDefinition {
	return { id, name: id, revision: 1, root, properties: [] };
}

function instanceNode(
	id: string,
	componentId: string,
	overrides?: CanvasComponentInstanceNode["overrides"],
): CanvasComponentInstanceNode {
	return {
		id,
		type: "component-instance",
		transform: { x: 0, y: 0, rotation: 0, scaleX: 1, scaleY: 1 },
		bounds: { width: 10, height: 10 },
		componentId,
		...(overrides ? { overrides } : {}),
	};
}

function docWith(
	pageChildren: CanvasNode[],
	components?: Record<string, CanvasComponentDefinition>,
): CanvasIR {
	const ir = createCanvasIR({ id: "doc", now: NOW });
	const root = ir.pages[0]?.root as CanvasGroupNode;
	root.children.push(...pageChildren);
	return components ? { ...ir, components } : ir;
}

const kit: BrandKitDefinition = {
	id: "kit",
	name: "Kit",
	logos: [],
	colors: [{ id: "c-red", name: "Red", value: "#ff0000" }],
	fonts: [],
	typography: [],
	rules: [],
};

describe("walkDocument (M1-08)", () => {
	it("visits pages in document order, then definitions in sorted component-id order", () => {
		const doc = docWith([rect("p-r1")], {
			"cmp-b": definitionOf("cmp-b", rect("b-root")),
			"cmp-a": definitionOf("cmp-a", rect("a-root")),
		});
		const firstPage = doc.pages[0];
		if (!firstPage) throw new Error("fixture page missing");
		const visits: string[] = [];
		walkDocument(doc, ({ node, location, page }) => {
			visits.push(`${location.kind}:${location.id}:${node.id}`);
			expect(page !== undefined).toBe(location.kind === "page");
		});
		expect(visits).toEqual([
			`page:${firstPage.id}:${(firstPage.root as CanvasGroupNode).id}`,
			`page:${firstPage.id}:p-r1`,
			"component:cmp-a:a-root",
			"component:cmp-b:b-root",
		]);
	});

	it("gives each Source tree its own hostile-depth budget", () => {
		let deep: CanvasNode = rect("leaf");
		for (let i = 0; i <= MAX_TREE_DEPTH; i += 1) {
			deep = createGroup({ id: `g${i}`, children: [deep] });
		}
		const doc = docWith([], { "cmp-deep": definitionOf("cmp-deep", deep) });
		expect(() => walkDocument(doc, () => undefined)).toThrow(
			CanvasIRDepthError,
		);
	});
});

describe("invariants over walkDocument (INV-2, T-DOC-4)", () => {
	it("detects a duplicate node id spanning a page and a definition, with a component location", () => {
		const doc = docWith([rect("shared-id")], {
			"cmp-a": definitionOf("cmp-a", rect("shared-id")),
		});
		const issue = validateCanvasIRInvariants(doc).find(
			(i) => i.code === "duplicate-node-id",
		);
		expect(issue).toBeDefined();
		expect(issue?.message).toContain("INV-2");
		expect(issue?.location).toEqual({ kind: "component", id: "cmp-a" });
	});

	it("keeps the page-only duplicate message byte-identical to pre-M1-08", () => {
		const doc = docWith([rect("dup"), rect("dup")]);
		const issue = validateCanvasIRInvariants(doc).find(
			(i) => i.code === "duplicate-node-id",
		);
		expect(issue?.message).toBe(
			`Node id "dup" appears 2 times (page(s): ${doc.pages[0]?.id}, ${doc.pages[0]?.id}) — node ids must be unique across the whole document.`,
		);
		expect(issue?.location).toBeUndefined();
	});

	it("an asset referenced only from a Source tree is not dangling (T-DOC-4)", () => {
		const image = {
			id: "def-img",
			type: "image",
			transform: { x: 0, y: 0, rotation: 0, scaleX: 1, scaleY: 1 },
			bounds: { width: 10, height: 10 },
			assetId: "asset-in-def",
		} as CanvasNode;
		const doc = docWith([], {
			"cmp-a": definitionOf("cmp-a", image),
		});
		// Referenced but missing from ir.assets → MUST be reported dangling;
		// a Registry-blind pass would never even see the reference.
		const issues = validateCanvasIRInvariants(doc);
		expect(
			issues.some(
				(i) =>
					i.code === "dangling-asset-reference" &&
					i.message.includes("asset-in-def"),
			),
		).toBe(true);
	});

	it("an asset referenced only from an image override is not dangling", () => {
		const doc = docWith(
			[
				instanceNode("inst-1", "cmp-a", {
					"prop-media": { kind: "image", assetId: "asset-in-override" },
				}),
			],
			{ "cmp-a": definitionOf("cmp-a", rect("a-root")) },
		);
		const issues = validateCanvasIRInvariants(doc);
		expect(
			issues.some(
				(i) =>
					i.code === "dangling-asset-reference" &&
					i.message.includes("asset-in-override"),
			),
		).toBe(true);
	});

	it("layout intent only inside a Source tree still requires the capability", () => {
		const frame = createFrame({
			id: "def-frame",
			bounds: { width: 100, height: 100 },
		});
		const withLayout: CanvasFrameNode = {
			...frame,
			autoLayout: {
				version: 1,
				direction: "horizontal",
				padding: { top: 0, right: 0, bottom: 0, left: 0 },
				gap: 0,
				primaryAlign: "start",
				crossAlign: "start",
			},
		};
		const doc = docWith([], {
			"cmp-a": definitionOf("cmp-a", withLayout),
		});
		const issue = validateCanvasIRInvariants(doc).find(
			(i) => i.code === "missing-required-capability",
		);
		expect(issue).toBeDefined();
		expect(issue?.location).toEqual({ kind: "component", id: "cmp-a" });
		expect(issue?.pageId).toBeUndefined();
	});
});

describe("brand transforms over walkDocument (M1-08)", () => {
	it("applyBrandColors reaches a Source tree: tokenizes, bumps revision, never mutates the input", () => {
		const doc = docWith([], {
			"cmp-a": definitionOf(
				"cmp-a",
				createGroup({ id: "a-root", children: [rect("a-fill", "#FF0000")] }),
			),
		});
		const before = JSON.parse(JSON.stringify(doc));

		const result = applyBrandColors(doc, kit);

		// Input untouched (INV-4)…
		expect(JSON.parse(JSON.stringify(doc))).toEqual(before);
		// …output definition tokenized with a bumped revision…
		const definition = result.document.components?.["cmp-a"];
		if (!definition) throw new Error("definition missing after transform");
		expect(definition.revision).toBe(2);
		const patched = (definition.root as CanvasGroupNode)
			.children[0] as CanvasRectNode;
		expect(patched.fill).toEqual({
			type: "brand-token",
			tokenType: "color",
			id: "c-red",
		});
		// …and the page batch stays null: no page node changed, and Source
		// patches are structural until the M3 component commands.
		expect(result.command).toBeNull();
		expect(result.report.affectedNodeIds).toEqual(["a-fill"]);
	});

	it("applyBrandColors tokenizes a literal color OVERRIDE on an instance", () => {
		const doc = docWith(
			[
				instanceNode("inst-1", "cmp-a", {
					"prop-bg": { kind: "color", value: "#ff0000" },
					"prop-title": {
						kind: "text",
						value: { kind: "plain", text: "hi" },
					},
				}),
			],
			{ "cmp-a": definitionOf("cmp-a", rect("a-root")) },
		);
		const result = applyBrandColors(doc, kit);
		const resultRoot = result.document.pages[0]?.root as
			| CanvasGroupNode
			| undefined;
		const instance = resultRoot?.children.find(
			(n) => n.type === "component-instance",
		) as CanvasComponentInstanceNode;
		expect(instance.overrides?.["prop-bg"]).toEqual({
			kind: "color",
			value: { type: "brand-token", tokenType: "color", id: "c-red" },
		});
		// Non-color entries ride through verbatim.
		expect(instance.overrides?.["prop-title"]).toEqual({
			kind: "text",
			value: { kind: "plain", text: "hi" },
		});
		// A page-node change IS command-based.
		expect(result.command?.commands).toHaveLength(1);
	});

	it("compliance audits Source trees", () => {
		const doc = docWith([], {
			"cmp-a": definitionOf("cmp-a", rect("off-brand", "#123456")),
		});
		const report = generateBrandComplianceReport(doc, kit);
		expect(report.issues.some((issue) => issue.nodeId === "off-brand")).toBe(
			true,
		);
	});
});
