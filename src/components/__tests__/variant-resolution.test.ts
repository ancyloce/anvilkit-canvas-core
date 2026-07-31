import fc from "fast-check";
import { describe, expect, it } from "vitest";

import {
	type CanvasComponentVariantSet,
	canonicalVariantKey,
} from "../../ir/component-variants.js";
import type { CanvasComponentProperty } from "../../ir/types.js";
import {
	resolveComponentVariant,
	validateComponentVariantSet,
	variantPropertyTarget,
} from "../variant-resolution.js";

/**
 * T-024 / T-025 — sparse variants, canonical keys, deterministic fallback.
 */

function set(
	overrides: Partial<CanvasComponentVariantSet> = {},
): CanvasComponentVariantSet {
	return {
		axes: [
			{
				id: "size",
				values: [{ id: "sm" }, { id: "md" }, { id: "lg" }],
				defaultValueId: "md",
			},
			{
				id: "tone",
				values: [{ id: "brand" }, { id: "neutral" }],
				defaultValueId: "neutral",
			},
		],
		variants: [
			{ id: "v-md-neutral", selection: { size: "md", tone: "neutral" } },
			{ id: "v-lg-brand", selection: { size: "lg", tone: "brand" } },
		],
		defaultVariantId: "v-md-neutral",
		...overrides,
	};
}

describe("canonicalVariantKey (T-025)", () => {
	it("is independent of property order", () => {
		expect(canonicalVariantKey({ size: "lg", tone: "brand" })).toBe(
			canonicalVariantKey({ tone: "brand", size: "lg" }),
		);
	});

	it("distinguishes different selections", () => {
		expect(canonicalVariantKey({ size: "lg" })).not.toBe(
			canonicalVariantKey({ size: "sm" }),
		);
		expect(canonicalVariantKey({ size: "lg" })).not.toBe(
			canonicalVariantKey({ tone: "lg" }),
		);
	});

	it("cannot be forged by an id containing a separator", () => {
		// Without escaping, `{ "a=b": "c" }` and `{ a: "b=c" }` would collide.
		expect(canonicalVariantKey({ "a=b": "c" })).not.toBe(
			canonicalVariantKey({ a: "b=c" }),
		);
		expect(canonicalVariantKey({ "a&b": "c" })).not.toBe(
			canonicalVariantKey({ a: "", b: "c" }),
		);
	});

	it("NO display name participates in the key (T-025 DoD)", () => {
		// Names are localizable; a key built from them would change when a
		// translator edits a label, invalidating every persisted selection.
		const withNames = set({
			axes: [
				{
					id: "size",
					name: "Größe",
					values: [{ id: "md", name: "Mittel" }],
					defaultValueId: "md",
				},
			],
			variants: [{ id: "v", selection: { size: "md" } }],
			defaultVariantId: "v",
		});
		const key = canonicalVariantKey(
			withNames.variants[0]?.selection as Record<string, string>,
		);
		expect(key).not.toContain("Größe");
		expect(key).not.toContain("Mittel");
		expect(key).toBe("size=md");
	});

	it("PROP: stable under key reordering", () => {
		fc.assert(
			fc.property(
				fc.dictionary(
					fc.string({ minLength: 1, maxLength: 8 }),
					fc.string({ minLength: 1, maxLength: 8 }),
					{ minKeys: 1, maxKeys: 6 },
				),
				(selection) => {
					const shuffled = Object.fromEntries(
						Object.entries(selection).reverse(),
					);
					return (
						canonicalVariantKey(selection) === canonicalVariantKey(shuffled)
					);
				},
			),
		);
	});

	it("PROP: distinct selections never collide", () => {
		fc.assert(
			fc.property(
				fc.dictionary(
					fc.string({ minLength: 1, maxLength: 6 }),
					fc.string({ minLength: 1, maxLength: 6 }),
					{ minKeys: 1, maxKeys: 4 },
				),
				fc.dictionary(
					fc.string({ minLength: 1, maxLength: 6 }),
					fc.string({ minLength: 1, maxLength: 6 }),
					{ minKeys: 1, maxKeys: 4 },
				),
				(a, b) => {
					const sameValue =
						Object.keys(a).length === Object.keys(b).length &&
						Object.keys(a).every((k) => b[k] === a[k]);
					return (
						sameValue === (canonicalVariantKey(a) === canonicalVariantKey(b))
					);
				},
			),
		);
	});
});

