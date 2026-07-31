import { describe, expect, it } from "vitest";

import { snapshotKey } from "../../ir/snapshot-key.js";
import type {
	CanvasExternalComponentRef,
	CanvasExternalComponentSnapshot,
	CanvasNode,
} from "../../ir/types.js";
import {
	MAX_COMPONENT_EXPANDED_NODES_PER_RESOLUTION,
	MAX_EXTERNAL_DEPENDENCIES_PER_COMPONENT,
	MAX_EXTERNAL_DEPENDENCY_DEPTH,
} from "../../limits.js";
import { validateExternalClosure } from "../dependencies.js";

/**
 * T-017 — external dependency closure.
 *
 * Two halves, deliberately separable: the STRUCTURAL checks need no registry and
 * therefore always run at admission, while "is the closure present" needs a
 * document and only runs when a resolver is supplied. Both are exercised here.
 */

function ref(
	componentId: string,
	version = "1.0.0",
): CanvasExternalComponentRef {
	return {
		kind: "library",
		libraryId: "acme",
		componentId,
		version,
		integrity: `sha256-${componentId.padEnd(43, "x").slice(0, 43)}`,
	};
}

function instanceNode(
	id: string,
	source: CanvasExternalComponentRef | { kind: "local"; componentId: string },
): CanvasNode {
	return {
		id,
		type: "component-instance",
		transform: { x: 0, y: 0, rotation: 0, scaleX: 1, scaleY: 1 },
		bounds: { width: 10, height: 10 },
		zIndex: 0,
		source,
	} as CanvasNode;
}

function snapshot(
	self: CanvasExternalComponentRef,
	options: {
		dependencies?: readonly CanvasExternalComponentRef[];
		children?: readonly CanvasNode[];
		extraNodes?: number;
	} = {},
): CanvasExternalComponentSnapshot {
	const filler: CanvasNode[] = [];
	for (let i = 0; i < (options.extraNodes ?? 0); i += 1) {
		filler.push({
			id: `${self.componentId}-n${i}`,
			type: "rect",
			transform: { x: 0, y: 0, rotation: 0, scaleX: 1, scaleY: 1 },
			bounds: { width: 1, height: 1 },
			zIndex: 0,
		} as CanvasNode);
	}
	return {
		ref: self,
		definition: {
			id: self.componentId,
			name: self.componentId,
			revision: 1,
			root: {
				id: `${self.componentId}-root`,
				type: "frame",
				transform: { x: 0, y: 0, rotation: 0, scaleX: 1, scaleY: 1 },
				bounds: { width: 10, height: 10 },
				zIndex: 0,
				children: [...(options.children ?? []), ...filler],
			},
			properties: [],
		},
		dependencies: options.dependencies ?? [],
		canonicalFormatVersion: 1,
	} as CanvasExternalComponentSnapshot;
}

function resolverOf(...snapshots: CanvasExternalComponentSnapshot[]) {
	const byKey = new Map(snapshots.map((s) => [snapshotKey(s.ref), s]));
	return {
		get: (r: CanvasExternalComponentRef) => byKey.get(snapshotKey(r)),
	};
}

describe("closure completeness (T-017 acceptance)", () => {
	it("accepts a complete closure", () => {
		const inner = snapshot(ref("inner"));
		const outer = snapshot(ref("outer"), {
			dependencies: [ref("inner")],
			children: [instanceNode("i1", ref("inner"))],
		});
		expect(validateExternalClosure(outer, resolverOf(inner))).toBeNull();
	});

	it("REJECTS a closure missing one snapshot — commits nothing", () => {
		const outer = snapshot(ref("outer"), {
			dependencies: [ref("inner")],
			children: [instanceNode("i1", ref("inner"))],
		});
		const problem = validateExternalClosure(outer, resolverOf());
		expect(problem?.code).toBe("component-dependency-missing");
		expect(problem?.message).toContain("acme/inner@1.0.0");
	});

	it("accepts dependencies supplied as PENDING in the same transaction", () => {
		// Inserting a component together with its dependencies must be possible;
		// without this the legal multi-snapshot insert looks like a partial closure.
		const inner = snapshot(ref("inner"));
		const outer = snapshot(ref("outer"), {
			dependencies: [ref("inner")],
			children: [instanceNode("i1", ref("inner"))],
		});
		expect(
			validateExternalClosure(outer, resolverOf(), { pending: [inner] }),
		).toBeNull();
	});

	it("treats a DIFFERENT version of a dependency as missing", () => {
		const other = snapshot(ref("inner", "2.0.0"));
		const outer = snapshot(ref("outer"), {
			dependencies: [ref("inner", "1.0.0")],
			children: [instanceNode("i1", ref("inner", "1.0.0"))],
		});
		expect(validateExternalClosure(outer, resolverOf(other))?.code).toBe(
			"component-dependency-missing",
		);
	});

	it("skips the presence check when no registry context exists", () => {
		// At the admission boundary there is no document to be absent from, so
		// "not present" is not a finding — but the structural checks still ran.
		const outer = snapshot(ref("outer"), {
			dependencies: [ref("inner")],
			children: [instanceNode("i1", ref("inner"))],
		});
		expect(validateExternalClosure(outer, undefined)).toBeNull();
	});
});

