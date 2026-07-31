import { describe, expect, it } from "vitest";

import {
	CanvasExternalComponentRefSchema,
	CanvasComponentSourceRefSchema as StrictSourceRefSchema,
} from "../../component-libraries/schema.js";
import {
	type CanvasComponentSourceRef,
	CanvasIRComponentSourceRefSchema,
	componentSourceLabel,
	componentSourceRefsEqual,
	isExternalSourceRef,
	isLocalSourceRef,
	localComponentIdOf,
} from "../component-source.js";

const LOCAL: CanvasComponentSourceRef = { kind: "local", componentId: "cmp-a" };
const EXTERNAL: CanvasComponentSourceRef = {
	kind: "library",
	libraryId: "lib-1",
	componentId: "button",
	version: "1.2.3",
	integrity: "sha256-47DEQpj8HBSa-_TImW-5JCeuQeRkm5NMpJWZG3hSuFU",
};

describe("source-ref accessors (plan 0021 T-012)", () => {
	it("narrows both kinds", () => {
		expect(isLocalSourceRef(LOCAL)).toBe(true);
		expect(isExternalSourceRef(LOCAL)).toBe(false);
		expect(isExternalSourceRef(EXTERNAL)).toBe(true);
		expect(isLocalSourceRef(EXTERNAL)).toBe(false);
	});

	it("yields a registry key ONLY for a local Source", () => {
		expect(localComponentIdOf(LOCAL)).toBe("cmp-a");
		// The whole point of the accessor: an external ref also has a
		// `componentId` field, and reading it directly would silently look up a
		// library component in the document-local registry.
		expect(localComponentIdOf(EXTERNAL)).toBeUndefined();
		expect(EXTERNAL.kind === "library" && EXTERNAL.componentId).toBe("button");
	});

	it("labels a Source without leaking the digest", () => {
		expect(componentSourceLabel(LOCAL)).toBe("cmp-a");
		expect(componentSourceLabel(EXTERNAL)).toBe("lib-1/button@1.2.3");
		expect(componentSourceLabel(EXTERNAL)).not.toContain("sha256");
	});

	describe("structural equality", () => {
		it("ignores key order", () => {
			const reordered = {
				integrity: EXTERNAL.integrity,
				version: "1.2.3",
				componentId: "button",
				libraryId: "lib-1",
				kind: "library",
			} as CanvasComponentSourceRef;
			expect(componentSourceRefsEqual(EXTERNAL, reordered)).toBe(true);
			// A stringify-based compare would call these different, which is how a
			// second snapshot of an identical component gets stored.
			expect(JSON.stringify(EXTERNAL)).not.toBe(JSON.stringify(reordered));
		});

		it("separates kinds that share a componentId", () => {
			expect(
				componentSourceRefsEqual(
					{ kind: "local", componentId: "button" },
					EXTERNAL,
				),
			).toBe(false);
		});

		it("treats a different integrity for the same version as a different Source", () => {
			expect(
				componentSourceRefsEqual(EXTERNAL, {
					...EXTERNAL,
					integrity: "sha256-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
				} as CanvasComponentSourceRef),
			).toBe(false);
		});

		it.each([
			["libraryId", "other-lib"],
			["componentId", "other-component"],
			["version", "9.9.9"],
		])("distinguishes a differing %s", (field, value) => {
			expect(
				componentSourceRefsEqual(EXTERNAL, {
					...EXTERNAL,
					[field]: value,
				} as CanvasComponentSourceRef),
			).toBe(false);
		});
	});
});

describe("the persisted source-ref schema is LOOSE (CON-5)", () => {
	it("preserves unknown keys a newer peer added", () => {
		const parsed = CanvasIRComponentSourceRefSchema.parse({
			...LOCAL,
			futureField: { added: "by a newer build" },
		}) as Record<string, unknown>;
		expect(parsed.futureField).toEqual({ added: "by a newer build" });
	});

	it("still enforces the field bounds", () => {
		expect(() =>
			CanvasIRComponentSourceRefSchema.parse({
				kind: "local",
				componentId: "",
			}),
		).toThrow();
		expect(() =>
			CanvasIRComponentSourceRefSchema.parse({
				kind: "local",
				componentId: "x".repeat(257),
			}),
		).toThrow();
	});

	it("rejects control characters in a ref field", () => {
		expect(() =>
			CanvasIRComponentSourceRefSchema.parse({
				kind: "local",
				componentId: `cmp${String.fromCharCode(0)}a`,
			}),
		).toThrow();
		expect(() =>
			CanvasIRComponentSourceRefSchema.parse({
				kind: "local",
				componentId: `cmp${String.fromCharCode(0x9f)}a`,
			}),
		).toThrow();
	});

	it("accepts a well-formed external ref", () => {
		expect(CanvasIRComponentSourceRefSchema.parse(EXTERNAL)).toMatchObject(
			EXTERNAL,
		);
	});
});

/**
 * The strict envelope schema and the loose persisted schema are allowed to
 * disagree about *unknown keys* and nothing else. If they ever disagreed about
 * what a legal version or a legal field is, a document could hold a ref its own
 * envelope schema would have rejected — which is the exact hole the shared rule
 * in `component-source.ts` closes.
 */
describe("strict/loose parity: same rules, different strictness", () => {
	const REJECTED_VERSIONS = [
		"latest",
		"LATEST",
		"next",
		"stable",
		"^1.0.0",
		"~1.0.0",
		">=1.0.0",
		"1 || 2",
		"1.x",
		"1.2.X",
		"*",
		"1.0.0 ",
	];
	const ACCEPTED_VERSIONS = [
		"1.0.0",
		"2026.07.30",
		"1.0.0-rc.1",
		"1.0.0+build.5",
		"deadbeefcafe",
	];

	it.each(REJECTED_VERSIONS)("both schemas reject version %j", (version) => {
		const ref = { ...EXTERNAL, version };
		expect(CanvasIRComponentSourceRefSchema.safeParse(ref).success).toBe(false);
		expect(StrictSourceRefSchema.safeParse(ref).success).toBe(false);
		expect(CanvasExternalComponentRefSchema.safeParse(ref).success).toBe(false);
	});

	it.each(ACCEPTED_VERSIONS)("both schemas accept version %j", (version) => {
		const ref = { ...EXTERNAL, version };
		expect(CanvasIRComponentSourceRefSchema.safeParse(ref).success).toBe(true);
		expect(StrictSourceRefSchema.safeParse(ref).success).toBe(true);
	});

	it("differ on unknown keys, and ONLY on unknown keys", () => {
		const withExtra = { ...EXTERNAL, vendorExtra: 1 };
		expect(CanvasIRComponentSourceRefSchema.safeParse(withExtra).success).toBe(
			true,
		);
		expect(StrictSourceRefSchema.safeParse(withExtra).success).toBe(false);
	});

	it("agree on a malformed integrity digest", () => {
		const ref = { ...EXTERNAL, integrity: "not-a-digest!" };
		expect(CanvasIRComponentSourceRefSchema.safeParse(ref).success).toBe(false);
		expect(StrictSourceRefSchema.safeParse(ref).success).toBe(false);
	});
});
