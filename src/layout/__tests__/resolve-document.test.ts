import { describe, expect, it } from "vitest";
import {
	encodeResolvedNodeId,
	toResolvedNodeId,
} from "../../components/identity.js";
import {
	createCanvasIR,
	createComponentInstance,
	createFrame,
	createGroup,
	createRect,
	createText,
} from "../../ir/builders.js";
import { insertNode } from "../../ir/mutations.js";
import type {
	CanvasComponentDefinition,
	CanvasComponentOverrideMap,
	CanvasIR,
	CanvasNode,
} from "../../ir/types.js";
import type { MeasuredText, TextMeasureRequest } from "../../text-contracts.js";
import { resolveCanvasLayout } from "../resolve.js";
import { resolveCanvasDocument } from "../resolve-document.js";

/**
 * M2-06 (plan 0023): the frozen composition — components expand BEFORE the
 * layout solver. A component-free document is byte-identical to
 * `resolveCanvasLayout` alone; a text override that lengthens content grows
 * the Hug ancestor (T-AL-1), which is only possible in this order.
 */

const NOW = () => "2026-07-29T00:00:00.000Z";

/** 10px per character, flat 24 height — the layout suite's convention. */
const charMeasurer = (request: TextMeasureRequest): MeasuredText => {
	let chars = 0;
	for (const paragraph of request.paragraphs) {
		for (const span of paragraph.spans) chars += span.text.length;
	}
	return { lines: [], width: chars * 10, height: 24 };
};

function hugCardDefinition(): CanvasComponentDefinition {
	return {
		id: "cmp-hug",
		name: "Hug card",
		revision: 1,
		root: {
			...createFrame({
				id: "hug-root",
				bounds: { width: 50, height: 30 },
			}),
			// Spread AFTER the builder — createFrame has no autoLayout option
			// (the layout suite's frameWith does exactly this).
			autoLayout: {
				version: 1,
				direction: "horizontal",
				padding: { top: 0, right: 0, bottom: 0, left: 0 },
				gap: 0,
				primaryAlign: "start",
				crossAlign: "start",
			},
			children: [
				{
					...createText({
						id: "hug-text",
						text: "ab",
						fontFamily: "Inter",
						fontSize: 12,
						fill: "#000000",
						bounds: { width: 20, height: 24 },
					}),
					layoutItem: { widthSizing: "hug" },
				} as CanvasNode,
			],
		},
		properties: [
			{
				id: "p-text",
				name: "Text",
				nodeId: "hug-text",
				kind: "text",
				targetKind: "text",
			},
		],
	};
}

function docWithInstance(overrides?: CanvasComponentOverrideMap): CanvasIR {
	let ir = createCanvasIR({ id: "doc", now: NOW });
	const pageRootId = ir.pages[0]?.root.id as string;
	ir = insertNode(ir, {
		parentId: pageRootId,
		node: createComponentInstance({
			id: "inst-1",
			bounds: { width: 50, height: 30 },
			componentId: "cmp-hug",
			...(overrides ? { overrides } : {}),
			layoutItem: { widthSizing: "hug", heightSizing: "hug" },
		}),
		now: NOW,
	});
	return { ...ir, components: { "cmp-hug": hugCardDefinition() } };
}

describe("resolveCanvasDocument (M2-06)", () => {
	it("is byte-identical to resolveCanvasLayout for a component-free document", () => {
		let ir = createCanvasIR({ id: "plain", now: NOW });
		ir = insertNode(ir, {
			parentId: ir.pages[0]?.root.id as string,
			node: createGroup({
				id: "g1",
				children: [createRect({ id: "r1", bounds: { width: 10, height: 10 } })],
			}),
			now: NOW,
		});

		const composed = resolveCanvasDocument(ir, {});
		const direct = resolveCanvasLayout(ir, {});

		expect(composed.componentIssues).toEqual([]);
		// Identical output modulo the (empty) componentIssues field: same
		// input hash, same record set, same geometry — the fast path IS the
		// layout resolver, not a re-implementation of it.
		expect(composed.inputHash).toBe(direct.inputHash);
		expect([...composed.records.keys()].sort()).toEqual(
			[...direct.records.keys()].sort(),
		);
		expect(
			JSON.parse(JSON.stringify({ ...composed, componentIssues: undefined })),
		).toEqual(JSON.parse(JSON.stringify(direct)));
	});

	it("expands instances into records with provenance, instance root keeps its id", () => {
		const resolved = resolveCanvasDocument(docWithInstance(), {
			measurement: { measureText: charMeasurer },
		});

		const rootRecord = resolved.records.get(toResolvedNodeId("inst-1"));
		expect(rootRecord).toBeDefined();
		expect(rootRecord?.node.type).toBe("frame");
		expect(rootRecord?.component).toEqual({
			instanceId: "inst-1",
			componentId: "cmp-hug",
			definitionNodeId: "hug-root",
			depth: 1,
		});

		const textId = encodeResolvedNodeId({
			segments: ["inst-1", "hug-text"],
		});
		const textRecord = resolved.records.get(textId);
		expect(textRecord?.component?.definitionNodeId).toBe("hug-text");
		expect(resolved.componentIssues).toEqual([]);
	});

	it("T-AL-1: a longer text override grows the instance's Hug size", () => {
		const short = resolveCanvasDocument(docWithInstance(), {
			measurement: { measureText: charMeasurer },
		});
		const long = resolveCanvasDocument(
			docWithInstance({
				"p-text": {
					kind: "text",
					value: { kind: "plain", text: "abcdefghij" },
				},
			}),
			{ measurement: { measureText: charMeasurer } },
		);

		const shortRoot = short.records.get(toResolvedNodeId("inst-1"));
		const longRoot = long.records.get(toResolvedNodeId("inst-1"));
		// 2 chars × 10px vs 10 chars × 10px.
		expect(shortRoot?.geometry.bounds.width).toBe(20);
		expect(longRoot?.geometry.bounds.width).toBe(100);
	});

	it("surfaces expansion diagnostics for a missing Source and still resolves", () => {
		const ir = docWithInstance();
		const broken: CanvasIR = { ...ir, components: {} };
		const resolved = resolveCanvasDocument(broken, {});
		expect(
			resolved.componentIssues.some(
				(i) => i.code === "component-source-missing",
			),
		).toBe(true);
		// The placeholder instance node still produced a record.
		const record = resolved.records.get(toResolvedNodeId("inst-1"));
		expect(record?.node.type).toBe("component-instance");
	});
});
