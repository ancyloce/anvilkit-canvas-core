import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { applyCommand } from "../../commands/runtime.js";
import {
	createCanvasIR,
	createFrame,
	createPage,
	createRect,
} from "../../ir/builders.js";
import { insertNode } from "../../ir/mutations.js";
import type { CanvasIR, CanvasNode } from "../../ir/types.js";
import { CanvasIRSchema } from "../../ir/validators.js";
import { resizeToVariants } from "../../templates/resize-to-variants.js";
import {
	flattenCanvasLayout,
	materializeCanvasLayout,
} from "../materialize.js";
import { resolveCanvasLayout } from "../resolve.js";
import { toResolvedNodeId } from "../types.js";

/**
 * @file T-M2-08 — materialization and flatten (TS-19, TS-20).
 */

const box = { width: 40, height: 20 };

const layout = {
	version: 1,
	direction: "horizontal",
	padding: { top: 5, right: 5, bottom: 5, left: 5 },
	gap: 10,
	primaryAlign: "start",
	crossAlign: "start",
} as const;

function build(): CanvasIR {
	const page = createPage({ id: "p1" });
	let ir = createCanvasIR({ id: "doc", title: "t", pages: [page] });
	ir = insertNode(ir, {
		parentId: page.root.id,
		node: {
			...createFrame({ id: "f1", bounds: { width: 200, height: 100 } }),
			autoLayout: layout,
			children: [
				createRect({ id: "a", bounds: box }),
				{
					...createRect({ id: "b", bounds: box }),
					layoutItem: { widthSizing: "fill" },
				} as CanvasNode,
			],
		} as CanvasNode,
	});
	return {
		...ir,
		compatibility: {
			schemaVersion: "3",
			minReaderSchemaVersion: "3",
			requiredCapabilities: ["layout.auto.v1"],
		},
	};
}

function findNode(ir: CanvasIR, id: string): CanvasNode {
	const search = (node: CanvasNode): CanvasNode | undefined => {
		if (node.id === id) return node;
		for (const child of (node as { children?: CanvasNode[] }).children ?? []) {
			const hit = search(child);
			if (hit) return hit;
		}
		return undefined;
	};
	const found = search(ir.pages[0]?.root as CanvasNode);
	if (!found) throw new Error(`fixture is missing "${id}"`);
	return found;
}

describe("materializeCanvasLayout", () => {
	it("writes resolved geometry into the document and stamps it", () => {
		const ir = build();
		const resolved = resolveCanvasLayout(ir, {});
		const materialized = materializeCanvasLayout(ir, resolved, { revision: 7 });

		const b = findNode(materialized, "b");
		const record = resolved.records.get(toResolvedNodeId("b"));
		expect(b.transform).toEqual(record?.geometry.localTransform);
		expect(b.bounds).toEqual(record?.geometry.bounds);
		expect(materialized.layoutMaterialization?.engineVersion).toBe(1);
		expect(materialized.layoutMaterialization?.resolvedAtRevision).toBe(7);
		// The stamp hashes the document it is ATTACHED TO, not the one that was
		// resolved. Materialization rewrites `pages`, and the input hash covers
		// `pages` — stamping the pre-write hash would produce a stamp that never
		// matches its own document, so `layout-materialization-stale` would fire
		// immediately on a cache that is in fact perfectly fresh.
		expect(materialized.layoutMaterialization?.inputHash).not.toBe(
			resolved.inputHash,
		);
		expect(resolveCanvasLayout(materialized, {}).inputHash).toBe(
			materialized.layoutMaterialization?.inputHash,
		);
	});

	it("keeps the intent — materialize is a cache, not a conversion", () => {
		const materialized = materializeCanvasLayout(
			build(),
			resolveCanvasLayout(build(), {}),
		);
		expect(
			(findNode(materialized, "f1") as { autoLayout?: unknown }).autoLayout,
		).toBeDefined();
		expect(findNode(materialized, "b").layoutItem).toEqual({
			widthSizing: "fill",
		});
	});

	it("produces a document that still parses", () => {
		const ir = build();
		const materialized = materializeCanvasLayout(
			ir,
			resolveCanvasLayout(ir, {}),
		);
		expect(() => CanvasIRSchema.parse(materialized)).not.toThrow();
	});

	it("leaves pages outside the resolution untouched", () => {
		const ir = build();
		const withSecond: CanvasIR = {
			...ir,
			pages: [...ir.pages, createPage({ id: "p2" })],
		};
		const partial = resolveCanvasLayout(withSecond, { pageIds: ["p1"] });
		const materialized = materializeCanvasLayout(withSecond, partial);

		expect(materialized.pages[1]).toBe(withSecond.pages[1]);
	});
});

