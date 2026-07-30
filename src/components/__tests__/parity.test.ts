import { describe, expect, it } from "vitest";
import { applyCommand } from "../../commands/runtime.js";
import { buildDetachCommand } from "../../component-ops/detach.js";
import {
	createCanvasIR,
	createComponentInstance,
	createFrame,
	createImage,
	createPage,
	createRect,
	createText,
} from "../../ir/builders.js";
import { insertNode } from "../../ir/mutations.js";
import type {
	CanvasComponentDefinition,
	CanvasComponentOverrideMap,
	CanvasComponentProperty,
	CanvasIR,
	CanvasNode,
	CanvasPage,
} from "../../ir/types.js";
import { resolveCanvasDocument } from "../../layout/resolve-document.js";
import type { CanvasResolvedNodeRecord } from "../../layout/types.js";
import { toResolvedNodeId } from "../../layout/types.js";
import { serializePageToSvg } from "../../serialize/svg.js";
import type { MeasuredText, TextMeasureRequest } from "../../text-contracts.js";
import { encodeResolvedNodeId } from "../identity.js";

/**
 * @file M6-03 cross-consumer parity (LC-EXPORT, AC-012) over the PRD §15
 * integration fixtures and the TD §23.3 contract fixtures.
 *
 * The claim under test is narrow and load-bearing: **one resolution feeds every
 * consumer**, so the resolver, the SVG export, and the accessibility reading
 * order cannot disagree about content, geometry, order, or diagnostics. Each
 * `it` names the fixture it covers.
 *
 * Reading order is derived here the same way the editor's `SceneAccessibilityTree`
 * derives it — a pre-order walk of `childIds` from the page roots — because that
 * IS the contract: `childIds` is resolved FLOW order, not document order.
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

const MEASURED = { measurement: { measureText: charMeasurer } };

// --- fixture builders --------------------------------------------------------

const TEXT_PROP: CanvasComponentProperty = {
	id: "p-label",
	name: "Label",
	nodeId: "cta-label",
	kind: "text",
	targetKind: "text",
};
const COLOR_PROP: CanvasComponentProperty = {
	id: "p-bg",
	name: "Background",
	nodeId: "cta-root",
	kind: "color",
	targetField: "background",
};

/** PRD §15 #1 / TD §23.3 #1 — CTA with text + color properties. */
function ctaDefinition(): CanvasComponentDefinition {
	return {
		id: "cmp-cta",
		name: "CTA",
		revision: 1,
		properties: [TEXT_PROP, COLOR_PROP],
		root: {
			...createFrame({
				id: "cta-root",
				bounds: { width: 120, height: 40 },
				background: "#1155cc",
			}),
			children: [
				createText({
					id: "cta-label",
					text: "Buy",
					fontFamily: "Inter",
					fontSize: 14,
					fill: "#ffffff",
					transform: { x: 8, y: 8 },
					bounds: { width: 60, height: 24 },
				}),
			],
		} as CanvasNode,
	};
}

const IMAGE_PROP: CanvasComponentProperty = {
	id: "p-photo",
	name: "Photo",
	nodeId: "card-photo",
	kind: "image",
	targetKind: "image",
};
const VIS_PROP: CanvasComponentProperty = {
	id: "p-badge",
	name: "Badge visible",
	nodeId: "card-badge",
	kind: "visibility",
};