describe("validateComponentVariantSet (T-024, §11.2)", () => {
	it("accepts a well-formed SPARSE set without the full Cartesian product", () => {
		// 3 sizes x 2 tones = 6 dense combinations; only 2 are declared.
		expect(validateComponentVariantSet(set())).toEqual([]);
	});

	it.each([
		[
			"duplicate axis",
			set({
				axes: [
					{ id: "size", values: [{ id: "md" }], defaultValueId: "md" },
					{ id: "size", values: [{ id: "sm" }], defaultValueId: "sm" },
				],
			}),
			"variant-duplicate-axis",
		],
		[
			"duplicate value",
			set({
				axes: [
					{
						id: "size",
						values: [{ id: "md" }, { id: "md" }],
						defaultValueId: "md",
					},
				],
			}),
			"variant-duplicate-value",
		],
		[
			"axis default that is not a value",
			set({
				axes: [{ id: "size", values: [{ id: "md" }], defaultValueId: "nope" }],
			}),
			"variant-missing-default",
		],
		[
			"variant selecting an unknown axis",
			set({
				variants: [{ id: "v", selection: { nope: "x" } }],
				defaultVariantId: "v",
			}),
			"variant-unknown-axis",
		],
		[
			"variant selecting an unknown value",
			set({
				variants: [{ id: "v", selection: { size: "xl" } }],
				defaultVariantId: "v",
			}),
			"variant-unknown-value",
		],
		[
			"duplicate variant id",
			set({
				variants: [
					{ id: "v", selection: { size: "sm" } },
					{ id: "v", selection: { size: "lg" } },
				],
				defaultVariantId: "v",
			}),
			"variant-duplicate-id",
		],
		[
			"default variant that does not exist",
			set({ defaultVariantId: "missing" }),
			"variant-missing-default",
		],
	])("rejects %s", (_label, bad, code) => {
		expect(validateComponentVariantSet(bad).map((i) => i.code)).toContain(code);
	});

	it("catches two variants that differ only in key ORDER", () => {
		// Canonical comparison is what makes this detectable at all.
		const issues = validateComponentVariantSet(
			set({
				variants: [
					{ id: "a", selection: { size: "md", tone: "neutral" } },
					{ id: "b", selection: { tone: "neutral", size: "md" } },
				],
				defaultVariantId: "a",
			}),
		);
		expect(issues.map((i) => i.code)).toContain("variant-duplicate-selection");
	});

	it("rejects a propertyTargetMap naming an unknown property", () => {
		const properties: CanvasComponentProperty[] = [
			{
				id: "p-title",
				name: "Title",
				nodeId: "n1",
				kind: "text",
				targetKind: "text",
			},
		];
		const issues = validateComponentVariantSet(
			set({
				variants: [
					{
						id: "v-md-neutral",
						selection: { size: "md", tone: "neutral" },
						propertyTargetMap: { "p-ghost": "n2" },
					},
				],
			}),
			properties,
		);
		expect(issues.map((i) => i.code)).toContain("variant-property-unresolved");
	});

	it("enforces the axis, value and variant caps", () => {
		const many = (n: number, prefix: string) =>
			Array.from({ length: n }, (_, i) => ({ id: `${prefix}${i}` }));
		const tooManyAxes = set({
			axes: Array.from({ length: 9 }, (_, i) => ({
				id: `a${i}`,
				values: [{ id: "x" }],
				defaultValueId: "x",
			})),
		});
		expect(
			validateComponentVariantSet(tooManyAxes).map((i) => i.code),
		).toContain("variant-limit-exceeded");

		const tooManyValues = set({
			axes: [{ id: "size", values: many(17, "v"), defaultValueId: "v0" }],
		});
		expect(
			validateComponentVariantSet(tooManyValues).map((i) => i.code),
		).toContain("variant-limit-exceeded");
	});

	it("reports EVERY issue, not just the first", () => {
		const issues = validateComponentVariantSet(
			set({
				axes: [{ id: "size", values: [{ id: "md" }], defaultValueId: "nope" }],
				variants: [{ id: "v", selection: { unknown: "x" } }],
				defaultVariantId: "missing",
			}),
		);
		expect(issues.length).toBeGreaterThan(2);
	});
});

