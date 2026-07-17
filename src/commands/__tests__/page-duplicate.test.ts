import fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
	createCanvasIR,
	createGroup,
	createPage,
	createRect,
} from "../../ir/builders.js";
import type { CanvasIR, CanvasPage } from "../../ir/types.js";
import { walkPage } from "../../ir/walkers.js";
import { commandToChange } from "../change-events.js";
import { applyCommand, CanvasCommandError } from "../runtime.js";
import type { CanvasPageDuplicateCommand } from "../types.js";

/**
 * p1: root ── a (rect) ── g1 (group) ── b (rect)
 * p2: root ── c (rect)
 */
function makeIR(): CanvasIR {
	const p1 = createPage({
		id: "p1",
		name: "Page 1",
		size: { width: 400, height: 200 },
		background: { kind: "solid", value: "#ff0000" },
		layoutAids: {
			margin: { top: 10, right: 10, bottom: 10, left: 10 },
			guides: { horizontal: [50], vertical: [25] },
		},
	});
	p1.root = createGroup({
		id: "root-1",
		bounds: p1.root.bounds,
		children: [
			createRect({ id: "a", bounds: { width: 1, height: 1 } }),
			createGroup({
				id: "g1",
				children: [createRect({ id: "b", bounds: { width: 1, height: 1 } })],
			}),
		],
	});
	const p2 = createPage({ id: "p2", name: "Page 2" });
	p2.root = createGroup({
		id: "root-2",
		bounds: p2.root.bounds,
		children: [createRect({ id: "c", bounds: { width: 1, height: 1 } })],
	});
	return createCanvasIR({ id: "ir", pages: [p1, p2], now: () => "T" });
}

function duplicate(
	sourcePageId: string,
	newPageId: string,
	name?: string,
): CanvasPageDuplicateCommand {
	return {
		type: "page.duplicate",
		sourcePageId,
		newPageId,
		...(name !== undefined ? { name } : {}),
	};
}

function page(ir: CanvasIR, id: string): CanvasPage {
	const p = ir.pages.find((p) => p.id === id);
	if (!p) throw new Error(`page ${id} not found`);
	return p;
}

function allIds(p: CanvasPage): string[] {
	const ids: string[] = [];
	walkPage(p, ({ node }) => {
		ids.push(node.id);
	});
	return ids;
}

/** Runs `fn`; returns the CanvasCommandError code, or null when nothing threw. */
function errorCode(fn: () => unknown): string | null {
	try {
		fn();
		return null;
	} catch (err) {
		return err instanceof CanvasCommandError ? err.code : "unexpected-type";
	}
}

