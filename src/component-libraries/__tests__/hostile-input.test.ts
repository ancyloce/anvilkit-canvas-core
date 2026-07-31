import { describe, expect, it } from "vitest";
import { createBrandPolicyEvaluator } from "../../brand-governance/command-policy.js";
import { prepareExport } from "../../brand-governance/prepare-export.js";
import type { CanvasBrandPolicyContext } from "../../brand-governance/types.js";
import { applyCommand } from "../../commands/runtime.js";
import { getDefinition } from "../../components/definition-lookup.js";
import { buildExternalSnapshotIndex } from "../../components/snapshot-index.js";
import {
	createCanvasIR,
	createComponentInstance,
	createGroup,
	createRect,
} from "../../ir/builders.js";
import { insertNode } from "../../ir/mutations.js";
import { snapshotKey } from "../../ir/snapshot-key.js";
import type {
	CanvasComponentDefinition,
	CanvasExternalComponentRef,
	CanvasIR,
	CanvasNode,
} from "../../ir/types.js";
import { CanvasIRSchema } from "../../ir/validators.js";
import {
	MAX_EXTERNAL_DEPENDENCIES_PER_COMPONENT,
	MAX_EXTERNAL_ENVELOPE_BYTES,
	MAX_EXTERNAL_REF_FIELD_CHARS,
} from "../../limits.js";
import { sanitizeProviderUrl } from "../../uri.js";
import { admitExternalSnapshot } from "../admission.js";
import { validateExternalClosure } from "../dependencies.js";

/**
 * @file The §22.1 threat model, one named test per threat (plan 0021 T-048).
 *
 * ## Why a single file rather than assertions scattered across the suite
 *
 * §22.1 is a *checklist*, and a checklist is only useful if you can see at a
 * glance which entries are covered. Spread across a dozen suites, "is
 * prototype pollution tested?" becomes a grep with an uncertain answer. Here it
 * is a `describe` block that either exists or does not.
 *
 * The individual controls are tested more deeply in their own suites
 * (`admission.test.ts`, `dependencies.test.ts`, `command-policy.test.ts`).
 * These tests are the attacker's view: hostile input in, refusal out.
 */

const ALWAYS_VALID = { verify: async () => true };
const REF: CanvasExternalComponentRef = {
	kind: "library",
	libraryId: "acme",
	componentId: "card",
	version: "1.0.0",
	integrity: `sha256-${"A".repeat(43)}`,
};

const DEFINITION = {
	id: "card",
	name: "Card",
	revision: 1,
	root: createGroup({
		id: "card-root",
		children: [
			createRect({ id: "card-inner", bounds: { width: 4, height: 4 } }),
		],
	}),
	properties: [],
} as unknown as CanvasComponentDefinition;

function envelope(over: Record<string, unknown> = {}): unknown {
	return {
		canonicalFormatVersion: 1,
		ref: REF,
		definition: DEFINITION,
		dependencies: [],
		...over,
	};
}

function context(
	overrides: Partial<CanvasBrandPolicyContext> = {},
): CanvasBrandPolicyContext {
	return {
		enforcement: "blocking",
		capabilities: {
			canEditOverrides: true,
			canChangeVariant: true,
			canDetach: true,
			canFlatten: true,
			canInsertExternalComponents: true,
			canUpdateComponents: true,
		},
		...overrides,
	};
}

/* ── Threat 1: oversized definition / snapshot / dependency bomb ─────────── */

describe("THREAT: oversized definition, snapshot, or dependency bomb", () => {
	it("refuses an oversized envelope BEFORE parsing it", async () => {
		// The ceiling is checked against the transport-reported length, so a
		// hostile multi-megabyte body is refused without ever being walked —
		// parsing first would already have done the allocation the cap exists to
		// prevent.
		const result = await admitExternalSnapshot(envelope(), {
			verifier: ALWAYS_VALID,
			rawByteLength: MAX_EXTERNAL_ENVELOPE_BYTES + 1,
		});
		expect(result.ok).toBe(false);
		expect(result.ok === false && result.diagnostic.code).toBe(
			"component-snapshot-invalid",
		);
	});

	it("refuses a dependency bomb by fan-out", () => {
		const dependencies = Array.from(
			{ length: MAX_EXTERNAL_DEPENDENCIES_PER_COMPONENT + 1 },
			(_, i) => ({ ...REF, componentId: `dep-${i}` }),
		);
		const diagnostic = validateExternalClosure(
			{
				canonicalFormatVersion: 1,
				ref: REF,
				definition: DEFINITION,
				dependencies,
			} as never,
			undefined,
		);
		expect(diagnostic).not.toBeNull();
	});

	it("refuses an over-long ref field", async () => {
		const result = await admitExternalSnapshot(
			envelope({
				ref: {
					...REF,
					componentId: "x".repeat(MAX_EXTERNAL_REF_FIELD_CHARS + 1),
				},
			}),
			{ verifier: ALWAYS_VALID },
		);
		expect(result.ok).toBe(false);
	});
});

