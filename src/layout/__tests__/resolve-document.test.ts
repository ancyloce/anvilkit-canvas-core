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
	createPage,
	createRect,
	createText,
} from "../../ir/builders.js";
import { insertNode, updateNode } from "../../ir/mutations.js";
import type {
	CanvasComponentDefinition,
	CanvasComponentOverrideMap,
	CanvasIR,
	CanvasNode,
} from "../../ir/types.js";
import type { MeasuredText, TextMeasureRequest } from "../../text-contracts.js";
import {
	resolutionManifestHash,
	resolveCanvasLayout,
	reusedSubtreeCount,
} from "../resolve.js";
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
	it("reports resolve and layout timings without making the observer load-bearing", () => {
		const phases: string[] = [];
		const resolved = resolveCanvasDocument(docWithInstance(), {
			measurement: { measureText: charMeasurer },
			onPhaseMeasured(measurement) {
				phases.push(measurement.phase);
				expect(measurement.durationMs).toBeGreaterThanOrEqual(0);
			},
		});
		expect(resolved.records.size).toBeGreaterThan(0);
		expect(phases).toEqual(["resolve", "layout"]);

		expect(() =>
			resolveCanvasDocument(docWithInstance(), {
				measurement: { measureText: charMeasurer },
				onPhaseMeasured() {
					throw new Error("observer failed");
				},
			}),
		).not.toThrow();
	});

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

/**
 * Plan 0023 M4-03 regression: the composed resolver returns an ADDITIVE COPY of
 * the layout result (`{...resolved, componentIssues}`), while the solver's warm
 * cache, reuse count, and manifest stamp are keyed by the INNER object's
 * identity. Before `adoptResolutionState` those three lookups all missed
 * through this entry point — so a caller threading the composed document back
 * as `previous` (exactly what the editor's resolved-document store does on
 * every commit and every preview tick) resolved COLD every pass, and
 * `materializeCanvasLayout` stamped an empty measurement-manifest hash.
 */
describe("resolveCanvasDocument warm-path identity (M4-03)", () => {
	it("threading the composed document back as `previous` reuses records", () => {
		const ir = docWithInstance();
		const first = resolveCanvasDocument(ir, {
			measurement: { measureText: charMeasurer },
		});
		// Same IR, previous threaded: every record is untouched, so the warm path
		// must hand back reference-IDENTICAL record objects (TD §5.4) — which is
		// what lets renderers memoise on record identity.
		const second = resolveCanvasDocument(ir, {
			measurement: { measureText: charMeasurer },
			previous: first,
		});

		const id = toResolvedNodeId("inst-1");
		expect(second.records.get(id)).toBe(first.records.get(id));
		expect(reusedSubtreeCount(second)).toBeGreaterThan(0);
	});

	it("reports the reuse count and manifest hash through the composed document", () => {
		const ir = docWithInstance();
		const resolved = resolveCanvasDocument(ir, {
			measurement: { measureText: charMeasurer, manifestHash: "fonts-v7" },
		});
		// `undefined` / "" here is the symptom of a broken identity hand-off: the
		// second would make a materialization stamp unable to detect that a font
		// load changed metrics.
		expect(reusedSubtreeCount(resolved)).toBeDefined();
		expect(resolutionManifestHash(resolved)).toBe("fonts-v7");
	});

	it("warms the component-free fast path too", () => {
		let ir = createCanvasIR({ id: "plain", now: NOW });
		ir = insertNode(ir, {
			parentId: ir.pages[0]?.root.id as string,
			node: createGroup({
				id: "g1",
				children: [createRect({ id: "r1", bounds: { width: 10, height: 10 } })],
			}),
			now: NOW,
		});

		const first = resolveCanvasDocument(ir, {});
		const second = resolveCanvasDocument(ir, { previous: first });
		const id = toResolvedNodeId("g1");
		expect(second.records.get(id)).toBe(first.records.get(id));
	});

	it("does not reuse a placement across a changed asset map", () => {
		const ir = docWithInstance();
		const first = resolveCanvasDocument(ir, {
			measurement: { measureText: charMeasurer },
		});
		// A new asset map can change an image's intrinsic size, so `createCacheState`
		// drops every signature: adoption hands the state over, it never bypasses
		// that guard.
		const withAssets: CanvasIR = { ...ir, assets: { ...ir.assets } };
		const second = resolveCanvasDocument(withAssets, {
			measurement: { measureText: charMeasurer },
			previous: first,
		});
		expect(reusedSubtreeCount(second)).toBe(0);
	});
});

