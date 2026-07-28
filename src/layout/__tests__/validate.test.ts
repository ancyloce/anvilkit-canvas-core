import { describe, expect, it } from "vitest";
import {
	createCanvasIR,
	createFrame,
	createGroup,
	createPage,
	createRect,
	createText,
} from "../../ir/builders.js";
import { CANVAS_LAYOUT_AUTO_CAPABILITY } from "../../ir/invariants.js";
import { insertNode } from "../../ir/mutations.js";
import type { CanvasIR, CanvasNode } from "../../ir/types.js";
import { MAX_FINITE_LAYOUT_MAGNITUDE } from "../../limits.js";
import type { CanvasLayoutIssueCode } from "../validate.js";
import {
	assertLayoutInvariants,
	CANVAS_LAYOUT_ISSUE_DEFAULTS,
	CanvasLayoutInvariantError,
	validateLayoutInvariants,
} from "../validate.js";

/**
 * @file T-M1-06 — layout invariant coverage (TS-46 one-per-code, TS-12 cycles).
 */

const box = { width: 40, height: 40 };

const layout = {
	version: 1,
	direction: "horizontal",
	padding: { top: 0, right: 0, bottom: 0, left: 0 },
	gap: 0,
	primaryAlign: "start",
	crossAlign: "start",
} as const;

/** Build a one-page document from a list of root children. */
function docOf(children: CanvasNode[], extra?: Partial<CanvasIR>): CanvasIR {
	const page = createPage({ id: "p1" });
	let ir = createCanvasIR({ id: "doc", title: "t", pages: [page] });
	for (const child of children) {
		ir = insertNode(ir, { parentId: page.root.id, node: child });
	}
	return extra ? { ...ir, ...extra } : ir;
}

/** A frame with layout, holding the given children. */
function frameWith(
	id: string,
	children: CanvasNode[],
	overrides?: Record<string, unknown>,
): CanvasNode {
	return {
		...createFrame({ id, bounds: box }),
		autoLayout: layout,
		children,
		...overrides,
	} as CanvasNode;
}

const codesOf = (ir: CanvasIR) =>
	validateLayoutInvariants(ir).map((i) => i.code);

describe("CANVAS_LAYOUT_ISSUE_DEFAULTS — the TD §14 table", () => {
	it("covers all 11 codes and nothing else", () => {
		expect(Object.keys(CANVAS_LAYOUT_ISSUE_DEFAULTS)).toHaveLength(11);
	});

	it("matches TD §14's severities exactly", () => {
		const errors = Object.entries(CANVAS_LAYOUT_ISSUE_DEFAULTS)
			.filter(([, v]) => v.severity === "error")
			.map(([k]) => k)
			.sort();
		expect(errors).toEqual([
			"layout-capability-unsupported",
			"layout-circular-sizing",
			"layout-depth-exceeded",
			"layout-invalid-number",
			"layout-negative-gap",
			"layout-negative-padding",
		]);
	});

	it("omits `fallback` only where TD §14 prescribes a clamp, not a geometry source", () => {
		const withoutFallback = Object.entries(CANVAS_LAYOUT_ISSUE_DEFAULTS)
			.filter(([, v]) => v.fallback === undefined)
			.map(([k]) => k)
			.sort();
		expect(withoutFallback).toEqual([
			"layout-materialization-stale",
			"layout-negative-gap",
			"layout-negative-padding",
		]);
	});
});

