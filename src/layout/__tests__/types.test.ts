import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import type {
	CanvasResolvedDocument,
	CanvasResolvedNodeRecord,
} from "../types.js";
import { createResolvedView, toResolvedNodeId } from "../types.js";

const LAYOUT_DIR = fileURLToPath(new URL("..", import.meta.url));

function record(
	id: string,
	childIds: string[] = [],
	parentId?: string,
): CanvasResolvedNodeRecord {
	return {
		id: toResolvedNodeId(id),
		sourceNodeId: id,
		...(parentId ? { parentId: toResolvedNodeId(parentId) } : {}),
		childIds: childIds.map(toResolvedNodeId),
		node: {
			type: "rect",
			id,
			transform: { x: 0, y: 0, rotation: 0, scaleX: 1, scaleY: 1 },
			bounds: { width: 10, height: 10 },
			fill: { type: "solid", value: "#000" },
		},
		geometry: {
			localTransform: { x: 0, y: 0, rotation: 0, scaleX: 1, scaleY: 1 },
			bounds: { width: 10, height: 10 },
			worldTransform: [1, 0, 0, 1, 0, 0],
			worldAabb: { minX: 0, minY: 0, maxX: 10, maxY: 10 },
			layoutFootprint: { minX: 0, minY: 0, maxX: 10, maxY: 10 },
		},
	};
}

function document(
	records: CanvasResolvedNodeRecord[],
	pageRoots: Record<string, string[]> = {},
): CanvasResolvedDocument {
	return {
		source: {
			version: "3",
			id: "d",
			title: "d",
			pages: [],
			assets: {},
			metadata: { createdAt: "", updatedAt: "" },
		},
		records: new Map(records.map((r) => [r.id, r])),
		pageRoots: new Map(
			Object.entries(pageRoots).map(([page, ids]) => [
				page,
				ids.map(toResolvedNodeId),
			]),
		),
		diagnostics: [],
		engineVersion: 1,
		inputHash: "test",
	};
}

describe("resolved-tree contracts (T-M2-01)", () => {
	// TS-55. `check:layering` only inspects import direction, so it cannot see a
	// persisted shape DECLARED in the wrong domain — nothing would import it
	// upward and the gate would stay green while `ir/validators.ts` (rank 1) was
	// left unable to type the field it must spread. This is the check for that.
	it("declares no persisted shape anywhere in layout/", () => {
		const persistedShapes = [
			"CanvasAutoLayout",
			"CanvasLayoutItem",
			"CanvasDocumentCompatibility",
			"CanvasKnownCapability",
			"CanvasLayoutMaterialization",
		];
		const sources = readdirSync(LAYOUT_DIR).filter((f) => f.endsWith(".ts"));
		expect(sources.length).toBeGreaterThan(0);
		for (const file of sources) {
			const code = readFileSync(`${LAYOUT_DIR}${file}`, "utf8");
			for (const shape of persistedShapes) {
				expect(
					new RegExp(`export (interface|type|const) ${shape}\\b`).test(code),
					`${file} declares the persisted shape ${shape}; it belongs in ir/types.ts (TD §17)`,
				).toBe(false);
			}
		}
	});

	it("reuses the geometry types verbatim rather than redeclaring them", () => {
		const code = readFileSync(`${LAYOUT_DIR}types.ts`, "utf8");
		expect(code).toMatch(/from "\.\.\/geometry\/affine\.js"/);
		expect(code).toMatch(/from "\.\.\/geometry\/hit-test\.js"/);
		for (const forbidden of ["CanvasTransformMatrix", "CanvasAabb"]) {
			// A *declaration*, not a mention: the file's own doc comment names
			// both as the parallel types this design deliberately refuses to
			// introduce, and a substring check would fail on that prose.
			expect(
				new RegExp(`(interface|type|class) ${forbidden}\\b`).test(code),
				`layout/types.ts declares ${forbidden}; geometry types are reused verbatim (TD §5.4)`,
			).toBe(false);
		}
	});

	it("brands a source node id without changing its value", () => {
		expect(toResolvedNodeId("node-1")).toBe("node-1");
	});
});

describe("createResolvedView (TD §12.1)", () => {
	const doc = document(
		[
			record("root", ["a", "b"]),
			record("a", [], "root"),
			record("b", [], "root"),
		],
		{ "page-1": ["root"] },
	);
	const view = createResolvedView(doc);

	it("looks records up by branded or plain id", () => {
		expect(view.getRecord("a")?.sourceNodeId).toBe("a");
		expect(view.getRecord(toResolvedNodeId("a"))?.sourceNodeId).toBe("a");
		expect(view.getRecord("missing")).toBeUndefined();
	});

	it("returns children in stored flow order", () => {
		expect(view.getChildren("root").map((r) => r.sourceNodeId)).toEqual([
			"a",
			"b",
		]);
		expect(view.getChildren("a")).toEqual([]);
		expect(view.getChildren("missing")).toEqual([]);
	});

	it("returns page roots, and an empty list for an unknown page", () => {
		expect(view.getPageRoots("page-1").map((r) => r.sourceNodeId)).toEqual([
			"root",
		]);
		expect(view.getPageRoots("page-2")).toEqual([]);
	});

	it("skips dangling ids rather than returning holes", () => {
		// A childId with no record must not surface as `undefined` in an array
		// consumers iterate — every consumer would then need a null check that
		// the view exists to remove.
		const dangling = document([record("root", ["ghost"])], {
			"page-1": ["ghost"],
		});
		const danglingView = createResolvedView(dangling);
		expect(danglingView.getChildren("root")).toEqual([]);
		expect(danglingView.getPageRoots("page-1")).toEqual([]);
	});
});