describe("structural rules (run with or without a registry)", () => {
	it("rejects an undeclared reference found in the tree", () => {
		// Declared nothing, but the tree instantiates something: nobody would ever
		// fetch it, and it would render as a hole.
		const outer = snapshot(ref("outer"), {
			children: [instanceNode("i1", ref("inner"))],
		});
		const problem = validateExternalClosure(outer, undefined);
		expect(problem?.code).toBe("component-dependency-missing");
		expect(problem?.message).toContain("does not declare");
	});

	it("rejects an external component that references a LOCAL component", () => {
		// Its meaning would change per document — the opposite of what an
		// integrity-pinned snapshot is for.
		const outer = snapshot(ref("outer"), {
			children: [instanceNode("i1", { kind: "local", componentId: "cmp-a" })],
		});
		const problem = validateExternalClosure(outer, undefined);
		expect(problem?.code).toBe("component-snapshot-invalid");
		expect(problem?.message).toContain("local component");
	});

	it("detects a direct self-dependency cycle", () => {
		const self = ref("loop");
		const looping = snapshot(self, {
			dependencies: [self],
			children: [instanceNode("i1", self)],
		});
		const problem = validateExternalClosure(looping, resolverOf(looping));
		expect(problem?.code).toBe("component-dependency-missing");
		expect(problem?.message).toContain("cycle");
	});

	it("detects an indirect cycle (a → b → a)", () => {
		const a = snapshot(ref("a"), {
			dependencies: [ref("b")],
			children: [instanceNode("ia", ref("b"))],
		});
		const b = snapshot(ref("b"), {
			dependencies: [ref("a")],
			children: [instanceNode("ib", ref("a"))],
		});
		const problem = validateExternalClosure(a, resolverOf(a, b));
		expect(problem?.code).toBe("component-dependency-missing");
		expect(problem?.message).toContain("cycle");
	});

	it("allows a DIAMOND, which is not a cycle", () => {
		// a → b, a → c, b → d, c → d. `d` is reached twice legitimately; a naive
		// visited-set-as-cycle-check would call this a cycle.
		const d = snapshot(ref("d"));
		const b = snapshot(ref("b"), {
			dependencies: [ref("d")],
			children: [instanceNode("ib", ref("d"))],
		});
		const c = snapshot(ref("c"), {
			dependencies: [ref("d")],
			children: [instanceNode("ic", ref("d"))],
		});
		const a = snapshot(ref("a"), {
			dependencies: [ref("b"), ref("c")],
			children: [instanceNode("ia1", ref("b")), instanceNode("ia2", ref("c"))],
		});
		expect(validateExternalClosure(a, resolverOf(b, c, d))).toBeNull();
	});

	it("rejects a chain deeper than the cap (dependency bomb, depth axis)", () => {
		const depth = MAX_EXTERNAL_DEPENDENCY_DEPTH + 2;
		const all: CanvasExternalComponentSnapshot[] = [];
		for (let i = 0; i < depth; i += 1) {
			const next = i + 1 < depth ? ref(`c${i + 1}`) : undefined;
			all.push(
				snapshot(ref(`c${i}`), {
					...(next
						? {
								dependencies: [next],
								children: [instanceNode(`i${i}`, next)],
							}
						: {}),
				}),
			);
		}
		const problem = validateExternalClosure(
			all[0] as CanvasExternalComponentSnapshot,
			resolverOf(...all),
		);
		expect(problem?.code).toBe("component-dependency-missing");
		expect(problem?.message).toContain("deep");
	});

	it("rejects excessive direct fan-out (dependency bomb, breadth axis)", () => {
		const deps = Array.from(
			{ length: MAX_EXTERNAL_DEPENDENCIES_PER_COMPONENT + 1 },
			(_, i) => ref(`dep-${i}`),
		);
		const outer = snapshot(ref("outer"), {
			dependencies: deps,
			children: deps.map((d, i) => instanceNode(`i${i}`, d)),
		});
		const problem = validateExternalClosure(outer, undefined);
		expect(problem?.code).toBe("component-snapshot-invalid");
		expect(problem?.message).toContain("direct dependencies");
	});

	it("rejects a closure that expands past the node budget (product axis)", () => {
		// Neither depth nor fan-out is exceeded; only the PRODUCT is — which is
		// exactly why the cap is checked after expansion rather than on the
		// declared list.
		const big = MAX_COMPONENT_EXPANDED_NODES_PER_RESOLUTION;
		const inner = snapshot(ref("inner"), { extraNodes: big });
		const outer = snapshot(ref("outer"), {
			dependencies: [ref("inner")],
			children: [instanceNode("i1", ref("inner"))],
			extraNodes: 10,
		});
		const problem = validateExternalClosure(outer, resolverOf(inner));
		expect(problem?.code).toBe("component-snapshot-invalid");
		expect(problem?.message).toContain("nodes");
	});

	it("accepts a closure that is large but within budget", () => {
		const inner = snapshot(ref("inner"), { extraNodes: 10 });
		const outer = snapshot(ref("outer"), {
			dependencies: [ref("inner")],
			children: [instanceNode("i1", ref("inner"))],
			extraNodes: 10,
		});
		expect(validateExternalClosure(outer, resolverOf(inner))).toBeNull();
	});

	it("never throws on a malformed dependency reference", () => {
		const outer = snapshot(ref("outer"), {
			dependencies: [{ ...ref("inner"), libraryId: "" }],
		});
		expect(() => validateExternalClosure(outer, undefined)).not.toThrow();
		expect(validateExternalClosure(outer, undefined)?.code).toBe(
			"component-snapshot-invalid",
		);
	});
});
