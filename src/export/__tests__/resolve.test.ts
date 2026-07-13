import { describe, expect, it } from "vitest";
import { createCanvasIR } from "../../ir/builders.js";
import { resolveInlineExportDocument } from "../resolve.js";
import type { CanvasExportJobSource } from "../types.js";

describe("resolveInlineExportDocument", () => {
	it("resolves an inline document", () => {
		const document = createCanvasIR({
			id: "doc1",
			now: () => "2026-07-13T00:00:00.000Z",
		});
		const source: CanvasExportJobSource = { document };
		const resolved = resolveInlineExportDocument(source);
		expect(resolved.id).toBe("doc1");
		expect(resolved.version).toBe("2");
	});

	it("migrates a v1 document supplied inline", () => {
		const v1Document = {
			...createCanvasIR({ id: "doc1", now: () => "2026-07-13T00:00:00.000Z" }),
			version: "1",
		};
		const source: CanvasExportJobSource = {
			document: v1Document as never,
		};
		const resolved = resolveInlineExportDocument(source);
		expect(resolved.version).toBe("2");
	});

	it("throws for a documentRef source (host/worker resolution only)", () => {
		const source: CanvasExportJobSource = { documentRef: "opaque-ref-123" };
		expect(() => resolveInlineExportDocument(source)).toThrow(
			/documentRef requires host\/worker resolution/,
		);
	});
});
