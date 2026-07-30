import { describe, expect, it } from "vitest";
import {
	createCanvasIR,
	createComponentInstance,
	createFrame,
	createPage,
	createRect,
	createText,
} from "../../ir/builders.js";
import { insertNode } from "../../ir/mutations.js";
import type {
	CanvasComponentDefinition,
	CanvasComponentOverrideMap,
	CanvasIR,
	CanvasNode,
} from "../../ir/types.js";
import { CanvasIRSchema } from "../../ir/validators.js";
import { resolveCanvasDocument } from "../../layout/resolve-document.js";
import { toResolvedNodeId } from "../../layout/types.js";
import {
	MAX_COMPONENT_DEFINITIONS_PER_DOCUMENT,
	MAX_COMPONENT_NESTED_DEPTH,
	MAX_COMPONENT_OVERRIDES_PER_INSTANCE,
	MAX_COMPONENT_PROPERTIES_PER_COMPONENT,
	MAX_COMPONENT_RICH_PARAGRAPHS_PER_OVERRIDE,
	MAX_COMPONENT_SOURCE_NODES_PER_DEFINITION,
	MAX_COMPONENT_TEXT_OVERRIDE_CHARS,
} from "../../limits.js";
import { validateComponentGraph } from "../validate.js";

/**
 * @file M6-05 security + hostile-input suite (NFR-003, T-SEC-1, T-SEC-2).
 *
 * Every case here models a document the editor did NOT author: imported,
 * pasted, decoded from a peer, or hand-edited. The contract under test is
 * NFR-002/003's pair — **no crash, no unbounded work** — plus the one that is
 * easy to get wrong: `z.looseObject` PRESERVES unknown keys, so rejecting a
 * hostile key is an explicit normalization step, never something the schema
 * gives away for free.
 */

const NOW = () => "2026-07-29T00:00:00.000Z";

function definition(
	overrides: Partial<CanvasComponentDefinition> = {},
): CanvasComponentDefinition {
	return {
		id: "cmp-a",
		name: "A",
		revision: 1,
		properties: [],
		root: {
			...createFrame({ id: "src-root", bounds: { width: 40, height: 20 } }),
			children: [
				createRect({ id: "src-r", bounds: { width: 10, height: 10 } }),
			],
		} as CanvasNode,
		...overrides,
	};
}

function docWith(
	registry: Record<string, CanvasComponentDefinition>,
	instances: readonly CanvasNode[] = [],
): CanvasIR {
	const page = createPage({ id: "p1" });
	let ir = createCanvasIR({ id: "doc", title: "t", pages: [page], now: NOW });
	for (const node of instances) {
		ir = insertNode(ir, { parentId: page.root.id, node, now: NOW });
	}
	return { ...ir, components: registry };
}

const instance = (
	id: string,
	componentId: string,
	overrides?: CanvasComponentOverrideMap,
): CanvasNode =>
	createComponentInstance({
		id,
		componentId,
		bounds: { width: 40, height: 20 },
		...(overrides ? { overrides } : {}),
	});

// --- T-SEC-1: prototype pollution -------------------------------------------

