import { describe, expect, it } from "vitest";
import { CANVAS_CORE_VERSION, CanvasIRStub } from "../index.js";

describe("canvas-core smoke", () => {
	it("exports a version constant", () => {
		expect(CANVAS_CORE_VERSION).toBe("0.1.0");
	});

	it("accepts a valid CanvasIRStub payload", () => {
		expect(CanvasIRStub.safeParse({ version: "0.0.0" }).success).toBe(true);
	});

	it("rejects an invalid CanvasIRStub payload", () => {
		expect(CanvasIRStub.safeParse({ version: "1.0.0" }).success).toBe(false);
	});
});