describe("resolveComponentVariant (T-025, §11.4)", () => {
	it("resolves an exact combination", () => {
		const r = resolveComponentVariant(set(), { size: "lg", tone: "brand" });
		expect(r?.code).toBe("resolved");
		expect(r?.variant.id).toBe("v-lg-brand");
	});

	it("NORMALIZES with axis defaults before looking up", () => {
		// Only `tone` is persisted; `size` fills from its axis default (`md`),
		// which is what makes a partial selection meaningful at all.
		const r = resolveComponentVariant(set(), { tone: "neutral" });
		expect(r?.code).toBe("resolved");
		expect(r?.variant.id).toBe("v-md-neutral");
		expect(r?.normalizedSelection).toEqual({ size: "md", tone: "neutral" });
	});

	it("normalizes an EMPTY selection to every axis default", () => {
		const r = resolveComponentVariant(set(), undefined);
		expect(r?.variant.id).toBe("v-md-neutral");
		expect(r?.normalizedSelection).toEqual({ size: "md", tone: "neutral" });
	});

	it("falls back to the explicit default for an undeclared combination", () => {
		// `sm`+`brand` is legal on both axes but is not one of the 2 stored
		// variants — the normal sparse case.
		const r = resolveComponentVariant(set(), { size: "sm", tone: "brand" });
		expect(r?.code).toBe("fallback-unknown-combination");
		expect(r?.variant.id).toBe("v-md-neutral");
		expect(r?.message).toBeTruthy();
	});

	it("falls back and REPORTS when a value is unknown", () => {
		const r = resolveComponentVariant(set(), { size: "xl", tone: "neutral" });
		expect(r?.code).toBe("fallback-invalid-selection");
		expect(r?.normalizedSelection.size).toBe("md");
		expect(r?.message).toContain("xl");
	});

	it("ignores an unknown AXIS rather than failing", () => {
		// A selection written against a newer version of the component.
		const r = resolveComponentVariant(set(), {
			size: "md",
			tone: "neutral",
			density: "compact",
		});
		expect(r?.code).toBe("fallback-invalid-selection");
		expect(r?.normalizedSelection).toEqual({ size: "md", tone: "neutral" });
	});

	it("is deterministic — same input, same output", () => {
		const a = resolveComponentVariant(set(), { size: "sm" });
		const b = resolveComponentVariant(set(), { size: "sm" });
		expect(a).toEqual(b);
	});

	it("returns undefined when the set has no valid default", () => {
		// Malformed; validation reports it. Resolution declines rather than
		// inventing a variant, so the caller renders the base definition.
		expect(
			resolveComponentVariant(set({ defaultVariantId: "gone" }), {}),
		).toBeUndefined();
	});

	it("never throws on hostile input", () => {
		for (const selection of [
			{ __proto__: "x" },
			{ constructor: "x" },
			{ "": "" },
		] as Record<string, string>[]) {
			expect(() => resolveComponentVariant(set(), selection)).not.toThrow();
		}
	});
});

describe("variantPropertyTarget (TD §11.1 propertyTargetMap)", () => {
	const property: CanvasComponentProperty = {
		id: "p-title",
		name: "Title",
		nodeId: "default-node",
		kind: "text",
		targetKind: "text",
	};

	it("uses the definition's own nodeId when the variant does not remap it", () => {
		expect(variantPropertyTarget(property, undefined)).toBe("default-node");
		expect(variantPropertyTarget(property, { id: "v", selection: {} })).toBe(
			"default-node",
		);
	});

	it("redirects to the variant's node when remapped", () => {
		// This is what makes an override survive a variant change: the override
		// is keyed by property id, and the property points somewhere else.
		expect(
			variantPropertyTarget(property, {
				id: "v",
				selection: {},
				propertyTargetMap: { "p-title": "variant-node" },
			}),
		).toBe("variant-node");
	});
});