/** PRD §15 #2 / TD §23.3 #2 — product card with image + text + visibility. */
function cardDefinition(): CanvasComponentDefinition {
	return {
		id: "cmp-card",
		name: "Product card",
		revision: 1,
		properties: [
			IMAGE_PROP,
			VIS_PROP,
			{
				id: "p-title",
				name: "Title",
				nodeId: "card-title",
				kind: "text",
				targetKind: "text",
			},
		],
		root: {
			...createFrame({
				id: "card-root",
				bounds: { width: 200, height: 160 },
				background: "#ffffff",
			}),
			children: [
				createImage({
					id: "card-photo",
					assetId: "photo-a",
					bounds: { width: 200, height: 100 },
				}),
				createText({
					id: "card-title",
					text: "Item",
					fontFamily: "Inter",
					fontSize: 16,
					fill: "#000000",
					transform: { x: 8, y: 108 },
					bounds: { width: 120, height: 24 },
				}),
				createRect({
					id: "card-badge",
					transform: { x: 170, y: 8 },
					bounds: { width: 22, height: 22 },
					fill: "#ff0000",
				}),
			],
		} as CanvasNode,
	};
}

/** PRD §15 #3 / TD §23.3 #3 — nested card containing a button component. */
function nestedShellDefinition(): CanvasComponentDefinition {
	return {
		id: "cmp-shell",
		name: "Shell",
		revision: 1,
		properties: [],
		root: {
			...createFrame({
				id: "shell-root",
				bounds: { width: 240, height: 120 },
				background: "#eeeeee",
			}),
			children: [
				createText({
					id: "shell-heading",
					text: "Header",
					fontFamily: "Inter",
					fontSize: 18,
					fill: "#111111",
					bounds: { width: 100, height: 24 },
				}),
				createComponentInstance({
					id: "shell-cta",
					componentId: "cmp-cta",
					transform: { x: 10, y: 60 },
					bounds: { width: 120, height: 40 },
				}),
			],
		} as CanvasNode,
	};
}

interface DocOptions {
	readonly registry: Record<string, CanvasComponentDefinition>;
	readonly instances: readonly CanvasNode[];
	readonly assets?: CanvasIR["assets"];
}

function docWith(options: DocOptions): CanvasIR {
	const page = createPage({ id: "p1" });
	let ir = createCanvasIR({ id: "doc", title: "t", pages: [page], now: NOW });
	for (const node of options.instances) {
		ir = insertNode(ir, { parentId: page.root.id, node, now: NOW });
	}
	return {
		...ir,
		components: options.registry,
		...(options.assets ? { assets: options.assets } : {}),
	};
}

const instanceOf = (
	id: string,
	componentId: string,
	overrides?: CanvasComponentOverrideMap,
	extra: Partial<Parameters<typeof createComponentInstance>[0]> = {},
): CanvasNode =>
	createComponentInstance({
		id,
		componentId,
		bounds: { width: 120, height: 40 },
		...(overrides ? { overrides } : {}),
		...extra,
	});

// --- the parity harness ------------------------------------------------------

/** Pre-order walk of `childIds` from the page roots — the reading-order contract. */
function readingOrder(ir: CanvasIR, pageId: string): string[] {
	const resolved = resolveCanvasDocument(ir, MEASURED);
	const out: string[] = [];
	const visit = (id: string): void => {
		const record = resolved.records.get(toResolvedNodeId(id));
		if (!record) return;
		out.push(record.id);
		for (const childId of record.childIds) visit(childId);
	};
	for (const rootId of resolved.pageRoots.get(pageId) ?? []) visit(rootId);
	return out;
}

/** Every resolved record, keyed by id, for one document. */
function recordsOf(
	ir: CanvasIR,
): ReadonlyMap<string, CanvasResolvedNodeRecord> {
	const resolved = resolveCanvasDocument(ir, MEASURED);
	return new Map([...resolved.records].map(([id, record]) => [id, record]));
}

/** The SVG for page 0, resolved through the SAME measurer the resolver used. */
async function svgOf(ir: CanvasIR): Promise<string> {
	const { svg } = await serializePageToSvg(ir, 0, {
		textMeasurer: charMeasurer,
	});
	return svg;
}

const virtual = (...segments: readonly string[]): string =>
	encodeResolvedNodeId({ segments: [...segments] }) as string;