describe("statically decidable codes (M1)", () => {
	it("layout-negative-gap", () => {
		const ir = docOf([
			frameWith("f1", [], { autoLayout: { ...layout, gap: -4 } }),
		]);
		expect(codesOf(ir)).toContain("layout-negative-gap");
	});

	it("layout-negative-padding — on every edge", () => {
		for (const edge of ["top", "right", "bottom", "left"] as const) {
			const ir = docOf([
				frameWith("f1", [], {
					autoLayout: {
						...layout,
						padding: { ...layout.padding, [edge]: -1 },
					},
				}),
			]);
			expect(codesOf(ir)).toContain("layout-negative-padding");
		}
	});

	it("layout-invalid-number — non-finite and out-of-range", () => {
		const nonFinite = docOf([
			frameWith("f1", [], {
				autoLayout: { ...layout, gap: Number.POSITIVE_INFINITY },
			}),
		]);
		expect(codesOf(nonFinite)).toContain("layout-invalid-number");

		const tooBig = docOf([
			frameWith("f1", [], {
				autoLayout: { ...layout, gap: MAX_FINITE_LAYOUT_MAGNITUDE * 10 },
			}),
		]);
		expect(codesOf(tooBig)).toContain("layout-invalid-number");
	});

	it("layout-fill-without-parent — parent is not an Auto Layout frame", () => {
		const ir = docOf([
			{
				...createRect({ id: "r1", bounds: box }),
				layoutItem: { widthSizing: "fill" },
			} as CanvasNode,
		]);
		const issues = validateLayoutInvariants(ir);
		expect(issues).toContainEqual(
			expect.objectContaining({
				code: "layout-fill-without-parent",
				nodeId: "r1",
				axis: "horizontal",
				severity: "warning",
				fallback: "fixed-size",
			}),
		);
	});

	it("layout-fill-without-parent — an Absolute child cannot Fill", () => {
		const ir = docOf([
			frameWith("f1", [
				{
					...createRect({ id: "r1", bounds: box }),
					layoutItem: { positioning: "absolute", heightSizing: "fill" },
				} as CanvasNode,
			]),
		]);
		expect(
			validateLayoutInvariants(ir).find(
				(i) => i.code === "layout-fill-without-parent",
			)?.axis,
		).toBe("vertical");
	});

	it("layout-fill-without-parent — a `text` node cannot Fill its inline axis", () => {
		const ir = docOf([
			frameWith("f1", [
				{
					...createText({ id: "t1", text: "hi", bounds: box }),
					layoutItem: { widthSizing: "fill" },
				} as CanvasNode,
			]),
		]);
		const issue = validateLayoutInvariants(ir).find(
			(i) => i.code === "layout-fill-without-parent",
		);
		expect(issue?.nodeId).toBe("t1");
		expect(issue?.message).toContain("does not wrap");
	});

	it("...but a `text` node MAY Fill its block (vertical) axis", () => {
		const ir = docOf([
			frameWith("f1", [
				{
					...createText({ id: "t1", text: "hi", bounds: box }),
					layoutItem: { heightSizing: "fill" },
				} as CanvasNode,
			]),
		]);
		expect(codesOf(ir)).not.toContain("layout-fill-without-parent");
	});

	it("layout-hug-unsupported — a shape has no intrinsic size", () => {
		const ir = docOf([
			frameWith("f1", [
				{
					...createRect({ id: "r1", bounds: box }),
					layoutItem: { widthSizing: "hug" },
				} as CanvasNode,
			]),
		]);
		expect(codesOf(ir)).toContain("layout-hug-unsupported");
	});

	it("layout-hug-unsupported — a placeholder-rendering frame", () => {
		const ir = docOf([
			frameWith("outer", [
				{
					...createFrame({ id: "ph", bounds: box }),
					placeholder: { kind: "image" },
					children: [],
					layoutItem: { heightSizing: "hug" },
				} as unknown as CanvasNode,
			]),
		]);
		const issue = validateLayoutInvariants(ir).find(
			(i) => i.code === "layout-hug-unsupported",
		);
		expect(issue?.nodeId).toBe("ph");
		expect(issue?.message).toContain("placeholder");
	});

	it("layout-circular-sizing (TS-12) — parent Hugs the axis its child Fills", () => {
		const ir = docOf([
			frameWith("outer", [], {
				layoutItem: { widthSizing: "hug" },
				children: [
					{
						...createRect({ id: "r1", bounds: box }),
						layoutItem: { widthSizing: "fill" },
					} as CanvasNode,
				],
			}),
		]);
		expect(validateLayoutInvariants(ir)).toContainEqual(
			expect.objectContaining({
				code: "layout-circular-sizing",
				nodeId: "r1",
				axis: "horizontal",
				severity: "error",
				fallback: "cached-geometry",
			}),
		);
	});

	it("no cycle when the Hug and the Fill are on DIFFERENT axes", () => {
		const ir = docOf([
			frameWith("outer", [], {
				layoutItem: { widthSizing: "hug" },
				children: [
					{
						...createRect({ id: "r1", bounds: box }),
						layoutItem: { heightSizing: "fill" },
					} as CanvasNode,
				],
			}),
		]);
		expect(codesOf(ir)).not.toContain("layout-circular-sizing");
	});

	it("layout-capability-unsupported — an unknown declared capability", () => {
		const ir = docOf([], {
			compatibility: {
				schemaVersion: "3",
				minReaderSchemaVersion: "3",
				requiredCapabilities: ["test.future.v9"],
			},
		});
		expect(validateLayoutInvariants(ir)).toContainEqual(
			expect.objectContaining({
				code: "layout-capability-unsupported",
				severity: "error",
				fallback: "cached-geometry",
			}),
		);
	});

	it("does NOT flag a capability this build implements", () => {
		const ir = docOf([], {
			compatibility: {
				schemaVersion: "3",
				minReaderSchemaVersion: "3",
				requiredCapabilities: [CANVAS_LAYOUT_AUTO_CAPABILITY],
			},
		});
		expect(codesOf(ir)).not.toContain("layout-capability-unsupported");
	});

	it("layout-depth-exceeded — reported, never thrown", () => {
		// MAX_TREE_DEPTH is 64; nest well past it. Built by assembling the page
		// literally rather than via `insertNode`, which REFUSES to create a tree
		// this deep — the document under test here is a corrupt/hostile one that
		// arrived from disk or a peer, not one this build could have authored.
		let node: CanvasNode = createRect({ id: "leaf", bounds: box });
		for (let i = 0; i < 70; i++) {
			node = { ...createGroup({ id: `g${i}`, bounds: box }), children: [node] };
		}
		const page = createPage({ id: "p1" });
		const ir: CanvasIR = {
			...createCanvasIR({ id: "doc", title: "t", pages: [page] }),
			pages: [{ ...page, root: { ...page.root, children: [node] } }],
		};

		let issues: ReturnType<typeof validateLayoutInvariants> = [];
		expect(() => {
			issues = validateLayoutInvariants(ir);
		}).not.toThrow();
		expect(issues.map((i) => i.code)).toContain("layout-depth-exceeded");
	});
});

