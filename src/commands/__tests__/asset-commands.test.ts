import { describe, expect, it } from "vitest";
import {
	createAudio,
	createCanvasIR,
	createComponentInstance,
	createFrame,
	createImage,
	createPage,
	createSvg,
	createVideo,
} from "../../ir/builders.js";
import type {
	CanvasComponentInstanceNode,
	CanvasFrameNode,
	CanvasIR,
	CanvasVideoNode,
} from "../../ir/types.js";
import { commandToChangeRecord } from "../change-events.js";
import { applyCommand, CanvasCommandError } from "../runtime.js";

function makeIR(): CanvasIR {
	const ir = createCanvasIR({
		id: "ir",
		pages: [createPage({ id: "p1" })],
		now: () => "T",
	});
	ir.assets["existing"] = { id: "existing", uri: "https://x/old.png" };
	return ir;
}

describe("asset.put / asset.remove commands", () => {
	it("adds a new asset; the inverse removes it", () => {
		const ir0 = makeIR();
		const { ir: ir1, inverse } = applyCommand(ir0, {
			type: "asset.put",
			asset: { id: "a1", uri: "https://x/a.png" },
		});
		expect(ir1.assets.a1?.uri).toBe("https://x/a.png");
		expect(inverse).toEqual({ type: "asset.remove", assetId: "a1" });
		const { ir: ir2 } = applyCommand(ir1, inverse);
		expect(ir2.assets.a1).toBeUndefined();
	});

	it("overwrites an existing asset; the inverse restores the previous value", () => {
		const ir0 = makeIR();
		const { ir: ir1, inverse } = applyCommand(ir0, {
			type: "asset.put",
			asset: { id: "existing", uri: "https://x/new.png" },
		});
		expect(ir1.assets.existing?.uri).toBe("https://x/new.png");
		const { ir: ir2 } = applyCommand(ir1, inverse);
		expect(ir2.assets.existing?.uri).toBe("https://x/old.png");
	});

	it("asset.remove of a missing id is a typed error (asset-not-found, not node-not-found — C-18)", () => {
		let code: string | null = null;
		try {
			applyCommand(makeIR(), { type: "asset.remove", assetId: "nope" });
		} catch (err) {
			code = err instanceof CanvasCommandError ? err.code : "unexpected-type";
		}
		expect(code).toBe("asset-not-found");
	});

	it("produces a document-level change record without a pageId", () => {
		const ir = makeIR();
		const record = commandToChangeRecord(
			{ type: "asset.put", asset: { id: "a1", uri: "https://x/a.png" } },
			ir,
			{ commandId: "c1", now: () => "T" },
		);
		expect(record).toMatchObject({
			nodeIds: [],
			change: { kind: "asset", assetId: "a1", op: "put" },
		});
		expect(record?.pageId).toBeUndefined();
	});

	it("migrates every reference atomically, including locked nodes and Component Sources", () => {
		const ir0 = makeIR();
		ir0.assets.local = { id: "local", uri: "blob:local" };
		const page = ir0.pages[0]!;
		page.root.children = [
			{
				...createImage({
					id: "image",
					assetId: "local",
					maskAssetId: "local",
					bounds: { width: 10, height: 10 },
				}),
				locked: true,
			},
			createFrame({
				id: "frame",
				bounds: { width: 10, height: 10 },
				placeholder: { kind: "image", assetId: "local" },
				children: [
					createSvg({
						id: "svg",
						assetId: "local",
						bounds: { width: 10, height: 10 },
					}),
				],
			}),
			createVideo({
				id: "video",
				assetId: "local",
				poster: "local",
				bounds: { width: 10, height: 10 },
			}),
			createAudio({
				id: "audio",
				assetId: "local",
				bounds: { width: 10, height: 10 },
			}),
			createComponentInstance({
				id: "instance",
				componentId: "component",
				bounds: { width: 10, height: 10 },
				overrides: {
					image: { kind: "image", assetId: "local" },
				},
			}),
		];
		ir0.components = {
			component: {
				id: "component",
				name: "Component",
				revision: 1,
				root: createSvg({
					id: "component-svg",
					assetId: "local",
					bounds: { width: 10, height: 10 },
				}),
				properties: [],
			},
		};

		const { ir: ir1, inverse } = applyCommand(
			ir0,
			{
				type: "asset.migrate",
				fromAssetId: "local",
				asset: { id: "hosted", uri: "https://cdn.example.com/hosted.png" },
			},
			{ enforceLocked: true },
		);
		expect(ir1.assets.local).toBeUndefined();
		expect(ir1.assets.hosted?.uri).toContain("cdn.example.com");
		const [image, frame, video, audio, instance] = ir1.pages[0]!.root.children;
		expect(image).toMatchObject({
			type: "image",
			assetId: "hosted",
			maskAssetId: "hosted",
			locked: true,
		});
		expect((frame as CanvasFrameNode).placeholder?.assetId).toBe("hosted");
		expect((frame as CanvasFrameNode).children[0]).toMatchObject({
			assetId: "hosted",
		});
		expect(video as CanvasVideoNode).toMatchObject({
			assetId: "hosted",
			poster: "hosted",
		});
		expect(audio).toMatchObject({ assetId: "hosted" });
		expect(
			(instance as CanvasComponentInstanceNode).overrides?.image,
		).toMatchObject({ assetId: "hosted" });
		expect(ir1.components?.component?.root).toMatchObject({
			assetId: "hosted",
		});
		expect(ir1.components?.component?.revision).toBe(2);

		const { ir: restored } = applyCommand(ir1, inverse);
		expect(restored.assets.local?.uri).toBe("blob:local");
		expect(restored.assets.hosted).toBeUndefined();
		expect(restored.pages[0]!.root.children[0]).toMatchObject({
			assetId: "local",
			maskAssetId: "local",
		});
		expect(restored.components?.component?.root).toMatchObject({
			assetId: "local",
		});
	});

	it("refuses to overwrite another asset id during migration", () => {
		const ir = makeIR();
		ir.assets.local = { id: "local", uri: "blob:local" };
		expect(() =>
			applyCommand(ir, {
				type: "asset.migrate",
				fromAssetId: "local",
				asset: { id: "existing", uri: "https://cdn.example.com/new.png" },
			}),
		).toThrow(/already exists/);
	});
});