/**
 * The resolved node at `id`, asserted present.
 *
 * A missing record is a FAILURE here, never an optional read: every id these
 * fixtures ask for is one the expansion must have produced, so
 * `records.get(id)?.node` would quietly turn a real regression into an
 * `undefined` comparison.
 */
function nodeAt(
	records: ReadonlyMap<string, CanvasResolvedNodeRecord>,
	id: string,
): Record<string, unknown> {
	const record = records.get(id);
	expect(record, `no resolved record for "${id}"`).toBeDefined();
	return (record as CanvasResolvedNodeRecord).node as unknown as Record<
		string,
		unknown
	>;
}

// --- fixtures 1 + 2: properties reach every consumer -------------------------

describe("fixture 1 — CTA with text/color properties (PRD §15.1, TD §23.3.1)", () => {
	const doc = (overrides?: CanvasComponentOverrideMap) =>
		docWith({
			registry: { "cmp-cta": ctaDefinition() },
			instances: [instanceOf("inst-cta", "cmp-cta", overrides)],
		});

	it("resolver and SVG agree on the DEFAULT content", async () => {
		const records = recordsOf(doc());
		const label = nodeAt(records, virtual("inst-cta", "cta-label"));
		expect(label.type).toBe("text");
		expect(label.text).toBe("Buy");

		const svg = await svgOf(doc());
		// Same content, one resolution: what the resolver holds is what exports.
		expect(svg).toContain("Buy");
		expect(svg).toContain("#1155cc");
	});

	it("a text + color override reaches BOTH consumers identically", async () => {
		const overrides: CanvasComponentOverrideMap = {
			"p-label": { kind: "text", value: { kind: "plain", text: "Subscribe" } },
			"p-bg": { kind: "color", value: "#00aa00" },
		};
		const records = recordsOf(doc(overrides));
		expect(nodeAt(records, virtual("inst-cta", "cta-label")).text).toBe(
			"Subscribe",
		);
		expect(nodeAt(records, toResolvedNodeId("inst-cta")).background).toBe(
			"#00aa00",
		);

		const svg = await svgOf(doc(overrides));
		expect(svg).toContain("Subscribe");
		expect(svg).toContain("#00aa00");
		// The default must be GONE from both, not merely overlaid.
		expect(svg).not.toContain(">Buy<");
		expect(svg).not.toContain("#1155cc");
	});

	it("reading order is the resolved flow order, root before its label", () => {
		const order = readingOrder(doc(), "p1");
		const rootAt = order.indexOf("inst-cta");
		const labelAt = order.indexOf(virtual("inst-cta", "cta-label"));
		expect(rootAt).toBeGreaterThanOrEqual(0);
		expect(labelAt).toBeGreaterThan(rootAt);
	});
});

describe("fixture 2 — product card, image/text/visibility (PRD §15.2, TD §23.3.2)", () => {
	const doc = (overrides?: CanvasComponentOverrideMap) =>
		docWith({
			registry: { "cmp-card": cardDefinition() },
			instances: [
				instanceOf("inst-card", "cmp-card", overrides, {
					bounds: { width: 200, height: 160 },
				}),
			],
			assets: {
				"photo-a": { id: "photo-a", uri: "data:image/png;base64,AAAA" },
				"photo-b": { id: "photo-b", uri: "data:image/png;base64,BBBB" },
			},
		});

	it("an image override swaps the asset in the resolver AND the export", async () => {
		const overrides: CanvasComponentOverrideMap = {
			"p-photo": { kind: "image", assetId: "photo-b" },
		};
		const photo = nodeAt(
			recordsOf(doc(overrides)),
			virtual("inst-card", "card-photo"),
		);
		expect(photo.assetId).toBe("photo-b");

		const svg = await svgOf(doc(overrides));
		expect(svg).toContain("BBBB");
		expect(svg).not.toContain("AAAA");
	});

	it("a visibility override removes the node from the export, not just from view", async () => {
		const hidden = await svgOf(
			doc({ "p-badge": { kind: "visibility", visible: false } }),
		);
		const shown = await svgOf(doc());
		// The badge's fill is the observable: hiding must actually stop emitting it
		// (the serializer skips invisible nodes), so export and canvas agree.
		expect(shown).toContain("#ff0000");
		expect(hidden).not.toContain("#ff0000");
	});
});