describe("resolveCanvasDocument dirty-subtree resolution (PLAN-0039 E4-T3)", () => {
	function twoPageDocument(): CanvasIR {
		return createCanvasIR({
			id: "dirty-doc",
			now: NOW,
			pages: [
				createPage({
					id: "p1",
					root: createGroup({
						id: "root-p1",
						children: [
							createRect({
								id: "r1",
								fill: "#ff0000",
								bounds: { width: 10, height: 10 },
							}),
						],
					}),
				}),
				createPage({
					id: "p2",
					root: createGroup({
						id: "root-p2",
						children: [
							createRect({
								id: "r2",
								bounds: { width: 20, height: 20 },
							}),
						],
					}),
				}),
			],
		});
	}

	it("updates only the dirty page while retaining untouched page records", () => {
		const ir = twoPageDocument();
		const first = resolveCanvasDocument(ir, {});
		const updated = updateNode(ir, {
			id: "r1",
			patch: { fill: "#0000ff" },
			now: NOW,
		});
		const second = resolveCanvasDocument(updated, {
			previous: first,
			dirtyPageIds: ["p1"],
			dirtyNodeIds: ["root-p1", "r1"],
		});

		expect(second.records.get(toResolvedNodeId("r1"))).not.toBe(
			first.records.get(toResolvedNodeId("r1")),
		);
		expect(second.records.get(toResolvedNodeId("r1"))?.node).toMatchObject({
			fill: "#0000ff",
		});
		expect(second.records.get(toResolvedNodeId("r2"))).toBe(
			first.records.get(toResolvedNodeId("r2")),
		);
		expect(second.pageRoots.get("p2")).toBe(first.pageRoots.get("p2"));
	});

	it("drops records belonging to a removed dirty page", () => {
		const ir = twoPageDocument();
		const first = resolveCanvasDocument(ir, {});
		const withoutSecondPage = { ...ir, pages: ir.pages.slice(0, 1) };
		const second = resolveCanvasDocument(withoutSecondPage, {
			previous: first,
			dirtyPageIds: ["p2"],
			dirtyNodeIds: ["root-p2", "r2"],
		});

		expect(second.pageRoots.has("p2")).toBe(false);
		expect(second.records.has(toResolvedNodeId("root-p2"))).toBe(false);
		expect(second.records.has(toResolvedNodeId("r2"))).toBe(false);
	});

	it("retains expanded component provenance on an untouched page", () => {
		const componentDocument = docWithInstance();
		const plainPage = createPage({
			id: "plain-page",
			root: createGroup({ id: "plain-root" }),
		});
		const ir = {
			...componentDocument,
			pages: [...componentDocument.pages, plainPage],
		};
		const first = resolveCanvasDocument(ir, {
			measurement: { measureText: charMeasurer },
		});
		const updatedPlainPage = {
			...plainPage,
			background: { kind: "solid" as const, value: "#f5f5f5" },
		};
		const second = resolveCanvasDocument(
			{ ...ir, pages: [ir.pages[0] as (typeof ir.pages)[number], updatedPlainPage] },
			{
				measurement: { measureText: charMeasurer },
				previous: first,
				dirtyPageIds: ["plain-page"],
				dirtyNodeIds: [],
			},
		);

		const instanceId = toResolvedNodeId("inst-1");
		expect(second.records.get(instanceId)).toBe(first.records.get(instanceId));
		expect(second.records.get(instanceId)?.component?.componentId).toBe(
			"cmp-hug",
		);
	});
});