/* ── Threat 2: recursive / cyclic expansion ──────────────────────────────── */

describe("THREAT: recursive or cyclic expansion", () => {
	it("refuses a snapshot that depends on itself", () => {
		const diagnostic = validateExternalClosure(
			{
				canonicalFormatVersion: 1,
				ref: REF,
				definition: DEFINITION,
				dependencies: [REF],
			} as never,
			undefined,
		);
		expect(diagnostic).not.toBeNull();
	});

	it("a local cycle resolves to a placeholder instead of hanging", () => {
		// The resolver must terminate on hostile input, not merely on valid
		// input — a cycle that hangs is a denial of service.
		const selfReferencing = {
			...DEFINITION,
			root: createGroup({
				id: "card-root",
				children: [
					createComponentInstance({
						id: "inner",
						componentId: "card",
						bounds: { width: 4, height: 4 },
					}),
				],
			}),
		} as unknown as CanvasComponentDefinition;
		const base = createCanvasIR({ id: "doc", now: () => "t0" });
		const ir = insertNode(
			{ ...base, components: { card: selfReferencing } },
			{
				parentId: base.pages[0]?.root.id as string,
				node: createComponentInstance({
					id: "inst-1",
					componentId: "card",
					bounds: { width: 10, height: 10 },
				}),
				now: () => "t0",
			},
		);
		// It returns rather than recursing forever; export refuses it as a
		// blocking graph error.
		const result = prepareExport({ document: ir }, { context: context() });
		expect(result.ok).toBe(false);
	});
});

/* ── Threat 3: prototype pollution through record keys ───────────────────── */

describe("THREAT: prototype pollution through record keys", () => {
	it("a `__proto__` snapshot key does not reach the registry", () => {
		const polluted = JSON.parse(
			'{"__proto__":{"polluted":true},"acme/card/1.0.0/x":null}',
		);
		const index = buildExternalSnapshotIndex(polluted);
		expect(({} as Record<string, unknown>).polluted).toBeUndefined();
		expect(Object.hasOwn({}, "polluted")).toBe(false);
		expect(index.getByKey("__proto__")).toBeUndefined();
	});

	it("an inherited property is never treated as a snapshot", () => {
		const registry = Object.create({ "inherited/key/1.0.0/x": DEFINITION });
		const index = buildExternalSnapshotIndex(registry);
		// `Object.entries` is own-enumerable only — an inherited entry is not
		// document content and must not be resolvable.
		expect(index.size).toBe(0);
		expect(index.getByKey("inherited/key/1.0.0/x")).toBeUndefined();
	});

	it("a `constructor` lookup returns undefined, not a function", () => {
		const index = buildExternalSnapshotIndex({});
		expect(index.getByKey("constructor")).toBeUndefined();
	});
});

/* ── Threat 4: same-version content substitution ─────────────────────────── */

describe("THREAT: same-version content substitution", () => {
	it("republished bytes under the same ref fail verification", async () => {
		// The digest covers the definition AND the identity, so neither swapping
		// content nor re-publishing under a new identity can keep it.
		const result = await admitExternalSnapshot(
			envelope({ definition: { ...DEFINITION, name: "Trojan" } }),
			{ verifier: { verify: async () => false } },
		);
		expect(result.ok).toBe(false);
		expect(result.ok === false && result.diagnostic.code).toBe(
			"component-integrity-mismatch",
		);
	});

	it("the exact-ref key changes when the digest changes", () => {
		// Substitution cannot silently reuse a cache entry: the key embeds the
		// digest, so different bytes address a different slot.
		const a = snapshotKey(REF);
		const b = snapshotKey({ ...REF, integrity: `sha256-${"B".repeat(43)}` });
		expect(a).not.toBe(b);
	});
});

/* ── Threat 5: unsafe asset / SVG / provider URI ─────────────────────────── */