describe("codes deferred to the M2 resolver (T-M2-06)", () => {
	it("are declared in the table but never emitted by the static validator", () => {
		// Documented, not accidental: these three need resolved extents, the
		// measurement port, or the engine's inputHash respectively.
		const deferred: CanvasLayoutIssueCode[] = [
			"layout-insufficient-space",
			"layout-measurement-missing",
			"layout-materialization-stale",
		];
		for (const code of deferred) {
			expect(CANVAS_LAYOUT_ISSUE_DEFAULTS[code]).toBeDefined();
		}
		const emitted = new Set(
			codesOf(
				docOf([
					frameWith("f1", [
						{
							...createRect({ id: "r1", bounds: box }),
							layoutItem: { widthSizing: "fill" },
						} as CanvasNode,
					]),
				]),
			),
		);
		for (const code of deferred) expect(emitted.has(code)).toBe(false);
	});
});

describe("semantic rules that must NOT fire", () => {
	it("a layout-free document produces no issues", () => {
		expect(
			validateLayoutInvariants(docOf([createRect({ id: "r1", bounds: box })])),
		).toEqual([]);
	});

	it("hidden children still participate in layout validation", () => {
		// Visibility is a paint property, not a layout property (TD §6.2), so a
		// hidden child's invalid intent must still be reported.
		const ir = docOf([
			{
				...createRect({ id: "r1", bounds: box }),
				visible: false,
				layoutItem: { widthSizing: "fill" },
			} as CanvasNode,
		]);
		expect(codesOf(ir)).toContain("layout-fill-without-parent");
	});

	it("`autoLayout` on a non-frame kind is inert, not an issue", () => {
		// Enforced structurally by the schema (autoLayout lives only on
		// CanvasFrameNodeShape). TD §14's union has no member for "intent on the
		// wrong kind", and inventing one would create a parallel taxonomy.
		const ir = docOf([
			{
				...createRect({ id: "r1", bounds: box }),
				autoLayout: layout,
			} as unknown as CanvasNode,
		]);
		expect(validateLayoutInvariants(ir)).toEqual([]);
	});

	it("an all-default layoutItem produces no issues", () => {
		const ir = docOf([
			{
				...createRect({ id: "r1", bounds: box }),
				layoutItem: {},
			} as CanvasNode,
		]);
		expect(validateLayoutInvariants(ir)).toEqual([]);
	});
});