describe("page.duplicate command", () => {
	it("clones the node tree with fresh, unique ids preserving hierarchy", () => {
		const ir0 = makeIR();
		const { ir: ir1 } = applyCommand(ir0, duplicate("p1", "p1-copy"));
		const copy = page(ir1, "p1-copy");
		const source = page(ir0, "p1");

		// Same shape: root has 2 children, g1 has 1 child.
		expect(copy.root.children).toHaveLength(2);
		const copyGroup = copy.root.children[1];
		if (!copyGroup || copyGroup.type !== "group") {
			throw new Error("expected copy's second child to be a group");
		}
		expect(copyGroup.children).toHaveLength(1);

		// Every id in the copy is fresh (none collide with the source's ids).
		const sourceIds = new Set(allIds(source));
		const copyIds = allIds(copy);
		expect(new Set(copyIds).size).toBe(copyIds.length); // all unique
		for (const id of copyIds) {
			expect(sourceIds.has(id)).toBe(false);
		}
		// The page id itself is the caller-supplied one.
		expect(copy.id).toBe("p1-copy");
	});

	it("preserves page-level fields: size, background, layoutAids", () => {
		const ir0 = makeIR();
		const { ir: ir1 } = applyCommand(ir0, duplicate("p1", "p1-copy"));
		const copy = page(ir1, "p1-copy");
		const source = page(ir0, "p1");
		expect(copy.size).toEqual(source.size);
		expect(copy.background).toEqual(source.background);
		expect(copy.layoutAids).toEqual(source.layoutAids);
	});

	it("defaults the duplicate's name to '<source name> copy'", () => {
		const ir0 = makeIR();
		const { ir: ir1 } = applyCommand(ir0, duplicate("p1", "p1-copy"));
		expect(page(ir1, "p1-copy").name).toBe("Page 1 copy");
	});

	it("accepts an explicit name override", () => {
		const ir0 = makeIR();
		const { ir: ir1 } = applyCommand(
			ir0,
			duplicate("p1", "p1-copy", "My Custom Copy"),
		);
		expect(page(ir1, "p1-copy").name).toBe("My Custom Copy");
	});

	it("inserts the duplicate immediately after the source page", () => {
		const ir0 = makeIR();
		const { ir: ir1 } = applyCommand(ir0, duplicate("p1", "p1-copy"));
		expect(ir1.pages.map((p) => p.id)).toEqual(["p1", "p1-copy", "p2"]);
	});

	it("leaves the source page and all other pages untouched", () => {
		const ir0 = makeIR();
		const { ir: ir1 } = applyCommand(ir0, duplicate("p1", "p1-copy"));
		expect(JSON.stringify(page(ir1, "p1"))).toBe(
			JSON.stringify(page(ir0, "p1")),
		);
		expect(JSON.stringify(page(ir1, "p2"))).toBe(
			JSON.stringify(page(ir0, "p2")),
		);
	});

	it("undo removes exactly the duplicate and restores the original page list exactly", () => {
		const ir0 = makeIR();
		const { ir: ir1, inverse } = applyCommand(ir0, duplicate("p1", "p1-copy"));
		expect(inverse).toEqual({ type: "page.delete", pageId: "p1-copy" });
		const { ir: ir2 } = applyCommand(ir1, inverse);
		expect(JSON.stringify(ir2.pages)).toBe(JSON.stringify(ir0.pages));
	});

	it("redo (undo of undo) re-creates the duplicate identically", () => {
		const ir0 = makeIR();
		const { ir: ir1, inverse: undoCmd } = applyCommand(
			ir0,
			duplicate("p1", "p1-copy"),
		);
		const { ir: ir2, inverse: redoCmd } = applyCommand(ir1, undoCmd);
		expect(redoCmd.type).toBe("page.create");
		const { ir: ir3 } = applyCommand(ir2, redoCmd);
		expect(JSON.stringify(ir3.pages)).toBe(JSON.stringify(ir1.pages));
	});

	it("rejects duplicating a page that doesn't exist (page-not-found)", () => {
		expect(
			errorCode(() => applyCommand(makeIR(), duplicate("nope", "p1-copy"))),
		).toBe("page-not-found");
	});

	it("rejects a newPageId that collides with an existing page (invariant-violated)", () => {
		expect(errorCode(() => applyCommand(makeIR(), duplicate("p1", "p2")))).toBe(
			"invariant-violated",
		);
	});

	it("participates in a batch with a correct composite inverse", () => {
		const ir0 = makeIR();
		const { ir: ir1, inverse } = applyCommand(ir0, {
			type: "batch",
			commands: [duplicate("p1", "p1-copy"), duplicate("p2", "p2-copy")],
		});
		expect(ir1.pages.map((p) => p.id)).toEqual([
			"p1",
			"p1-copy",
			"p2",
			"p2-copy",
		]);
		const { ir: ir2 } = applyCommand(ir1, inverse);
		expect(JSON.stringify(ir2.pages)).toBe(JSON.stringify(ir0.pages));
	});

	it("commandToChange derives a page/duplicate change record from the command shape", () => {
		const cmd = duplicate("p1", "p1-copy");
		expect(commandToChange(cmd)).toEqual({
			kind: "page",
			pageId: "p1-copy",
			op: "duplicate",
		});
	});

	it("property: apply + inverse always restores the exact page list", () => {
		fc.assert(
			fc.property(
				fc.constantFrom("p1", "p2"),
				fc.string({ minLength: 1, maxLength: 12 }),
				(sourcePageId, suffix) => {
					const ir0 = makeIR();
					const newPageId = `dup-${suffix}`;
					const before = JSON.stringify(ir0.pages);
					const { ir: ir1, inverse } = applyCommand(
						ir0,
						duplicate(sourcePageId, newPageId),
					);
					expect(ir1.pages.some((p) => p.id === newPageId)).toBe(true);
					const { ir: ir2 } = applyCommand(ir1, inverse);
					expect(JSON.stringify(ir2.pages)).toBe(before);
				},
			),
		);
	});
});