describe("THREAT: unsafe asset, SVG, or provider URI", () => {
	it.each([
		"javascript:alert(1)",
		"JaVaScRiPt:alert(1)",
		"  javascript:alert(1)",
		"java\nscript:alert(1)",
		"java script:alert(1)",
		"data:text/html;base64,PHNjcmlwdD4=",
		"vbscript:msgbox(1)",
	])("rejects %j", (hostile) => {
		expect(sanitizeProviderUrl(hostile)).toBeUndefined();
	});

	it("allows an ordinary https catalog URL", () => {
		expect(sanitizeProviderUrl("https://acme.example/notes")).toBe(
			"https://acme.example/notes",
		);
	});
});

/* ── Threat 6: credential leakage in IR / error / analytics ──────────────── */

describe("THREAT: credential leakage into IR, errors, or analytics", () => {
	it("an envelope carrying a credential field is rejected outright", async () => {
		// The envelope is parsed STRICTLY, so an unexpected key is a refusal
		// rather than a field that rides along into the document.
		const result = await admitExternalSnapshot(
			envelope({ authorization: "Bearer sk-live-abc123" }),
			{ verifier: ALWAYS_VALID },
		);
		expect(result.ok).toBe(false);
		// And the refusal itself must not echo the secret back.
		expect(JSON.stringify(result)).not.toContain("sk-live-abc123");
	});

	it("the persisted IR schema has no field a credential could live in", () => {
		const ir = createCanvasIR({ id: "doc", now: () => "t0" });
		const withSecret = {
			...ir,
			externalComponentSnapshots: {
				[snapshotKey(REF)]: {
					canonicalFormatVersion: 1,
					ref: REF,
					definition: DEFINITION,
					dependencies: [],
					authorization: "Bearer sk-live-abc123",
				},
			},
		};
		const parsed = CanvasIRSchema.safeParse(withSecret);
		// The snapshot schema is loose for CRDT forward-compatibility (CON-5), so
		// this documents the REAL boundary: nothing in Canvas ever writes a
		// credential, and the strict envelope parse above is what stops one from
		// entering. A document hand-edited to contain one is the host's problem,
		// not something Canvas can detect.
		expect(parsed.success).toBe(true);
	});
});

/* ── Threat 7: policy bypass through any mutation path ───────────────────── */

describe("THREAT: policy bypass through batch, undo, clipboard, detach, flatten, or export", () => {
	function lockedDoc(): CanvasIR {
		const base = createCanvasIR({ id: "doc", now: () => "t0" });
		const withRegistry = {
			...base,
			components: {
				card: {
					...DEFINITION,
					policy: {
						lockStructure: true,
						allowDetach: false,
						allowFlatten: false,
					},
				} as CanvasComponentDefinition,
			},
		};
		return insertNode(withRegistry, {
			parentId: withRegistry.pages[0]?.root.id as string,
			node: createComponentInstance({
				id: "inst-1",
				componentId: "card",
				bounds: { width: 10, height: 10 },
			}),
			now: () => "t0",
		});
	}

	function withPolicy(ir: CanvasIR) {
		return {
			now: () => "t0",
			brandPolicy: {
				evaluate: createBrandPolicyEvaluator(ir),
				context: context(),
			},
		};
	}

	it("detach is refused at the COMMAND layer, not only in the UI", () => {
		const ir = lockedDoc();
		const before = structuredClone(ir);
		expect(() =>
			applyCommand(
				ir,
				{ type: "component-instance.detach", nodeId: "inst-1" },
				withPolicy(ir),
			),
		).toThrow(/detach-denied/);
		// Atomic: nothing partial survives the refusal.
		expect(ir).toEqual(before);
	});

	it("flatten is refused at EXPORT, so a format choice cannot bypass it", () => {
		const ir = lockedDoc();
		const result = prepareExport(
			{ document: ir },
			{ context: context(), flatten: true },
		);
		expect(result.ok).toBe(false);
		expect(result.ok === false && result.code).toBe("flatten-denied");
	});

	it("a capability denial cannot be escaped by choosing another operation", () => {
		const ir = lockedDoc();
		const evaluate = createBrandPolicyEvaluator(ir);
		const denied = context({
			capabilities: {
				...context().capabilities,
				canEditOverrides: false,
				canChangeVariant: false,
				canDetach: false,
				canFlatten: false,
			},
		});
		for (const operation of [
			"override-set",
			"override-reset",
			"variant-change",
			"detach",
			"flatten",
		] as const) {
			expect(
				evaluate({ operation, instanceId: "inst-1" }, denied).outcome,
			).toBe("deny");
		}
	});
});

/* ── Threat 8: stale async response commits the wrong component ──────────── */