describe("T-SEC-1 — prototype pollution", () => {
	it("a `__proto__` Registry key never reaches Object.prototype", () => {
		// Built with defineProperty so the key is a real OWN property rather than
		// a prototype write at construction time — which is exactly how a parsed
		// JSON payload arrives.
		const registry: Record<string, CanvasComponentDefinition> = {};
		Object.defineProperty(registry, "__proto__", {
			value: definition({ id: "__proto__" }),
			enumerable: true,
			configurable: true,
			writable: true,
		});
		const ir = docWith(registry, [instance("inst-1", "__proto__")]);

		expect(() => resolveCanvasDocument(ir, {})).not.toThrow();
		// The canary: nothing leaked onto the prototype chain.
		expect(
			({} as Record<string, unknown>).polluted,
			"Object.prototype was polluted",
		).toBeUndefined();
		expect(Object.prototype).not.toHaveProperty("id");
	});

	it("a hostile override key is retained verbatim but never applied", () => {
		const overrides = JSON.parse(
			'{"__proto__":{"kind":"text","value":{"kind":"plain","text":"pwn"}},"constructor":{"kind":"visibility","visible":false}}',
		) as CanvasComponentOverrideMap;
		const ir = docWith({ "cmp-a": definition() }, [
			instance("inst-1", "cmp-a", overrides),
		]);

		const resolved = resolveCanvasDocument(ir, {});
		// No property with those ids exists, so both are orphans: retained on the
		// instance, applied nowhere (INV-6).
		expect(
			resolved.records.get(toResolvedNodeId("inst-1"))?.node.type,
		).not.toBe("component-instance");
		expect(({} as Record<string, unknown>).kind).toBeUndefined();
		expect(Object.prototype).not.toHaveProperty("visible");
	});

	it("a `__proto__`-named PROPERTY id resolves against its own definition only", () => {
		const def = definition({
			properties: [
				{
					id: "__proto__",
					name: "Hostile",
					nodeId: "src-r",
					kind: "visibility",
				},
			],
		});
		const overrides = JSON.parse(
			'{"__proto__":{"kind":"visibility","visible":false}}',
		) as CanvasComponentOverrideMap;
		const ir = docWith({ "cmp-a": def }, [
			instance("inst-1", "cmp-a", overrides),
		]);
		// `findComponentProperty` scans the definition's ARRAY, so a prototype-shaped
		// id is looked up by value, never by property access on a bare object.
		expect(() => resolveCanvasDocument(ir, {})).not.toThrow();
		expect(Object.prototype).not.toHaveProperty("visible");
	});
});

// --- T-SEC-2: cap boundaries -------------------------------------------------

describe("T-SEC-2 — cap boundaries reject at the schema", () => {
	/** Parse a document and report whether the schema accepted it. */
	const accepts = (ir: CanvasIR): boolean =>
		CanvasIRSchema.safeParse(ir).success;

	it("accepts a Registry AT the definition cap and rejects one past it", () => {
		const at: Record<string, CanvasComponentDefinition> = {};
		for (let i = 0; i < MAX_COMPONENT_DEFINITIONS_PER_DOCUMENT; i += 1) {
			at[`cmp-${i}`] = definition({
				id: `cmp-${i}`,
				root: createFrame({
					id: `root-${i}`,
					bounds: { width: 10, height: 10 },
				}) as CanvasNode,
			});
		}
		expect(accepts(docWith(at))).toBe(true);

		const over = { ...at };
		over["cmp-extra"] = definition({
			id: "cmp-extra",
			root: createFrame({
				id: "root-extra",
				bounds: { width: 10, height: 10 },
			}) as CanvasNode,
		});
		expect(accepts(docWith(over))).toBe(false);
	});

	it("rejects a Source tree past the node cap", () => {
		const children: CanvasNode[] = [];
		for (let i = 0; i <= MAX_COMPONENT_SOURCE_NODES_PER_DEFINITION; i += 1) {
			children.push(
				createRect({ id: `n-${i}`, bounds: { width: 1, height: 1 } }),
			);
		}
		const over = definition({
			root: {
				...createFrame({ id: "src-root", bounds: { width: 10, height: 10 } }),
				children,
			} as CanvasNode,
		});
		expect(accepts(docWith({ "cmp-a": over }))).toBe(false);
	});

	it("rejects more properties than the per-component cap", () => {
		const properties = Array.from(
			{ length: MAX_COMPONENT_PROPERTIES_PER_COMPONENT + 1 },
			(_, i) => ({
				id: `p-${i}`,
				name: `P${i}`,
				nodeId: "src-r",
				kind: "visibility" as const,
			}),
		);
		expect(accepts(docWith({ "cmp-a": definition({ properties }) }))).toBe(
			false,
		);
	});

	it("rejects more overrides than the per-instance cap", () => {
		const overrides: Record<string, unknown> = {};
		for (let i = 0; i <= MAX_COMPONENT_OVERRIDES_PER_INSTANCE; i += 1) {
			overrides[`p-${i}`] = { kind: "visibility", visible: false };
		}
		expect(
			accepts(
				docWith({ "cmp-a": definition() }, [
					instance("inst-1", "cmp-a", overrides as CanvasComponentOverrideMap),
				]),
			),
		).toBe(false);
	});

	it("rejects an oversized text override, and accepts one AT the cap", () => {
		const at: CanvasComponentOverrideMap = {
			"p-x": {
				kind: "text",
				value: {
					kind: "plain",
					text: "x".repeat(MAX_COMPONENT_TEXT_OVERRIDE_CHARS),
				},
			},
		};
		const over: CanvasComponentOverrideMap = {
			"p-x": {
				kind: "text",
				value: {
					kind: "plain",
					text: "x".repeat(MAX_COMPONENT_TEXT_OVERRIDE_CHARS + 1),
				},
			},
		};
		const def = { "cmp-a": definition() };
		expect(accepts(docWith(def, [instance("i-at", "cmp-a", at)]))).toBe(true);
		expect(accepts(docWith(def, [instance("i-over", "cmp-a", over)]))).toBe(
			false,
		);
	});

	it("rejects an oversized RICH text override", () => {
		const paragraphs = Array.from(
			{ length: MAX_COMPONENT_RICH_PARAGRAPHS_PER_OVERRIDE + 1 },
			() => ({ spans: [{ text: "x" }] }),
		);
		expect(
			accepts(
				docWith({ "cmp-a": definition() }, [
					instance("inst-1", "cmp-a", {
						"p-x": {
							kind: "text",
							value: {
								kind: "rich",
								paragraphs,
							} as CanvasComponentOverrideMap[string] extends { value: infer V }
								? V
								: never,
						},
					} as CanvasComponentOverrideMap),
				]),
			),
		).toBe(false);
	});
});