describe("stamp invalidation (TS-19)", () => {
	it("emits layout-materialization-stale when the intent changed", () => {
		const ir = build();
		const materialized = materializeCanvasLayout(
			ir,
			resolveCanvasLayout(ir, {}),
		);
		// Change the layout intent, keeping the now-stale stamp.
		const edited: CanvasIR = {
			...materialized,
			pages: materialized.pages.map((page) => ({
				...page,
				root: {
					...page.root,
					children: page.root.children.map((child) =>
						child.id === "f1"
							? ({
									...child,
									autoLayout: { ...layout, gap: 40 },
								} as CanvasNode)
							: child,
					),
				},
			})),
		};

		expect(
			resolveCanvasLayout(edited, {}).diagnostics.map((d) => d.code),
		).toContain("layout-materialization-stale");
	});

	it("does NOT emit it for a stamp that still matches", () => {
		const ir = build();
		const materialized = materializeCanvasLayout(
			ir,
			resolveCanvasLayout(ir, {}),
		);
		expect(
			resolveCanvasLayout(materialized, {}).diagnostics.map((d) => d.code),
		).not.toContain("layout-materialization-stale");
	});

	it("does not emit it for a document that was never materialized", () => {
		expect(
			resolveCanvasLayout(build(), {}).diagnostics.map((d) => d.code),
		).not.toContain("layout-materialization-stale");
	});
});

describe("the stamp is cleared on every content copy (TS-20)", () => {
	function stamped(): CanvasIR {
		const ir = build();
		return materializeCanvasLayout(ir, resolveCanvasLayout(ir, {}));
	}

	it("clears it on page.duplicate", () => {
		const result = applyCommand(stamped(), {
			type: "page.duplicate",
			sourcePageId: "p1",
			newPageId: "p2",
		});
		expect("layoutMaterialization" in result.ir).toBe(false);
	});

	it("clears it when resizeToVariants' pages are applied", () => {
		// `resizeToVariants` returns pages plus a `page.create` batch; applying
		// that batch is what puts them in the document, and it changes page
		// dimensions, so any Fill child resolves differently.
		const { command } = resizeToVariants(stamped(), "p1", [
			{
				id: "sq",
				label: "Square",
				width: 400,
				height: 400,
				unit: "px",
				version: "1",
			},
		]);
		const result = applyCommand(stamped(), command);
		expect("layoutMaterialization" in result.ir).toBe(false);
	});

	it("clears it on an ordinary command too", () => {
		// Cleared in `bumpMetadata`, which every command routes through, rather
		// than at the two sites the plan enumerates: every command changes the
		// inputs a resolution depended on, so a surviving stamp would always be
		// a lie, and a stamp that lies is worse than no stamp.
		const result = applyCommand(stamped(), {
			type: "node.update",
			nodeId: "a",
			kind: "rect",
			patch: { bounds: { width: 99, height: 20 } },
		});
		expect("layoutMaterialization" in result.ir).toBe(false);
	});

	it("is physically absent, not set to undefined", () => {
		// A consumer testing `"layoutMaterialization" in ir` must see it gone;
		// an explicit `undefined` would still report present.
		const result = applyCommand(stamped(), {
			type: "page.duplicate",
			sourcePageId: "p1",
			newPageId: "p2",
		});
		expect(Object.keys(result.ir)).not.toContain("layoutMaterialization");
	});
});

