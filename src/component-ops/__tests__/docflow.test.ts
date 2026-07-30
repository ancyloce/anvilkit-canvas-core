/**
 * plan 0023 M3-09..M3-12 (T-DOC-1..3): components survive every document
 * flow — same-document clipboard, page duplicate, template instantiation
 * (definitions ride in `document.components`, remapped once), campaign
 * resize (instances stay by reference), and export-variant materialization
 * (D-2: materialize, drop the Registry, declare neither capability).
 */

import { describe, expect, it } from "vitest";
import {
	materializeClipboardNodes,
	validateClipboardPayload,
} from "../../clipboard/payload.js";
import { applyCommand } from "../../commands/runtime.js";
import { applyCommands } from "../../commands/transaction.js";
import { collectNestedComponentIds } from "../../components/graph.js";
import {
	createCanvasIR,
	createComponentInstance,
	createFrame,
	createGroup,
	createPage,
	createRect,
	createText,
} from "../../ir/builders.js";
import type {
	CanvasComponentDefinition,
	CanvasComponentInstanceNode,
	CanvasIR,
	CanvasNode,
} from "../../ir/types.js";
import {
	findNodeInSubtree,
	isContainerNode,
	walkDocument,
} from "../../ir/walkers.js";
import { instantiateTemplate } from "../../templates/instantiate.js";
import { resizeToVariants } from "../../templates/resize-to-variants.js";
import type { CanvasTemplateDefinition } from "../../templates/types.js";
import { findForeignComponentRefs } from "../clipboard.js";
import { materializeExportVariant } from "../export-variant.js";

const NOW = () => "2026-07-29T00:00:00.000Z";

const OVERRIDES = {
	"p-txt": {
		kind: "text",
		value: { kind: "plain", text: "customized" },
	},
} as const;

function makeDefinition(): CanvasComponentDefinition {
	return {
		id: "cmp-a",
		name: "Card",
		revision: 2,
		root: createFrame({
			id: "a-root",
			bounds: { width: 60, height: 30 },
			children: [
				createText({
					id: "a-txt",
					bounds: { width: 60, height: 30 },
					text: "default",
				}),
			],
		}),
		properties: [
			{
				id: "p-txt",
				name: "Text",
				nodeId: "a-txt",
				kind: "text",
				targetKind: "text",
			},
		],
	};
}

function makeIR(): CanvasIR {
	const page = createPage({ id: "p1" });
	page.root = createGroup({
		id: "pg-root",
		bounds: page.root.bounds,
		children: [
			createComponentInstance({
				id: "inst-a",
				componentId: "cmp-a",
				bounds: { width: 60, height: 30 },
				overrides: OVERRIDES,
			}),
			createRect({ id: "r1", bounds: { width: 5, height: 5 } }),
		],
	});
	const ir = createCanvasIR({ id: "doc-1", pages: [page], now: NOW });
	return { ...ir, components: { "cmp-a": makeDefinition() } };
}

function instanceNodes(
	node: CanvasNode,
	out: CanvasComponentInstanceNode[] = [],
) {
	if (node.type === "component-instance") out.push(node);
	if (isContainerNode(node)) {
		for (const child of node.children) instanceNodes(child, out);
	}
	return out;
}