// --- hostile graphs: cycles, depth, budget ----------------------------------

describe("hostile graphs bound READ-TIME work (NFR-002/003)", () => {
	/** a → b → a, the shape only an imported/hand-edited document can hold. */
	function cyclicRegistry(): Record<string, CanvasComponentDefinition> {
		const nest = (id: string, target: string): CanvasComponentDefinition =>
			definition({
				id,
				root: {
					...createFrame({
						id: `${id}-root`,
						bounds: { width: 10, height: 10 },
					}),
					children: [instance(`${id}-nested`, target)],
				} as CanvasNode,
			});
		return { "cmp-a": nest("cmp-a", "cmp-b"), "cmp-b": nest("cmp-b", "cmp-a") };
	}

	it("a cycle resolves to a bounded placeholder instead of recursing forever", () => {
		const ir = docWith(cyclicRegistry(), [instance("inst-1", "cmp-a")]);
		const resolved = resolveCanvasDocument(ir, {});
		expect(
			resolved.componentIssues.some((i) => i.code === "component-cycle"),
		).toBe(true);
		// Bounded output, and the editor still gets a record to select.
		expect(resolved.records.size).toBeLessThan(50);
	});

	it("the write-time validator reports the cycle deterministically", () => {
		const issues = validateComponentGraph(docWith(cyclicRegistry()));
		expect(issues.some((i) => i.code === "component-cycle")).toBe(true);
		// Same document, same report — a nondeterministic diagnostic would make
		// this class of document impossible to triage (INV-5).
		expect(
			JSON.stringify(validateComponentGraph(docWith(cyclicRegistry()))),
		).toBe(JSON.stringify(issues));
	});

	it("nesting past the depth cap degrades instead of exhausting the stack", () => {
		// A chain deeper than the cap: cmp-0 → cmp-1 → … each nesting the next.
		const depth = MAX_COMPONENT_NESTED_DEPTH + 5;
		const registry: Record<string, CanvasComponentDefinition> = {};
		for (let i = 0; i < depth; i += 1) {
			const next = i + 1 < depth ? `cmp-${i + 1}` : undefined;
			registry[`cmp-${i}`] = definition({
				id: `cmp-${i}`,
				root: {
					...createFrame({
						id: `root-${i}`,
						bounds: { width: 10, height: 10 },
					}),
					children: next
						? [instance(`nested-${i}`, next)]
						: [
								createRect({
									id: `leaf-${i}`,
									bounds: { width: 1, height: 1 },
								}),
							],
				} as CanvasNode,
			});
		}
		const ir = docWith(registry, [instance("inst-1", "cmp-0")]);
		let resolved: ReturnType<typeof resolveCanvasDocument> | undefined;
		expect(() => {
			resolved = resolveCanvasDocument(ir, {});
		}).not.toThrow();
		expect(
			resolved?.componentIssues.some(
				(i) => i.code === "component-depth-exceeded",
			),
		).toBe(true);
	});

	it("an expansion budget of zero degrades to a placeholder, not a partial tree", () => {
		const ir = docWith({ "cmp-a": definition() }, [
			instance("inst-1", "cmp-a"),
		]);
		const resolved = resolveCanvasDocument(ir, { maxExpandedNodes: 0 });
		expect(
			resolved.componentIssues.some(
				(i) => i.code === "component-expanded-node-limit",
			),
		).toBe(true);
		expect(resolved.records.get(toResolvedNodeId("inst-1"))?.node.type).toBe(
			"component-instance",
		);
	});
});

