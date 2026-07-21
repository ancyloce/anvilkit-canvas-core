import { describe, expect, it } from "vitest";
import {
	createCanvasIR,
	createFrame,
	createGroup,
	createImage,
	createPage,
	createRect,
	createVideo,
} from "../../ir/builders.js";
import type { CanvasIR, CanvasNode } from "../../ir/types.js";
import {
	CANVAS_CLIPBOARD_VERSION,
	CanvasClipboardError,
	type CanvasClipboardPayload,
	MAX_CLIPBOARD_BYTES,
	MAX_CLIPBOARD_NODES,
	materializeClipboardNodes,
	parseClipboardPayload,
	validateClipboardPayload,
} from "../payload.js";

function seqFactory(prefix: string): () => string {
	let i = 0;
	return () => `${prefix}${++i}`;
}

function payloadWith(
	nodes: CanvasNode[],
	extra: Partial<CanvasClipboardPayload> = {},
): CanvasClipboardPayload {
	return {
		version: CANVAS_CLIPBOARD_VERSION,
		nodes,
		assetRefs: {},
		bounds: { x: 0, y: 0, width: 100, height: 100 },
		...extra,
	};
}

function targetIR(id = "target-doc"): CanvasIR {
	return createCanvasIR({
		id,
		pages: [createPage({ id: "p1" })],
		now: () => "T",
	});
}

function errorCode(fn: () => unknown): string | null {
	try {
		fn();
		return null;
	} catch (err) {
		return err instanceof CanvasClipboardError ? err.code : "unexpected-type";
	}
}

describe("validateClipboardPayload", () => {
	it("accepts a valid payload and preserves unknown fields", () => {
		const payload = {
			...payloadWith([
				createRect({ id: "r1", bounds: { width: 10, height: 10 } }),
			]),
			futureField: "keep-me",
		};
		const parsed = validateClipboardPayload(payload) as Record<string, unknown>;
		expect(parsed.futureField).toBe("keep-me");
	});

	it("rejects unsupported versions", () => {
		const bad = {
			...payloadWith([
				createRect({ id: "r", bounds: { width: 10, height: 10 } }),
			]),
			version: 2,
		};
		expect(errorCode(() => validateClipboardPayload(bad))).toBe(
			"unsupported-version",
		);
	});

	it("rejects structurally invalid payloads", () => {
		expect(errorCode(() => validateClipboardPayload(null))).toBe(
			"invalid-payload",
		);
		expect(
			errorCode(() =>
				validateClipboardPayload({
					version: 1,
					nodes: [{ type: "rect" }], // missing required node fields
					assetRefs: {},
					bounds: { x: 0, y: 0, width: 1, height: 1 },
				}),
			),
		).toBe("invalid-payload");
	});

	it("rejects payloads over the node-count cap", () => {
		const nodes = Array.from({ length: MAX_CLIPBOARD_NODES + 1 }, (_, i) =>
			createRect({ id: `r${i}`, bounds: { width: 10, height: 10 } }),
		);
		expect(errorCode(() => validateClipboardPayload(payloadWith(nodes)))).toBe(
			"too-many-nodes",
		);
	});

	it("rejects hostile depth", () => {
		let node: CanvasNode = createRect({
			id: "leaf",
			bounds: { width: 10, height: 10 },
		});
		for (let i = 0; i < 66; i++) {
			node = createGroup({ id: `g${i}`, children: [node] });
		}
		expect(errorCode(() => validateClipboardPayload(payloadWith([node])))).toBe(
			"excessive-depth",
		);
	});
});

describe("parseClipboardPayload", () => {
	it("round-trips serialized payloads", () => {
		const payload = payloadWith([
			createRect({ id: "r1", bounds: { width: 10, height: 10 } }),
		]);
		const parsed = parseClipboardPayload(JSON.stringify(payload));
		expect(parsed.nodes).toHaveLength(1);
	});

	it("rejects non-JSON text and oversized text", () => {
		expect(errorCode(() => parseClipboardPayload("not json{"))).toBe(
			"invalid-json",
		);
		const huge = `"${"x".repeat(MAX_CLIPBOARD_BYTES + 1)}"`;
		expect(errorCode(() => parseClipboardPayload(huge))).toBe(
			"payload-too-large",
		);
	});

	it("measures real UTF-8 bytes, not UTF-16 code units, for a CJK payload (C-11)", () => {
		// Each CJK char is 1 UTF-16 code unit but 3 UTF-8 bytes — `.length`
		// alone under-counts this payload by 3x and would let it slip past the
		// cap (real bytes ≈ 3x MAX_CLIPBOARD_BYTES, `.length` ≈ 0.5x it).
		const cjk = "中".repeat(Math.floor(MAX_CLIPBOARD_BYTES / 2) + 1);
		expect(cjk.length).toBeLessThan(MAX_CLIPBOARD_BYTES);
		expect(errorCode(() => parseClipboardPayload(cjk))).toBe(
			"payload-too-large",
		);
	});
});