// --- fixture 3: nesting ------------------------------------------------------

describe("fixture 3 — nested card → button graph (PRD §15.3, TD §23.3.3)", () => {
	const doc = () =>
		docWith({
			registry: {
				"cmp-cta": ctaDefinition(),
				"cmp-shell": nestedShellDefinition(),
			},
			instances: [
				instanceOf("inst-shell", "cmp-shell", undefined, {
					bounds: { width: 240, height: 120 },
				}),
			],
		});

	it("expands two levels deep in the resolver and the export", async () => {
		const records = recordsOf(doc());
		// The nested instance root, then the CTA's own label two levels down.
		expect(records.has(virtual("inst-shell", "shell-cta"))).toBe(true);
		expect(records.has(virtual("inst-shell", "shell-cta", "cta-label"))).toBe(
			true,
		);
		const svg = await svgOf(doc());
		expect(svg).toContain("Header");
		expect(svg).toContain("Buy");
	});

	it("reading order descends outer → nested → nested's children", () => {
		const order = readingOrder(doc(), "p1");
		const shell = order.indexOf("inst-shell");
		const heading = order.indexOf(virtual("inst-shell", "shell-heading"));
		const cta = order.indexOf(virtual("inst-shell", "shell-cta"));
		const label = order.indexOf(
			virtual("inst-shell", "shell-cta", "cta-label"),
		);
		expect(shell).toBeLessThan(heading);
		expect(heading).toBeLessThan(cta);
		expect(cta).toBeLessThan(label);
	});

	it("nests provenance depth, so consumers can tell the levels apart", () => {
		const records = recordsOf(doc());
		expect(
			records.get(virtual("inst-shell", "shell-heading"))?.component?.depth,
		).toBe(1);
		expect(
			records.get(virtual("inst-shell", "shell-cta", "cta-label"))?.component
				?.depth,
		).toBe(2);
	});
});

// --- fixture 4: one Source edit, many instances ------------------------------

