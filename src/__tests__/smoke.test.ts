import { describe, expect, it } from "vitest";
import pkg from "../../package.json" with { type: "json" };
import type { CanvasIR } from "../index.js";
import { CANVAS_CORE_VERSION, CanvasIRSchema } from "../index.js";

const FIXED_TS = "2026-05-20T00:00:00.000Z";

const minimalIR: CanvasIR = {
	version: "1",
	id: "ir-1",
	title: "Smoke",
	pages: [
		{
			id: "page-1",
			size: { width: 1080, height: 1080, unit: "px" },
			background: { kind: "solid", value: "#ffffff" },
			root: {
				id: "root-1",
				type: "group",
				transform: { x: 0, y: 0, rotation: 0, scaleX: 1, scaleY: 1 },
				bounds: { width: 1080, height: 1080 },
				zIndex: 0,
				children: [],
			},
		},
	],
	assets: {},
	metadata: { createdAt: FIXED_TS, updatedAt: FIXED_TS },
};

describe("canvas-core smoke", () => {
	it("exports a version constant that matches package.json (guards drift)", () => {
		expect(CANVAS_CORE_VERSION).toBe(pkg.version);
	});

	it("validates a minimal real CanvasIR", () => {
		const result = CanvasIRSchema.safeParse(minimalIR);
		expect(result.success).toBe(true);
	});

	it("rejects an IR missing required fields", () => {
		const broken = { ...minimalIR, version: "2" };
		expect(CanvasIRSchema.safeParse(broken).success).toBe(false);
	});
});