describe("materializeClipboardNodes", () => {
	it("regenerates every node id and reports the id map", () => {
		const group = createGroup({
			id: "g",
			children: [
				createRect({ id: "r1", bounds: { width: 10, height: 10 } }),
				createRect({ id: "r2", bounds: { width: 10, height: 10 } }),
			],
		});
		const { nodes, idMap } = materializeClipboardNodes(
			payloadWith([group]),
			targetIR(),
			{ idFactory: seqFactory("new-") },
		);
		expect(nodes).toHaveLength(1);
		expect(idMap.get("g")).toBe("new-1");
		expect(idMap.get("r1")).toBe("new-2");
		expect(idMap.get("r2")).toBe("new-3");
	});

	it("same-document paste keeps asset references and adds nothing", () => {
		const target = targetIR("doc-1");
		const payload = payloadWith(
			[
				createImage({
					id: "img",
					assetId: "asset-a",
					bounds: { width: 10, height: 10 },
				}),
			],
			{
				sourceDocumentId: "doc-1",
				assetRefs: { "asset-a": { id: "asset-a", uri: "https://x/a.png" } },
			},
		);
		const { nodes, assetsToAdd } = materializeClipboardNodes(payload, target, {
			idFactory: seqFactory("n"),
		});
		expect(assetsToAdd).toEqual({});
		expect((nodes[0] as { assetId: string }).assetId).toBe("asset-a");
	});

	it("cross-document paste copies missing assets as-is", () => {
		const payload = payloadWith(
			[
				createImage({
					id: "img",
					assetId: "asset-a",
					bounds: { width: 10, height: 10 },
				}),
			],
			{
				sourceDocumentId: "doc-other",
				assetRefs: { "asset-a": { id: "asset-a", uri: "https://x/a.png" } },
			},
		);
		const { assetsToAdd, nodes } = materializeClipboardNodes(
			payload,
			targetIR("doc-1"),
			{ idFactory: seqFactory("n") },
		);
		expect(assetsToAdd["asset-a"]?.uri).toBe("https://x/a.png");
		expect((nodes[0] as { assetId: string }).assetId).toBe("asset-a");
	});

	it("cross-document paste reuses identical assets without duplication", () => {
		const target = targetIR("doc-1");
		target.assets["asset-a"] = { id: "asset-a", uri: "https://x/a.png" };
		const payload = payloadWith(
			[
				createImage({
					id: "img",
					assetId: "asset-a",
					bounds: { width: 10, height: 10 },
				}),
			],
			{
				sourceDocumentId: "doc-other",
				assetRefs: { "asset-a": { id: "asset-a", uri: "https://x/a.png" } },
			},
		);
		const { assetsToAdd } = materializeClipboardNodes(payload, target, {
			idFactory: seqFactory("n"),
		});
		expect(assetsToAdd).toEqual({});
	});

	it("re-keys colliding-but-different assets and rewrites node references", () => {
		const target = targetIR("doc-1");
		target.assets["asset-a"] = { id: "asset-a", uri: "https://x/OTHER.png" };
		const payload = payloadWith(
			[
				createImage({
					id: "img",
					assetId: "asset-a",
					bounds: { width: 10, height: 10 },
				}),
				createGroup({
					id: "g",
					children: [
						createImage({
							id: "img2",
							assetId: "asset-a",
							bounds: { width: 10, height: 10 },
						}),
					],
				}),
			],
			{
				sourceDocumentId: "doc-other",
				assetRefs: { "asset-a": { id: "asset-a", uri: "https://x/a.png" } },
			},
		);
		const { assetsToAdd, nodes } = materializeClipboardNodes(payload, target, {
			idFactory: seqFactory("k"),
		});
		const addedKeys = Object.keys(assetsToAdd);
		expect(addedKeys).toHaveLength(1);
		const newKey = addedKeys[0];
		if (!newKey) throw new Error("no re-keyed asset");
		expect(newKey).not.toBe("asset-a");
		expect(assetsToAdd[newKey]?.uri).toBe("https://x/a.png");
		expect(assetsToAdd[newKey]?.id).toBe(newKey);
		// Every pasted reference — including nested ones — points at the new key.
		expect((nodes[0] as { assetId: string }).assetId).toBe(newKey);
		const nested = (nodes[1] as { children: { assetId: string }[] })
			.children[0];
		expect(nested?.assetId).toBe(newKey);
	});

	it("re-keys video.poster and frame.placeholder.assetId (C-1)", () => {
		const target = targetIR("doc-1");
		target.assets["asset-a"] = { id: "asset-a", uri: "https://x/OTHER.png" };
		const payload = payloadWith(
			[
				createVideo({
					id: "vid",
					assetId: "vid-asset",
					poster: "asset-a",
					bounds: { width: 10, height: 10 },
				}),
				createFrame({
					id: "frm",
					bounds: { width: 10, height: 10 },
					placeholder: { kind: "image", assetId: "asset-a" },
				}),
			],
			{
				sourceDocumentId: "doc-other",
				assetRefs: { "asset-a": { id: "asset-a", uri: "https://x/a.png" } },
			},
		);
		const { assetsToAdd, nodes } = materializeClipboardNodes(payload, target, {
			idFactory: seqFactory("k"),
		});
		const addedKeys = Object.keys(assetsToAdd);
		expect(addedKeys).toHaveLength(1);
		const newKey = addedKeys[0];
		if (!newKey) throw new Error("no re-keyed asset");
		expect((nodes[0] as { poster?: string }).poster).toBe(newKey);
		expect(
			(nodes[1] as { placeholder?: { assetId?: string } }).placeholder?.assetId,
		).toBe(newKey);
	});
});
