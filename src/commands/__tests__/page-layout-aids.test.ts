import { describe, expect, it } from "vitest";
import { createCanvasIR, createGroup, createPage } from "../../ir/builders.js";
import type {
	CanvasIR,
	CanvasPage,
	CanvasPageLayoutAids,
} from "../../ir/types.js";
import { commandToChange } from "../change-events.js";
import { applyCommand, CanvasCommandError } from "../runtime.js";
import type { CanvasPageSetLayoutAidsCommand } from "../types.js";

const AIDS: CanvasPageLayoutAids = {
	guides: { horizontal: [24, 96], vertical: [48] },
	margin: { top: 16, right: 16, bottom: 16, left: 16 },
};

function makeIR(layoutAids?: CanvasPageLayoutAids): CanvasIR {
	const page = createPage({
		id: "p1",
		size: { width: 400, height: 200 },
		...(layoutAids !== undefined ? { layoutAids } : {}),
	});
	page.root = createGroup({
		id: "root",
		bounds: { width: 400, height: 200 },
	});
	return createCanvasIR({ id: "ir", pages: [page], now: () => "T" });
}

function page(ir: CanvasIR): CanvasPage {
	const p = ir.pages[0];
	if (!p) throw new Error("no page");
	return p;
}

function setAids(
	to: CanvasPageLayoutAids | undefined,
): CanvasPageSetLayoutAidsCommand {
	return { type: "page.set-layout-aids", pageId: "p1", to };
}

describe("page.set-layout-aids command (C-01, §9.3)", () => {
	it("sets layout aids and the inverse restores the prior absent state", () => {
		const ir0 = makeIR();
		const { ir: ir1, inverse } = applyCommand(ir0, setAids(AIDS));
		expect(page(ir1).layoutAids).toEqual(AIDS);
		const { ir: ir2 } = applyCommand(ir1, inverse);
		expect("layoutAids" in page(ir2)).toBe(false);
		expect(JSON.stringify(ir2.pages)).toBe(JSON.stringify(ir0.pages));
	});

	it("clearing with `to: undefined` drops the key entirely", () => {
		const ir0 = makeIR(AIDS);
		const { ir: ir1, inverse } = applyCommand(ir0, setAids(undefined));
		expect("layoutAids" in page(ir1)).toBe(false);
		const { ir: ir2 } = applyCommand(ir1, inverse);
		expect(page(ir2).layoutAids).toEqual(AIDS);
		expect(JSON.stringify(ir2.pages)).toBe(JSON.stringify(ir0.pages));
	});

	it("inverse restores the ACTUAL prior value even when cmd.from is stale", () => {
		const ir0 = makeIR(AIDS);
		const stale: CanvasPageSetLayoutAidsCommand = {
			type: "page.set-layout-aids",
			pageId: "p1",
			from: { margin: { top: 999, right: 999, bottom: 999, left: 999 } },
			to: { guides: { horizontal: [], vertical: [1] } },
		};
		const { inverse } = applyCommand(ir0, stale);
		expect(inverse).toMatchObject({ to: AIDS });
	});

	it("replaces the whole object (a guide move is expressed as a full next value)", () => {
		const ir0 = makeIR(AIDS);
		const moved: CanvasPageLayoutAids = {
			...AIDS,
			guides: { horizontal: [30, 96], vertical: [48] },
		};
		const { ir: ir1 } = applyCommand(ir0, setAids(moved));
		expect(page(ir1).layoutAids).toEqual(moved);
		// margin rides along untouched
		expect(page(ir1).layoutAids?.margin).toEqual(AIDS.margin);
	});

	it("unknown page is a typed page-not-found error", () => {
		let code: string | null = null;
		try {
			applyCommand(makeIR(), { ...setAids(AIDS), pageId: "nope" });
		} catch (err) {
			code = err instanceof CanvasCommandError ? err.code : "unexpected-type";
		}
		expect(code).toBe("page-not-found");
	});

	it("bumps document metadata like other page commands", () => {
		const ir0 = makeIR();
		const { ir: ir1 } = applyCommand(ir0, setAids(AIDS), { now: () => "T2" });
		expect(ir1.metadata.updatedAt).toBe("T2");
	});

	it("maps to a page/layout-aids change event", () => {
		expect(commandToChange(setAids(AIDS))).toEqual({
			kind: "page",
			pageId: "p1",
			op: "layout-aids",
		});
	});
});