describe("diagnostic ordering (TD §14, AC-008 determinism)", () => {
	it("sorts document-scoped issues before node-scoped ones", () => {
		const ir = docOf(
			[
				{
					...createRect({ id: "r1", bounds: box }),
					layoutItem: { widthSizing: "fill" },
				} as CanvasNode,
			],
			{
				compatibility: {
					schemaVersion: "3",
					minReaderSchemaVersion: "3",
					requiredCapabilities: ["test.future.v9"],
				},
			},
		);
		const issues = validateLayoutInvariants(ir);
		expect(issues[0]?.code).toBe("layout-capability-unsupported");
		expect(issues[0]?.nodeId).toBeUndefined();
	});

	it("sorts by tree order, then axis (unscoped < horizontal < vertical)", () => {
		const ir = docOf([
			frameWith("f1", [
				{
					...createRect({ id: "a", bounds: box }),
					// Both axes invalid — must come back horizontal-then-vertical.
					layoutItem: { widthSizing: "hug", heightSizing: "hug" },
				} as CanvasNode,
				{
					...createRect({ id: "b", bounds: box }),
					layoutItem: { widthSizing: "hug" },
				} as CanvasNode,
			]),
		]);
		const issues = validateLayoutInvariants(ir);
		expect(issues.map((i) => [i.nodeId, i.axis])).toEqual([
			["a", "horizontal"],
			["a", "vertical"],
			["b", "horizontal"],
		]);
	});

	it("is byte-stable across repeated runs on the same document", () => {
		const ir = docOf([
			frameWith("f1", [
				{
					...createRect({ id: "z", bounds: box }),
					layoutItem: { widthSizing: "hug", heightSizing: "fill" },
				} as CanvasNode,
				{
					...createText({ id: "a", text: "x", bounds: box }),
					layoutItem: { widthSizing: "fill" },
				} as CanvasNode,
			]),
		]);
		const first = JSON.stringify(validateLayoutInvariants(ir));
		for (let i = 0; i < 5; i++) {
			expect(JSON.stringify(validateLayoutInvariants(ir))).toBe(first);
		}
	});
});

describe("assertLayoutInvariants", () => {
	it("does not throw for a clean document", () => {
		expect(() =>
			assertLayoutInvariants(docOf([createRect({ id: "r1", bounds: box })])),
		).not.toThrow();
	});

	it("does not throw for warnings alone — they describe a deterministic fallback", () => {
		const ir = docOf([
			{
				...createRect({ id: "r1", bounds: box }),
				layoutItem: { widthSizing: "fill" },
			} as CanvasNode,
		]);
		expect(
			validateLayoutInvariants(ir).every((i) => i.severity === "warning"),
		).toBe(true);
		expect(() => assertLayoutInvariants(ir)).not.toThrow();
	});

	it("throws CanvasLayoutInvariantError carrying only the errors", () => {
		const ir = docOf([
			frameWith("f1", [], { autoLayout: { ...layout, gap: -1 } }),
		]);
		try {
			assertLayoutInvariants(ir);
			expect.unreachable("assertLayoutInvariants must throw");
		} catch (err) {
			expect(err).toBeInstanceOf(CanvasLayoutInvariantError);
			const issues = (err as CanvasLayoutInvariantError).issues;
			expect(issues.every((i) => i.severity === "error")).toBe(true);
			expect(issues.map((i) => i.code)).toContain("layout-negative-gap");
		}
	});
});