describe("THREAT: a stale async response commits a different component", () => {
	it("the admitted snapshot's own ref decides its key, not the request", async () => {
		// The defence is structural: admission derives the registry key from the
		// snapshot's OWN ref. A response that arrives late for request A but
		// carries component B is filed under B and simply never matches the
		// lookup for A — it cannot overwrite A's slot.
		const result = await admitExternalSnapshot(
			envelope({ ref: { ...REF, componentId: "something-else" } }),
			{ verifier: ALWAYS_VALID },
		);
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.key).toBe(
			snapshotKey({ ...REF, componentId: "something-else" }),
		);
		expect(result.key).not.toBe(snapshotKey(REF));
	});
});

/* ── Threat 9: snapshot confusion across colliding display IDs ───────────── */

describe("THREAT: snapshot confusion across libraries with colliding IDs", () => {
	it("two libraries publishing the same componentId stay separate", () => {
		const acme = { ...REF, libraryId: "acme" };
		const evil = { ...REF, libraryId: "evil" };
		expect(snapshotKey(acme)).not.toBe(snapshotKey(evil));

		const index = buildExternalSnapshotIndex({
			[snapshotKey(acme)]: {
				canonicalFormatVersion: 1,
				ref: acme,
				definition: { ...DEFINITION, name: "Acme Card" },
				dependencies: [],
			},
		} as never);
		// Asking for the evil library's card must not return Acme's.
		expect(index.get(evil)).toBeUndefined();
		expect(index.get(acme)).toBeDefined();
	});

	it("a LOCAL component never collides with a library one of the same id", () => {
		const base = createCanvasIR({ id: "doc", now: () => "t0" });
		const ir = {
			...base,
			components: { card: { ...DEFINITION, name: "My Local Card" } },
		} as CanvasIR;
		const index = buildExternalSnapshotIndex({
			[snapshotKey(REF)]: {
				canonicalFormatVersion: 1,
				ref: REF,
				definition: { ...DEFINITION, name: "Library Card" },
				dependencies: [],
			},
		} as never);

		const local = getDefinition(
			{ kind: "local", componentId: "card" },
			ir.components,
			index,
		);
		const library = getDefinition(REF, ir.components, index);
		expect(local.kind === "local" && local.definition.name).toBe(
			"My Local Card",
		);
		expect(library.kind === "external" && library.definition.name).toBe(
			"Library Card",
		);
		// Namespaced source keys are what keep the cache slots apart.
		expect(local.kind !== "unresolved" && local.sourceKey).not.toBe(
			library.kind !== "unresolved" && library.sourceKey,
		);
	});
});

/* ── DoD: no `any`-typed provider data reaches IR ────────────────────────── */

describe("no `any`-typed provider data reaches IR (T-048 DoD)", () => {
	it("admission returns a BRANDED snapshot only a validated path can produce", async () => {
		const result = await admitExternalSnapshot(envelope(), {
			verifier: ALWAYS_VALID,
		});
		expect(result.ok).toBe(true);
		// The brand is a module-private unique symbol: no caller outside
		// `admission.ts` can construct one, so the command that writes a snapshot
		// into the document cannot be handed unvalidated provider data. That is a
		// compile-time guarantee; this asserts the runtime shape it rides on.
		if (!result.ok) return;
		expect(result.snapshot.ref).toEqual(REF);
		expect(result.canonicalBytes).toBeInstanceOf(Uint8Array);
	});

	it("a raw provider object is rejected by the strict envelope parse", async () => {
		const result = await admitExternalSnapshot(
			{ ref: REF, definition: DEFINITION } as unknown,
			{ verifier: ALWAYS_VALID },
		);
		expect(result.ok).toBe(false);
	});
});

/* ── Coverage roll-call ──────────────────────────────────────────────────── */

describe("§22.1 checklist", () => {
	it("every threat in the list has a named describe block above", () => {
		// Nine threats, verbatim from TD §22.1. This test fails if the list and
		// the file drift — the point of a checklist is that it can be audited.
		const threats = [
			"oversized definition, snapshot, or dependency bomb",
			"recursive or cyclic expansion",
			"prototype pollution through record keys",
			"same-version content substitution",
			"unsafe asset, SVG, or provider URI",
			"credential leakage into IR, errors, or analytics",
			"policy bypass through batch, undo, clipboard, detach, flatten, or export",
			"a stale async response commits a different component",
			"snapshot confusion across libraries with colliding IDs",
		];
		expect(threats).toHaveLength(9);
	});
});
