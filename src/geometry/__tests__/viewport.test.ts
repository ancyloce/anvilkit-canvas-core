import { describe, expect, it } from "vitest";
import {
	screenToWorld,
	type ViewportDescriptor,
	viewportMatrix,
	worldToScreen,
} from "../geometry/viewport.js";

const viewports: ViewportDescriptor[] = [
	{ zoom: 1, panX: 0, panY: 0 },
	{ zoom: 2, panX: 50, panY: -30 },
	{ zoom: 0.5, panX: -120, panY: 200 },
	{ zoom: 1.75, panX: 13.5, panY: 7.25 },
];

describe("viewportMatrix", () => {
	it("is the CanvasStage transform [zoom,0,0,zoom,panX,panY]", () => {
		expect(viewportMatrix({ zoom: 2, panX: 50, panY: -30 })).toEqual([
			2, 0, 0, 2, 50, -30,
		]);
	});
});

describe("worldToScreen", () => {
	it("applies screen = world * zoom + pan", () => {
		expect(
			worldToScreen({ zoom: 2, panX: 50, panY: -30 }, { x: 10, y: 5 }),
		).toEqual({ x: 70, y: -20 });
	});
});

describe("screenToWorld", () => {
	it("round-trips worldToScreen across viewports", () => {
		const p = { x: 42, y: -17 };
		for (const v of viewports) {
			const back = screenToWorld(v, worldToScreen(v, p));
			expect(back.x).toBeCloseTo(p.x, 9);
			expect(back.y).toBeCloseTo(p.y, 9);
		}
	});

	it("inverts pan and zoom", () => {
		expect(
			screenToWorld({ zoom: 2, panX: 50, panY: -30 }, { x: 70, y: -20 }),
		).toEqual({ x: 10, y: 5 });
	});

	it("throws on a zero-zoom viewport", () => {
		expect(() =>
			screenToWorld({ zoom: 0, panX: 0, panY: 0 }, { x: 1, y: 1 }),
		).toThrow(/singular/);
	});
});
