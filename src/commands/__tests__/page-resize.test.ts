import { describe, expect, it } from "vitest";
import {
	createCanvasIR,
	createGroup,
	createPage,
	createRect,
} from "../../ir/builders.js";
import type { CanvasIR, CanvasPage } from "../../ir/types.js";
import { applyCommand, CanvasCommandError } from "../runtime.js";
import type { CanvasPageResizeCommand } from "../types.js";

function makeIR(): CanvasIR {
	const page = createPage({ id: "p1", size: { width: 400, height: 200 } });
	page.root = createGroup({
		id: "root",
		bounds: { width: 400, height: 200 },
		children: [
			createRect({
				id: "a",
				transform: { x: 100, y: 50 },
				bounds: { width: 40, height: 20 },
			}),
			createRect({
				id: "b",
				transform: { x: 200, y: 100, scaleX: 2, scaleY: 2 },
				bounds: { width: 40, height: 20 },
			}),
		],
	});
	return createCanvasIR({ id: "ir", pages: [page], now: () => "T" });
}

function resize(
	to: { width: number; height: number },
	mode?: CanvasPageResizeCommand["mode"],
): CanvasPageResizeCommand {
	return {
		type: "page.resize",
		pageId: "p1",
		from: { width: 400, height: 200 },
		to,
		...(mode !== undefined ? { mode } : {}),
	};
}

function page(ir: CanvasIR): CanvasPage {
	const p = ir.pages[0];
	if (!p) throw new Error("no page");
	return p;
}

describe("page.resize command (B-01)", () => {
	it("canvas-only: resizes page + root bounds, preserves unit, leaves content", () => {
		const ir0 = makeIR();
		const unit = page(ir0).size.unit;
		const { ir: ir1, inverse } = applyCommand(
			ir0,
			resize({ width: 800, height: 400 }),
		);
		expect(page(ir1).size).toMatchObject({ width: 800, height: 400 });
		expect(page(ir1).size.unit).toBe(unit);
		expect(page(ir1).root.bounds).toEqual({ width: 800, height: 400 });
		expect(page(ir1).root.children[0]?.transform.x).toBe(100);
		const { ir: ir2 } = applyCommand(ir1, inverse);
		expect(JSON.stringify(ir2.pages)).toBe(JSON.stringify(ir0.pages));
	});

	it("recenter: offsets top-level content by half the delta; inverse exact", () => {
		const ir0 = makeIR();
		const { ir: ir1, inverse } = applyCommand(
			ir0,
			resize({ width: 600, height: 300 }, "recenter"),
		);
		expect(page(ir1).root.children[0]?.transform).toMatchObject({
			x: 200,
			y: 100,
		});
		const { ir: ir2 } = applyCommand(ir1, inverse);
		expect(JSON.stringify(ir2.pages)).toBe(JSON.stringify(ir0.pages));
	});

	it("scale-content: uniform min-ratio scale on position AND scale; inverse restores exactly", () => {
		const ir0 = makeIR();
		// 400x200 → 800x300: sx=2, sy=1.5 → s=1.5
		const { ir: ir1, inverse } = applyCommand(
			ir0,
			resize({ width: 800, height: 300 }, "scale-content"),
		);
		const a = page(ir1).root.children[0];
		const b = page(ir1).root.children[1];
		expect(a?.transform).toMatchObject({
			x: 150,
			y: 75,
			scaleX: 1.5,
			scaleY: 1.5,
		});
		expect(b?.transform).toMatchObject({
			x: 300,
			y: 150,
			scaleX: 3,
			scaleY: 3,
		});
		// Composite inverse (resize back + exact transform restores).
		const { ir: ir2 } = applyCommand(ir1, inverse);
		expect(JSON.stringify(ir2.pages)).toBe(JSON.stringify(ir0.pages));
	});

	it("scale-content: falls back to leaving content untouched for a zero-dimension prior page (C-12)", () => {
		const page0 = createPage({ id: "p1", size: { width: 0, height: 200 } });
		page0.root = createGroup({
			id: "root",
			bounds: { width: 0, height: 200 },
			children: [
				createRect({
					id: "a",
					transform: { x: 100, y: 50 },
					bounds: { width: 40, height: 20 },
				}),
			],
		});
		const ir0 = createCanvasIR({ id: "ir", pages: [page0], now: () => "T" });
		const { ir: ir1 } = applyCommand(
			ir0,
			{
				type: "page.resize",
				pageId: "p1",
				from: { width: 0, height: 200 },
				to: { width: 800, height: 300 },
				mode: "scale-content",
			},
			{ now: () => "T" },
		);
		const a = page(ir1).root.children[0];
		// No Infinity/NaN — the pre-existing transform is preserved verbatim,
		// matching canvas-only's behavior, since a 0-width prior page has no
		// meaningful scale ratio to compute.
		expect(a?.transform).toMatchObject({ x: 100, y: 50, scaleX: 1, scaleY: 1 });
		expect(Number.isFinite(a?.transform.x)).toBe(true);
		expect(page(ir1).size).toMatchObject({ width: 800, height: 300 });
	});

	it("inverse uses the ACTUAL prior size even when cmd.from is stale", () => {
		const ir0 = makeIR();
		const stale: CanvasPageResizeCommand = {
			type: "page.resize",
			pageId: "p1",
			from: { width: 1, height: 1 }, // wrong on purpose
			to: { width: 500, height: 500 },
		};
		const { inverse } = applyCommand(ir0, stale);
		expect(inverse).toMatchObject({ to: { width: 400, height: 200 } });
	});

	it("unknown page is a typed error", () => {
		let code: string | null = null;
		try {
			applyCommand(makeIR(), {
				...resize({ width: 10, height: 10 }),
				pageId: "nope",
			});
		} catch (err) {
			code = err instanceof CanvasCommandError ? err.code : "unexpected-type";
		}
		expect(code).toBe("page-not-found");
	});
});

describe("page.set-background command (B-11)", () => {
	it("sets the background and the inverse restores the actual prior", () => {
		const ir0 = makeIR();
		const { ir: ir1, inverse } = applyCommand(ir0, {
			type: "page.set-background",
			pageId: "p1",
			to: { kind: "solid", value: "#123456" },
		});
		expect(page(ir1).background).toEqual({ kind: "solid", value: "#123456" });
		const { ir: ir2 } = applyCommand(ir1, inverse);
		expect(JSON.stringify(ir2.pages)).toBe(JSON.stringify(ir0.pages));
	});
});