describe("fixture 4 — Source edit affecting 100 instances (PRD §15.4, TD §23.3.4)", () => {
	function hundred(definition: CanvasComponentDefinition): CanvasIR {
		return docWith({
			registry: { "cmp-cta": definition },
			instances: Array.from({ length: 100 }, (_, i) =>
				instanceOf(`inst-${i}`, "cmp-cta", undefined, {
					transform: { x: 0, y: i * 45 },
				}),
			),
		});
	}

	it("one Source edit changes every instance, with NO per-instance mutation", async () => {
		// ONE document, then only the Registry is swapped — rebuilding the page
		// would mint a fresh random root id and the comparison below would be
		// asserting nothing.
		const before = hundred(ctaDefinition());
		const editedDefinition: CanvasComponentDefinition = {
			...ctaDefinition(),
			revision: 2,
			root: {
				...(ctaDefinition().root as CanvasNode & { children: CanvasNode[] }),
				children: [
					{
						...(
							ctaDefinition().root as CanvasNode & {
								children: CanvasNode[];
							}
						).children[0],
						text: "Buy now",
					} as CanvasNode,
				],
			} as CanvasNode,
		};
		const after: CanvasIR = {
			...before,
			components: { "cmp-cta": editedDefinition },
		};

		// Every instance NODE is byte-identical across the edit: propagation is a
		// Registry write plus a revision bump, never 100 node rewrites.
		expect(JSON.stringify(after.pages[0]?.root)).toBe(
			JSON.stringify(before.pages[0]?.root),
		);

		const recordsAfter = recordsOf(after);
		for (const i of [0, 42, 99]) {
			expect(nodeAt(recordsAfter, virtual(`inst-${i}`, "cta-label")).text).toBe(
				"Buy now",
			);
		}
		const svg = await svgOf(after);
		expect(svg).not.toContain(">Buy<");
	});

	/**
	 * M6-03 REGRESSION GUARD. This fixture is what caught the instance-layer cache
	 * bug: the key omitted the instance id while the cached value embedded
	 * instance-specific node ids, so instances 2…100 were handed instance 1's
	 * subtree and the records map (keyed by id) collapsed them. 100 identical
	 * instances resolved to THREE records and exported one component. A bench that
	 * only measured time could not see it; counting records does.
	 */
	it("resolves all 100 instances as DISTINCT records, no diagnostics", () => {
		const resolved = resolveCanvasDocument(hundred(ctaDefinition()), MEASURED);
		expect(resolved.componentIssues).toEqual([]);
		// 100 instance roots + 100 labels + the page root.
		expect(resolved.records.size).toBe(201);
		// Spot-check that each instance kept its OWN identity end to end.
		for (const i of [0, 50, 99]) {
			expect(resolved.records.has(toResolvedNodeId(`inst-${i}`))).toBe(true);
			expect(resolved.records.has(virtual(`inst-${i}`, "cta-label"))).toBe(
				true,
			);
		}
	});

	it("exports all 100 instances, not just the first", async () => {
		const svg = await svgOf(hundred(ctaDefinition()));
		// The same collapse would have emitted ONE label; count them in the output.
		expect(svg.split(">Buy<").length - 1).toBe(100);
	});
});

// --- fixtures 5 + 6: orphans, placeholders ----------------------------------

describe("fixture 5/6 — deleted property → orphan, and missing Source (TD §23.3.5/6)", () => {
	it("an override for a removed property is retained, never applied", async () => {
		const stripped: CanvasComponentDefinition = {
			...ctaDefinition(),
			properties: [COLOR_PROP],
		};
		const ir = docWith({
			registry: { "cmp-cta": stripped },
			instances: [
				instanceOf("inst-cta", "cmp-cta", {
					"p-label": {
						kind: "text",
						value: { kind: "plain", text: "Orphaned" },
					},
				}),
			],
		});
		const resolved = resolveCanvasDocument(ir, MEASURED);
		expect(
			resolved.componentIssues.some(
				(i) => i.code === "component-override-orphan",
			),
		).toBe(true);
		// Retained on the instance, absent from every consumer's output.
		const instanceNode = pageOf(ir).root.children[0] as {
			overrides?: Record<string, unknown>;
		};
		expect(instanceNode.overrides?.["p-label"]).toBeDefined();
		const svg = await svgOf(ir);
		expect(svg).not.toContain("Orphaned");
		expect(svg).toContain("Buy");
	});

	it("a missing Source degrades to a selectable placeholder in every consumer", async () => {
		const ir = docWith({
			registry: {},
			instances: [instanceOf("inst-ghost", "cmp-gone")],
		});
		const resolved = resolveCanvasDocument(ir, MEASURED);
		expect(
			resolved.componentIssues.some(
				(i) => i.code === "component-source-missing",
			),
		).toBe(true);
		// The record survives (so it stays selectable and keeps its overrides) and
		// is still the instance node — which is what the export reports on.
		const record = resolved.records.get(toResolvedNodeId("inst-ghost"));
		expect(record?.node.type).toBe("component-instance");

		const { warnings } = await serializePageToSvg(ir, 0, {
			textMeasurer: charMeasurer,
		});
		expect(
			warnings.some(
				(w) =>
					w.code === "COMPONENT_INSTANCE_UNRESOLVED" &&
					w.nodeId === "inst-ghost",
			),
		).toBe(true);
	});
});

// --- fixture 7: detach preserves the visual result --------------------------