describe("flattenCanvasLayout", () => {
	it("removes all intent while keeping the resolved geometry", () => {
		const ir = build();
		const resolved = resolveCanvasLayout(ir, {});
		const flat = flattenCanvasLayout(ir, { resolved });

		expect("autoLayout" in findNode(flat, "f1")).toBe(false);
		expect("layoutItem" in findNode(flat, "b")).toBe(false);
		expect(findNode(flat, "b").transform).toEqual(
			resolved.records.get(toResolvedNodeId("b"))?.geometry.localTransform,
		);
		expect(findNode(flat, "b").bounds).toEqual(
			resolved.records.get(toResolvedNodeId("b"))?.geometry.bounds,
		);
	});

	it("renders identically — re-resolving the flat document is a no-op", () => {
		// The acceptance criterion. If flatten wrote geometry the resolver would
		// then move, the flattened document would not be a faithful snapshot.
		const ir = build();
		const before = resolveCanvasLayout(ir, {});
		const flat = flattenCanvasLayout(ir, { resolved: before });
		const after = resolveCanvasLayout(flat, {});

		for (const [id, record] of before.records) {
			expect(
				after.records.get(id)?.geometry.bounds,
				record.sourceNodeId,
			).toEqual(record.geometry.bounds);
			expect(
				after.records.get(id)?.geometry.worldTransform,
				record.sourceNodeId,
			).toEqual(record.geometry.worldTransform);
		}
	});

	it("drops the layout capability so an older reader can open the result", () => {
		const flat = flattenCanvasLayout(build(), {});
		expect(flat.compatibility?.requiredCapabilities).toEqual([]);
	});

	it("keeps other capabilities and honours clearCapability:false", () => {
		const ir = build();
		const withExtra: CanvasIR = {
			...ir,
			compatibility: {
				schemaVersion: "3",
				minReaderSchemaVersion: "3",
				requiredCapabilities: ["layout.auto.v1", "test.future.v9"],
			},
		};
		expect(
			flattenCanvasLayout(withExtra, {}).compatibility?.requiredCapabilities,
		).toEqual(["test.future.v9"]);
		expect(
			flattenCanvasLayout(withExtra, { clearCapability: false }).compatibility
				?.requiredCapabilities,
		).toEqual(["layout.auto.v1", "test.future.v9"]);
	});

	it("leaves no stamp — there is nothing left to be stale about", () => {
		const ir = build();
		const stamped = materializeCanvasLayout(ir, resolveCanvasLayout(ir, {}));
		expect("layoutMaterialization" in flattenCanvasLayout(stamped, {})).toBe(
			false,
		);
	});

	it("resolves internally when no resolution is supplied", () => {
		const flat = flattenCanvasLayout(build(), {});
		expect("autoLayout" in findNode(flat, "f1")).toBe(false);
		expect(() => CanvasIRSchema.parse(flat)).not.toThrow();
	});

	it("does not mutate the input document", () => {
		const ir = build();
		flattenCanvasLayout(ir, {});
		expect(
			(findNode(ir, "f1") as { autoLayout?: unknown }).autoLayout,
		).toBeDefined();
	});
});

describe("layering DoD", () => {
	it("templates/ and commands/ gain no import of layout/", () => {
		// `templates/` is rank 4, a sibling of `layout/`; `commands/` is rank 3,
		// below it. Neither may import it, which is why clearing the stamp is a
		// field deletion rather than a resolver call. `check:layering` would
		// catch the rank-3 case; the same-rank sibling case is why this test
		// exists as well.
		for (const dir of ["templates", "commands"] as const) {
			const base = fileURLToPath(new URL(`../../${dir}/`, import.meta.url));
			for (const file of readdirSync(base).filter((f) => f.endsWith(".ts"))) {
				const source = readFileSync(`${base}${file}`, "utf8");
				expect(
					/from "\.\.\/layout\//.test(source),
					`${dir}/${file} imports layout/`,
				).toBe(false);
			}
		}
	});
});