// --- revalidate on read ------------------------------------------------------

describe("revalidate-on-read (NFR-003)", () => {
	it("a document that PASSED write-time validation is still bounded at read time", () => {
		// Each definition is individually legal; the cycle only exists in the
		// GRAPH, which a per-definition schema pass cannot see. Read-time bounding
		// is therefore not redundant with write-time validation.
		const registry = {
			"cmp-a": definition({
				id: "cmp-a",
				root: {
					...createFrame({ id: "a-root", bounds: { width: 10, height: 10 } }),
					children: [instance("a-nested", "cmp-b")],
				} as CanvasNode,
			}),
			"cmp-b": definition({
				id: "cmp-b",
				root: {
					...createFrame({ id: "b-root", bounds: { width: 10, height: 10 } }),
					children: [instance("b-nested", "cmp-a")],
				} as CanvasNode,
			}),
		};
		const ir = docWith(registry, [instance("inst-1", "cmp-a")]);
		// The schema accepts it — every definition is well-formed in isolation.
		expect(CanvasIRSchema.safeParse(ir).success).toBe(true);
		// The resolver still refuses to recurse.
		expect(
			resolveCanvasDocument(ir, {}).componentIssues.some(
				(i) => i.code === "component-cycle",
			),
		).toBe(true);
	});

	it("a dangling reference never throws into a render path", () => {
		const ir = docWith({}, [instance("inst-1", "cmp-missing")]);
		expect(() => resolveCanvasDocument(ir, {})).not.toThrow();
	});
});

// --- telemetry redaction -----------------------------------------------------

describe("diagnostics carry no document CONTENT (PRD §12)", () => {
	it("a missing-Source issue names ids, never the text it failed to render", () => {
		const secret = "SECRET-COPY-DO-NOT-LOG";
		const def = definition({
			properties: [
				{
					id: "p-t",
					name: "T",
					nodeId: "src-text",
					kind: "text",
					targetKind: "text",
				},
			],
			root: {
				...createFrame({ id: "src-root", bounds: { width: 40, height: 20 } }),
				children: [
					createText({
						id: "src-text",
						text: secret,
						bounds: { width: 40, height: 20 },
					}),
				],
			} as CanvasNode,
		});
		const ir = docWith({ "cmp-a": def }, [
			instance("inst-1", "cmp-a", {
				"p-gone": {
					kind: "text",
					value: { kind: "plain", text: `${secret}-OVERRIDE` },
				},
			}),
		]);
		const resolved = resolveCanvasDocument(ir, {});
		const serialized = JSON.stringify(resolved.componentIssues);
		// Issues are what a host forwards to telemetry by default, so they must
		// carry ids and codes — never copy, never override values.
		expect(serialized).not.toContain(secret);
		expect(resolved.componentIssues.length).toBeGreaterThan(0);
	});

	it("an override-orphan issue reports the property ID, not its value", () => {
		const ir = docWith({ "cmp-a": definition() }, [
			instance("inst-1", "cmp-a", {
				"p-orphan": {
					kind: "text",
					value: { kind: "plain", text: "leak-me" },
				},
			}),
		]);
		const orphan = resolveCanvasDocument(ir, {}).componentIssues.find(
			(i) => i.code === "component-override-orphan",
		);
		expect(orphan?.propertyId).toBe("p-orphan");
		expect(JSON.stringify(orphan)).not.toContain("leak-me");
	});
});