describe("M3-09 same-document clipboard (T-DOC-1)", () => {
	it("paste keeps componentId and the override map verbatim under a fresh node id (INV-9)", () => {
		const ir = makeIR();
		const instance = instanceNodes(ir.pages[0]?.root as CanvasNode)[0];
		if (!instance) throw new Error("missing fixture instance");
		const payload = validateClipboardPayload({
			version: 1,
			sourceDocumentId: "doc-1",
			nodes: [instance],
			assetRefs: {},
			bounds: { x: 0, y: 0, width: 60, height: 30 },
		});
		const pasted = materializeClipboardNodes(payload, ir);
		const node = pasted.nodes[0] as CanvasComponentInstanceNode;
		expect(node.id).not.toBe("inst-a");
		expect(node.componentId).toBe("cmp-a");
		expect(node.overrides).toEqual(OVERRIDES);
		expect(pasted.assetsToAdd).toEqual({});
	});

	it("cross-document paste re-keys an override's image asset alongside node fields", () => {
		const foreignInstance = createComponentInstance({
			id: "f-inst",
			componentId: "cmp-a",
			bounds: { width: 10, height: 10 },
			overrides: { "p-img": { kind: "image", assetId: "asset-1" } },
		});
		const payload = validateClipboardPayload({
			version: 1,
			sourceDocumentId: "other-doc",
			nodes: [foreignInstance],
			assetRefs: { "asset-1": { id: "asset-1", uri: "https://a/img.png" } },
			bounds: { x: 0, y: 0, width: 10, height: 10 },
		});
		const target: CanvasIR = {
			...makeIR(),
			assets: { "asset-1": { id: "asset-1", uri: "https://b/DIFFERENT.png" } },
		};
		const pasted = materializeClipboardNodes(payload, target, {
			idFactory: (() => {
				let n = 0;
				return () => `fresh-${++n}`;
			})(),
		});
		const node = pasted.nodes[0] as CanvasComponentInstanceNode;
		const rewritten = Object.keys(pasted.assetsToAdd)[0] as string;
		expect(rewritten).toBeDefined();
		expect(node.overrides?.["p-img"]).toEqual({
			kind: "image",
			assetId: rewritten,
		});
	});

	it("findForeignComponentRefs flags instances the target registry cannot resolve", () => {
		const ir = makeIR();
		const known = instanceNodes(ir.pages[0]?.root as CanvasNode);
		expect(findForeignComponentRefs(known, ir.components)).toEqual([]);
		const foreign = createComponentInstance({
			id: "f1",
			componentId: "cmp-foreign",
			bounds: { width: 1, height: 1 },
		});
		expect(findForeignComponentRefs([foreign], ir.components)).toEqual([
			{ instanceId: "f1", componentId: "cmp-foreign" },
		]);
	});
});

describe("M3-10 page duplicate (T-DOC-2)", () => {
	it("remaps instance node ids but never componentId, override keys, or the Registry", () => {
		const ir = makeIR();
		const { ir: next } = applyCommand(
			ir,
			{ type: "page.duplicate", sourcePageId: "p1", newPageId: "p2" },
			{ now: NOW },
		);
		expect(next.components).toBe(ir.components);
		const dupRoot = next.pages[1]?.root as CanvasNode;
		const copies = instanceNodes(dupRoot);
		expect(copies).toHaveLength(1);
		const copy = copies[0] as CanvasComponentInstanceNode;
		expect(copy.id).not.toBe("inst-a");
		expect(copy.componentId).toBe("cmp-a");
		expect(copy.overrides).toEqual(OVERRIDES);
	});
});

