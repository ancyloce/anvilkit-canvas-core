import { describe, expect, it } from "vitest";
import {
	createCanvasIR,
	createFrame,
	createImage,
	createPage,
	createRect,
	createText,
} from "../../ir/builders.js";
import { insertNode, updateNode } from "../../ir/mutations.js";
import type { CanvasAssetRef, CanvasIR, CanvasNode } from "../../ir/types.js";
import type { MeasuredText, TextMeasureRequest } from "../../text-contracts.js";
import { createCacheState, subtreeSignature } from "../cache.js";
import { resolveCanvasLayout, reusedSubtreeCount } from "../resolve.js";
import type { CanvasResolvedNodeId } from "../types.js";

/**
 * @file T-M2-07 — signatures, dirty propagation and structural sharing (TS-49).
 */

const box = { width: 40, height: 20 };

const layout = {
	version: 1,
	direction: "horizontal",
	padding: { top: 0, right: 0, bottom: 0, left: 0 },
	gap: 0,
	primaryAlign: "start",
	crossAlign: "start",
} as const;

function frameWith(
	id: string,
	children: CanvasNode[],
	overrides: Record<string, unknown> = {},
): CanvasNode {
	return {
		...createFrame({ id, bounds: { width: 200, height: 100 } }),
		autoLayout: layout,
		children,
		...overrides,
	} as CanvasNode;
}

function docOf(children: CanvasNode[]): CanvasIR {
	const page = createPage({ id: "p1" });
	let ir = createCanvasIR({ id: "doc", title: "t", pages: [page] });
	for (const child of children) {
		ir = insertNode(ir, { parentId: page.root.id, node: child });
	}
	return ir;
}

const state = () => createCacheState({}, "");

function sigOf(node: CanvasNode, assets: Record<string, CanvasAssetRef> = {}) {
	return subtreeSignature(node, createCacheState(assets, ""));
}

const id = (value: string) => value as CanvasResolvedNodeId;

describe("subtreeSignature — what moves geometry", () => {
	const base = () => createRect({ id: "r", bounds: box }) as CanvasNode;

	it("changes when a geometry input changes", () => {
		const cases: Record<string, CanvasNode> = {
			bounds: { ...base(), bounds: { width: 41, height: 20 } } as CanvasNode,
			transform: {
				...base(),
				transform: { x: 1, y: 0, rotation: 0, scaleX: 1, scaleY: 1 },
			} as CanvasNode,
			rotation: {
				...base(),
				transform: { x: 0, y: 0, rotation: 5, scaleX: 1, scaleY: 1 },
			} as CanvasNode,
			skew: {
				...base(),
				transform: {
					x: 0,
					y: 0,
					rotation: 0,
					scaleX: 1,
					scaleY: 1,
					skewX: 0.2,
				},
			} as CanvasNode,
			layoutItem: {
				...base(),
				layoutItem: { widthSizing: "fill" },
			} as CanvasNode,
		};
		for (const [label, node] of Object.entries(cases)) {
			expect(sigOf(node), label).not.toBe(sigOf(base()));
		}
	});

	it("does NOT change for paint-only or bookkeeping fields", () => {
		// Changing these must not invalidate a layout. `visible` is here on
		// purpose: hidden children participate in flow exactly like visible ones
		// (§7.2), so toggling an eye icon is a genuine no-op for the resolver,
		// not merely a cheap one.
		const cases: Record<string, CanvasNode> = {
			opacity: { ...base(), opacity: 0.3 } as CanvasNode,
			visible: { ...base(), visible: false } as CanvasNode,
			locked: { ...base(), locked: true } as CanvasNode,
			name: { ...base(), name: "renamed" } as CanvasNode,
			meta: { ...base(), meta: { aiSource: { model: "x" } } } as CanvasNode,
			fill: { ...base(), fill: "#ff0000" } as CanvasNode,
		};
		for (const [label, node] of Object.entries(cases)) {
			expect(sigOf(node), label).toBe(sigOf(base()));
		}
	});

	it("changes when child ORDER changes, even with identical children", () => {
		const a = createRect({ id: "a", bounds: box }) as CanvasNode;
		const b = createRect({ id: "b", bounds: box }) as CanvasNode;
		expect(sigOf(frameWith("f", [a, b]))).not.toBe(
			sigOf(frameWith("f", [b, a])),
		);
	});

	it("changes when a frame's own Auto Layout changes", () => {
		expect(
			sigOf(frameWith("f", [], { autoLayout: { ...layout, gap: 4 } })),
		).not.toBe(sigOf(frameWith("f", [])));
	});

	it("changes when text content or its font changes", () => {
		const text = (over: Record<string, unknown>) =>
			({
				...createText({ id: "t", text: "hi", bounds: box }),
				...over,
			}) as CanvasNode;
		expect(sigOf(text({ text: "bye" }))).not.toBe(sigOf(text({})));
		expect(sigOf(text({ fontSize: 99 }))).not.toBe(sigOf(text({})));
	});

	it("changes when an asset's recorded intrinsic size changes", () => {
		const node = createImage({
			id: "i",
			assetId: "a1",
			bounds: box,
		}) as CanvasNode;
		const small = { a1: { id: "a1", uri: "u", width: 10, height: 10 } };
		const large = { a1: { id: "a1", uri: "u", width: 20, height: 20 } };
		expect(sigOf(node, small)).not.toBe(sigOf(node, large));
	});

	it("hits the reference fast path for an unchanged node object", () => {
		// The whole point: `applyCommand` structurally shares untouched
		// subtrees, so an unedited node is the SAME object across revisions and
		// its signature is a WeakMap lookup rather than a traversal.
		const cache = state();
		const node = frameWith("f", [createRect({ id: "a", bounds: box })]);
		const first = subtreeSignature(node, cache);
		expect(subtreeSignature(node, cache)).toBe(first);
		expect(cache.signatures.get(node)).toBe(first);
	});
});

