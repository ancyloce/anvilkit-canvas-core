import { describe, expect, it } from "vitest";
import { createCanvasIR, createPage } from "../../ir/builders.js";
import type { CanvasIR } from "../../ir/types.js";
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
});