describe("M3-11 template instantiation (T-DOC-3)", () => {
	function makeTemplate(): CanvasTemplateDefinition {
		return {
			id: "tpl-1",
			version: "1",
			title: "Card template",
			category: "test",
			tags: [],
			supportedSizes: [],
			document: makeIR(),
			variables: [],
			editableSlots: [],
			lockedNodeIds: [],
		};
	}

	it("remaps definitions, Source nodes, properties, and page instances through one map", () => {
		const result = instantiateTemplate(makeTemplate(), { nowFactory: NOW });
		expect(result.warnings).toEqual([]);
		const registry = result.document.components ?? {};
		const importedIds = Object.keys(registry);
		expect(importedIds).toHaveLength(1);
		const importedId = importedIds[0] as string;
		expect(importedId).not.toBe("cmp-a");
		const imported = registry[importedId] as CanvasComponentDefinition;
		expect(imported.id).toBe(importedId);
		expect(imported.root.id).not.toBe("a-root");
		// The property binding followed the Source remap; the Property ID is stable.
		expect(imported.properties[0]?.id).toBe("p-txt");
		expect(
			findNodeInSubtree(
				imported.root,
				imported.properties[0]?.nodeId as string,
			),
		).not.toBeNull();
		// Page instances point at the IMPORTED id, overrides intact.
		const instances = instanceNodes(
			result.document.pages[0]?.root as CanvasNode,
		);
		expect(instances[0]?.componentId).toBe(importedId);
		expect(instances[0]?.overrides).toEqual(OVERRIDES);
		// The command imports definitions BEFORE pages.
		expect(result.command.commands[0]?.type).toBe("component.create");
		expect(result.command.commands.at(-1)?.type).toBe("page.create");
	});

	it("instantiating the same template twice into one document never collides (always-remap)", () => {
		const target = makeIR();
		const first = instantiateTemplate(makeTemplate(), { nowFactory: NOW });
		const second = instantiateTemplate(makeTemplate(), { nowFactory: NOW });
		const afterFirst = applyCommands(target, [first.command], { now: NOW });
		const afterBoth = applyCommands(afterFirst.ir, [second.command], {
			now: NOW,
		});
		// Original + two imports, all disjoint.
		expect(Object.keys(afterBoth.ir.components ?? {})).toHaveLength(3);
		// Every instance everywhere resolves against the merged registry.
		const registry = afterBoth.ir.components ?? {};
		walkDocument(afterBoth.ir, ({ node }) => {
			if (node.type === "component-instance") {
				expect(registry[node.componentId]).toBeDefined();
			}
		});
	});

	it("a template with a broken component graph degrades with a typed warning", () => {
		const template = makeTemplate();
		const cyclic = makeIR();
		const def = cyclic.components?.["cmp-a"] as CanvasComponentDefinition;
		template.document = {
			...cyclic,
			components: {
				"cmp-a": {
					...def,
					root: createFrame({
						id: "a-root",
						bounds: { width: 10, height: 10 },
						children: [
							createComponentInstance({
								id: "a-self",
								componentId: "cmp-a",
								bounds: { width: 5, height: 5 },
							}),
						],
					}),
				},
			},
		};
		const result = instantiateTemplate(template, { nowFactory: NOW });
		expect(
			result.warnings.some((w) => w.code === "component-graph-invalid"),
		).toBe(true);
	});
});

describe("M3-12 document kinds (T-DOC-3, D-2)", () => {
	it("resizeToVariants keeps instances BY REFERENCE: one Source, no duplication", () => {
		const ir = makeIR();
		const result = resizeToVariants(ir, "p1", [
			{
				id: "preset-1",
				version: "1",
				label: "Square",
				width: 400,
				height: 400,
				unit: "px",
			},
		]);
		const { ir: next } = applyCommand(ir, result.command, { now: NOW });
		expect(next.components).toBe(ir.components);
		const variantInstances = instanceNodes(next.pages[1]?.root as CanvasNode);
		expect(variantInstances).toHaveLength(1);
		expect(variantInstances[0]?.componentId).toBe("cmp-a");
		expect(variantInstances[0]?.id).not.toBe("inst-a");
	});

	it("export-variant materializes everything: no Registry, no instances, no component capabilities", () => {
		const withCompat: CanvasIR = {
			...makeIR(),
			compatibility: {
				schemaVersion: "3",
				minReaderSchemaVersion: "3",
				requiredCapabilities: [
					"layout.auto.v1",
					"components.local.v1",
					"components.overrides.v1",
				],
			},
		};
		const variant = materializeExportVariant(withCompat, { now: NOW });
		expect(variant.documentKind).toBe("export-variant");
		expect("components" in variant).toBe(false);
		expect(variant.compatibility?.requiredCapabilities).toEqual([
			"layout.auto.v1",
		]);
		let remaining = 0;
		walkDocument(variant, ({ node }) => {
			if (node.type === "component-instance") remaining += 1;
		});
		expect(remaining).toBe(0);
		// The materialized content carries the override that was on the instance.
		const texts: string[] = [];
		walkDocument(variant, ({ node }) => {
			if (node.type === "text") texts.push(node.text);
		});
		expect(texts).toContain("customized");
		// design/template-instance documents are untouched by construction: the
		// transform is only ever invoked to derive an export variant.
		expect(withCompat.components).toBeDefined();
	});

	it("export-variant materialization fails loudly on a broken reference", () => {
		const broken = applyCommand(
			makeIR(),
			{
				type: "node.update",
				nodeId: "inst-a",
				kind: "component-instance",
				patch: { componentId: "cmp-ghost" },
			},
			{ now: NOW },
		).ir;
		expect(() => materializeExportVariant(broken, { now: NOW })).toThrowError(
			/export-variant materialization failed/,
		);
	});
});