describe("createCacheState", () => {
	it("keeps signatures while the inputs they were computed against hold", () => {
		const assets = {};
		const first = createCacheState(assets, "m1");
		const next = createCacheState(assets, "m1", first);
		expect(next.signatures).toBe(first.signatures);
	});

	it("discards everything when the asset map or manifest changes", () => {
		// Reusing a placement computed against different intrinsic sizes is
		// exactly the stale-cache bug this layer exists to avoid.
		const first = createCacheState({}, "m1");
		expect(createCacheState({}, "m2", first).signatures).not.toBe(
			first.signatures,
		);
		expect(
			createCacheState({ a: { id: "a", uri: "u" } }, "m1", first).signatures,
		).not.toBe(first.signatures);
	});
});

describe("structural sharing (TS-49)", () => {
	const build = () =>
		docOf([
			frameWith("left", [
				createRect({ id: "l1", bounds: box }),
				createRect({ id: "l2", bounds: box }),
			]),
			frameWith("right", [
				createRect({ id: "r1", bounds: box }),
				createRect({ id: "r2", bounds: box }),
			]),
		]);

	it("returns reference-identical records for an untouched document", () => {
		const ir = build();
		const first = resolveCanvasLayout(ir, {});
		const second = resolveCanvasLayout(ir, { previous: first });

		for (const [key, record] of first.records) {
			expect(second.records.get(key), record.sourceNodeId).toBe(record);
		}
	});

	it("reallocates only the edited subtree, leaving siblings identical", () => {
		// The acceptance criterion: a localized edit reallocates only the dirty
		// subtree, its Hug ancestors, and moved descendants.
		const ir = build();
		const first = resolveCanvasLayout(ir, {});
		const edited = updateNode(ir, {
			id: "l1",
			patch: { bounds: { width: 90, height: 20 } },
		});
		const second = resolveCanvasLayout(edited, { previous: first });

		// Untouched sibling frame and its whole subtree keep identity.
		for (const untouched of ["right", "r1", "r2"]) {
			expect(second.records.get(id(untouched)), untouched).toBe(
				first.records.get(id(untouched)),
			);
		}
		// The edited node changed, and so did the sibling the edit displaced.
		expect(second.records.get(id("l1"))).not.toBe(first.records.get(id("l1")));
		expect(second.records.get(id("l2"))).not.toBe(first.records.get(id("l2")));
		expect(second.records.get(id("l2"))?.geometry.localTransform.x).toBe(90);
	});

	it("keeps a moved node's record fresh even when its own box is unchanged", () => {
		// `l2` is byte-identical as a node; only its POSITION moved. A cache
		// keyed on the node alone would hand back a stale record here.
		const ir = build();
		const first = resolveCanvasLayout(ir, {});
		const edited = updateNode(ir, {
			id: "l1",
			patch: { bounds: { width: 75, height: 20 } },
		});
		const second = resolveCanvasLayout(edited, { previous: first });

		expect(second.records.get(id("l2"))?.node).toBe(
			first.records.get(id("l2"))?.node,
		);
		expect(second.records.get(id("l2"))).not.toBe(first.records.get(id("l2")));
	});

	it("propagates dirt up through a Hug ancestor chain", () => {
		const chain = docOf([
			frameWith(
				"outer",
				[
					frameWith("inner", [createRect({ id: "leaf", bounds: box })], {
						layoutItem: { widthSizing: "hug" },
					}),
				],
				{ layoutItem: { widthSizing: "hug" } },
			),
		]);
		const first = resolveCanvasLayout(chain, {});
		const edited = updateNode(chain, {
			id: "leaf",
			patch: { bounds: { width: 111, height: 20 } },
		});
		const second = resolveCanvasLayout(edited, { previous: first });

		for (const dirty of ["leaf", "inner", "outer"]) {
			expect(second.records.get(id(dirty))?.geometry.bounds.width, dirty).toBe(
				111,
			);
			expect(second.records.get(id(dirty)), dirty).not.toBe(
				first.records.get(id(dirty)),
			);
		}
	});

	it("reuses subtrees on the warm path rather than re-walking them", () => {
		const ir = build();
		const first = resolveCanvasLayout(ir, {});
		expect(reusedSubtreeCount(first)).toBe(0);

		const second = resolveCanvasLayout(ir, { previous: first });
		// An entirely unchanged document short-circuits at the page root.
		expect(reusedSubtreeCount(second)).toBeGreaterThan(0);
	});

	it("does not reuse across documents with different assets", () => {
		const ir = build();
		const first = resolveCanvasLayout(ir, {});
		const withAssets: CanvasIR = {
			...ir,
			assets: { a1: { id: "a1", uri: "u", width: 5, height: 5 } },
		};
		const second = resolveCanvasLayout(withAssets, { previous: first });

		expect(reusedSubtreeCount(second)).toBe(0);
	});

	it("ignores a previous document it was not given", () => {
		// A cold resolve must never silently pick up warm state.
		const ir = build();
		resolveCanvasLayout(ir, {});
		expect(reusedSubtreeCount(resolveCanvasLayout(ir, {}))).toBe(0);
	});

	it("produces the same geometry warm as cold", () => {
		// The cache must be an optimisation, never a semantic.
		const ir = build();
		const cold = resolveCanvasLayout(ir, {});
		const edited = updateNode(ir, {
			id: "l1",
			patch: { bounds: { width: 63, height: 20 } },
		});
		const warm = resolveCanvasLayout(edited, { previous: cold });
		const freshCold = resolveCanvasLayout(edited, {});

		for (const [key, record] of freshCold.records) {
			expect(warm.records.get(key)?.geometry, record.sourceNodeId).toEqual(
				record.geometry,
			);
		}
		expect(warm.diagnostics).toEqual(freshCold.diagnostics);
	});

	it("stays correct warm when text measurement drives Hug", () => {
		const measurer = (request: TextMeasureRequest): MeasuredText => {
			let chars = 0;
			for (const p of request.paragraphs) {
				for (const s of p.spans) chars += s.text.length;
			}
			return { lines: [], width: chars * 10, height: 24 };
		};
		const build2 = (text: string) =>
			docOf([
				frameWith("f", [
					{
						...createText({ id: "t", text, bounds: box }),
						layoutItem: { widthSizing: "hug" },
					} as CanvasNode,
				]),
			]);

		const first = resolveCanvasLayout(build2("ab"), {
			measurement: { measureText: measurer },
		});
		const second = resolveCanvasLayout(build2("abcd"), {
			measurement: { measureText: measurer },
			previous: first,
		});

		expect(second.records.get(id("t"))?.geometry.bounds.width).toBe(40);
	});
});
