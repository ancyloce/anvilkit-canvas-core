import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import type { BoundsExtent } from "../../geometry/affine.js";
import type { CanvasBounds, CanvasInsets } from "../../ir/types.js";
import { type AxisAdapter, axisFor } from "../axis.js";

const horizontal = axisFor("horizontal");
const vertical = axisFor("vertical");

/** Swap x↔y in an extent — the geometric definition of "transposed". */
function transposeExtent(extent: BoundsExtent): BoundsExtent {
	return {
		minX: extent.minY,
		minY: extent.minX,
		maxX: extent.maxY,
		maxY: extent.maxX,
	};
}

function transposeBounds(bounds: CanvasBounds): CanvasBounds {
	return { width: bounds.height, height: bounds.width };
}

/** Rotate the insets a quarter turn: top↔left, right↔bottom. */
function transposeInsets(insets: CanvasInsets): CanvasInsets {
	return {
		top: insets.left,
		right: insets.bottom,
		bottom: insets.right,
		left: insets.top,
	};
}

const BOUNDS: CanvasBounds = { width: 120, height: 45 };
const EXTENT: BoundsExtent = { minX: -3, minY: 7, maxX: 117, maxY: 52 };
const INSETS: CanvasInsets = { top: 1, right: 2, bottom: 4, left: 8 };

describe("axis adapter (T-M2-02)", () => {
	it("reads the horizontal axis as x/width", () => {
		expect(horizontal.mainAxis).toBe("horizontal");
		expect(horizontal.crossAxis).toBe("vertical");
		expect(horizontal.mainSizingField).toBe("widthSizing");
		expect(horizontal.crossSizingField).toBe("heightSizing");
		expect(horizontal.mainSize(BOUNDS)).toBe(120);
		expect(horizontal.crossSize(BOUNDS)).toBe(45);
		expect(horizontal.mainExtent(EXTENT)).toBe(120);
		expect(horizontal.crossExtent(EXTENT)).toBe(45);
		expect(horizontal.mainExtentStart(EXTENT)).toBe(-3);
		expect(horizontal.crossExtentStart(EXTENT)).toBe(7);
		expect(horizontal.createBounds(10, 20)).toEqual({ width: 10, height: 20 });
		expect(horizontal.createPosition(10, 20)).toEqual({ x: 10, y: 20 });
		expect(horizontal.mainPaddingStart(INSETS)).toBe(8);
		expect(horizontal.mainPaddingEnd(INSETS)).toBe(2);
		expect(horizontal.crossPaddingStart(INSETS)).toBe(1);
		expect(horizontal.crossPaddingEnd(INSETS)).toBe(4);
	});

	it("reads the vertical axis as y/height", () => {
		expect(vertical.mainAxis).toBe("vertical");
		expect(vertical.crossAxis).toBe("horizontal");
		expect(vertical.mainSizingField).toBe("heightSizing");
		expect(vertical.crossSizingField).toBe("widthSizing");
		expect(vertical.mainSize(BOUNDS)).toBe(45);
		expect(vertical.crossSize(BOUNDS)).toBe(120);
		expect(vertical.createBounds(10, 20)).toEqual({ width: 20, height: 10 });
		expect(vertical.createPosition(10, 20)).toEqual({ x: 20, y: 10 });
		expect(vertical.mainPaddingStart(INSETS)).toBe(1);
		expect(vertical.mainPaddingEnd(INSETS)).toBe(4);
		expect(vertical.crossPaddingStart(INSETS)).toBe(8);
		expect(vertical.crossPaddingEnd(INSETS)).toBe(2);
	});

	// TS-16's adapter half. The fixture-level transposition equivalence lands
	// with the solver (T-M2-10); this asserts the property the solver relies on
	// to get it for free — that vertical IS horizontal with the inputs
	// transposed, method for method, rather than a second hand-written table.
	it("is the exact transpose of horizontal, for every accessor", () => {
		expect(vertical.mainSize(transposeBounds(BOUNDS))).toBe(
			horizontal.mainSize(BOUNDS),
		);
		expect(vertical.crossSize(transposeBounds(BOUNDS))).toBe(
			horizontal.crossSize(BOUNDS),
		);
		expect(vertical.mainExtent(transposeExtent(EXTENT))).toBe(
			horizontal.mainExtent(EXTENT),
		);
		expect(vertical.crossExtent(transposeExtent(EXTENT))).toBe(
			horizontal.crossExtent(EXTENT),
		);
		expect(vertical.mainExtentStart(transposeExtent(EXTENT))).toBe(
			horizontal.mainExtentStart(EXTENT),
		);
		expect(vertical.crossExtentStart(transposeExtent(EXTENT))).toBe(
			horizontal.crossExtentStart(EXTENT),
		);
		expect(vertical.createBounds(7, 9)).toEqual(
			transposeBounds(horizontal.createBounds(7, 9)),
		);
		const h = horizontal.createPosition(7, 9);
		expect(vertical.createPosition(7, 9)).toEqual({ x: h.y, y: h.x });
		for (const edge of [
			"mainPaddingStart",
			"mainPaddingEnd",
			"crossPaddingStart",
			"crossPaddingEnd",
		] as const satisfies readonly (keyof AxisAdapter)[]) {
			expect(vertical[edge](transposeInsets(INSETS)), edge).toBe(
				horizontal[edge](INSETS),
			);
		}
	});

	it("returns the same adapter instance per direction", () => {
		// Adapters are stateless; a fresh object per Auto Layout container per
		// pass would allocate on the hot path for nothing.
		expect(axisFor("horizontal")).toBe(horizontal);
		expect(axisFor("vertical")).toBe(vertical);
	});

	// T-M2-02's stated acceptance criterion, made executable: if a direction
	// branch escapes into the solver, this fails rather than waiting for a
	// transposed fixture to disagree in some later milestone.
	it("is the only module in layout/ that names a direction", () => {
		const solverSources = [
			"../resolve.ts",
			"../dependency-graph.ts",
			"../measure.ts",
			"../cache.ts",
			"../materialize.ts",
		];
		for (const relative of solverSources) {
			let source: string;
			try {
				source = readFileSync(
					fileURLToPath(new URL(relative, import.meta.url)),
					"utf8",
				);
			} catch {
				// Not landed yet — later E-tasks in this milestone add them.
				continue;
			}
			// Strip comments and diagnostic message strings: prose and a
			// user-facing `axis` value in a message are not direction branches.
			const code = source
				.replace(/\/\*[\s\S]*?\*\//g, "")
				.replace(/^\s*\/\/.*$/gm, "")
				.replace(/`[^`]*`/g, "``");
			const offenders = code
				.split("\n")
				.filter((line) => /"(horizontal|vertical)"/.test(line));
			expect(offenders, `${relative} branches on a direction literal`).toEqual(
				[],
			);
		}
	});
});