describe("fixture 7 — detach nested component, visual result preserved (PRD §15.7, TD §23.3.7)", () => {
	it("the detached tree renders the same content as the instance did (INV-12)", async () => {
		const ir = docWith({
			registry: {
				"cmp-cta": ctaDefinition(),
				"cmp-shell": nestedShellDefinition(),
			},
			instances: [
				instanceOf("inst-shell", "cmp-shell", undefined, {
					bounds: { width: 240, height: 120 },
				}),
			],
		});
		const beforeSvg = await svgOf(ir);

		let counter = 0;
		const plan = buildDetachCommand(ir, "inst-shell", {
			idFactory: () => `mat-${++counter}`,
		});
		const detached = applyCommand(ir, plan.command, { now: NOW }).ir;
		const afterSvg = await svgOf(detached);

		// No components left at all — a client with zero component support sees the
		// same picture.
		expect(detached.pages[0]?.root.children[0]?.type).not.toBe(
			"component-instance",
		);
		expect(afterSvg).toContain("Header");
		expect(afterSvg).toContain("Buy");
		expect(afterSvg).toContain("#1155cc");
		// The COMPONENT_* warnings vanish because there is nothing left to expand.
		const { warnings } = await serializePageToSvg(detached, 0, {
			textMeasurer: charMeasurer,
		});
		expect(warnings.filter((w) => w.code.startsWith("COMPONENT_"))).toEqual([]);
		// And the paint is equivalent modulo the fresh ids detach mints.
		expect(stripIds(afterSvg)).toBe(stripIds(beforeSvg));
	});
});

/**
 * Drop every `id=`/`clip-path` reference so two SVGs can be compared for PAINT
 * equivalence: detach deliberately mints fresh node ids, which legitimately
 * change id-derived attributes without changing a single pixel.
 */
function stripIds(svg: string): string {
	return svg
		.replace(/ id="[^"]*"/g, "")
		.replace(/url\(#[^)]*\)/g, "url(#x)")
		.replace(/ clip-path="[^"]*"/g, ' clip-path="x"');
}

// --- warnings parity ---------------------------------------------------------

describe("diagnostics parity across consumers", () => {
	it("the resolver's issues and the serializer's warnings describe the SAME document state", async () => {
		const ir = docWith({
			registry: {},
			instances: [
				instanceOf("inst-a", "cmp-missing"),
				instanceOf("inst-b", "cmp-missing"),
			],
		});
		const resolved = resolveCanvasDocument(ir, MEASURED);
		const { warnings } = await serializePageToSvg(ir, 0, {
			textMeasurer: charMeasurer,
		});

		const issueInstances = resolved.componentIssues
			.filter((i) => i.code === "component-source-missing")
			.map((i) => i.instanceId)
			.sort();
		const warnedInstances = warnings
			.filter((w) => w.code === "COMPONENT_INSTANCE_UNRESOLVED")
			.map((w) => w.nodeId)
			.sort();
		// Neither consumer may know about a broken instance the other misses.
		expect(warnedInstances).toEqual(issueInstances);
	});
});

/** The page a fixture builds, for readability in failure output. */
function pageOf(ir: CanvasIR): CanvasPage {
	const page = ir.pages[0];
	if (!page) throw new Error("fixture has no page");
	return page;
}

describe("fixture 8 — template bundle collision/remap is covered elsewhere", () => {
	it("documents where TD §23.3.8 lives, rather than duplicating it", () => {
		// M3-11 pinned collision/remap end-to-end in
		// `component-ops/__tests__/docflow.test.ts` (T-DOC-3): instantiating the
		// same bundle twice into one document remaps ids once and collides never.
		// Re-asserting it here would duplicate a passing contract test, so this
		// placeholder exists only to keep the fixture roll-call honest.
		expect(pageOf(docWith({ registry: {}, instances: [] })).id).toBe("p1");
	});
});
