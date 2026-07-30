import fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
	type CanvasVirtualNodePath,
	decodeResolvedNodeId,
	encodeResolvedNodeId,
	toResolvedNodeId,
} from "../identity.js";

/**
 * M2-01 / T-RES-2 (plan 0023): the virtual-id codec is a bijection over
 * valid paths — round-trips exactly for ARBITRARY segment strings (document
 * node ids are arbitrary), never collides two distinct paths, and treats
 * non-codec ids as single-segment conceptual paths instead of throwing.
 */

const segmentArb = fc.oneof(
	fc.string({ maxLength: 24 }),
	fc.string({ unit: "grapheme", maxLength: 12 }),
	// Codec-shaped adversaries: delimiters, digits, our own prefix.
	fc.constantFrom(
		"akv1:",
		"akv1:1:x",
		"3:abc",
		":::",
		"0:",
		"\n",
		"🎨🎨",
		"",
		"12",
	),
);

const pathArb: fc.Arbitrary<CanvasVirtualNodePath> = fc
	.array(segmentArb, { minLength: 1, maxLength: 6 })
	.map((segments) => ({ segments }));

describe("virtual node ID codec (M2-01, T-RES-2)", () => {
	it("round-trips arbitrary adversarial paths exactly", () => {
		fc.assert(
			fc.property(pathArb, (path) => {
				const decoded = decodeResolvedNodeId(encodeResolvedNodeId(path));
				expect(decoded.segments).toEqual(path.segments);
			}),
			{ numRuns: 500 },
		);
	});

	it("never collides two distinct paths", () => {
		fc.assert(
			fc.property(pathArb, pathArb, (a, b) => {
				fc.pre(
					a.segments.length !== b.segments.length ||
						a.segments.some((s, i) => s !== b.segments[i]),
				);
				expect(encodeResolvedNodeId(a)).not.toBe(encodeResolvedNodeId(b));
			}),
			{ numRuns: 500 },
		);
	});

	it("round-trips a path whose segment IS an encoded id (nesting)", () => {
		const inner = encodeResolvedNodeId({ segments: ["inst-1", "node-1"] });
		const outer: CanvasVirtualNodePath = {
			segments: [inner as string, "node-2"],
		};
		expect(decodeResolvedNodeId(encodeResolvedNodeId(outer)).segments).toEqual(
			outer.segments,
		);
	});

	it("decodes a plain (non-virtual) id as its single-segment path", () => {
		expect(decodeResolvedNodeId(toResolvedNodeId("node-7")).segments).toEqual([
			"node-7",
		]);
		// A hostile id that merely starts with the prefix but is not a valid
		// codec payload stays opaque instead of misparsing.
		expect(
			decodeResolvedNodeId(toResolvedNodeId("akv1:not-a-payload")).segments,
		).toEqual(["akv1:not-a-payload"]);
	});

	it("rejects an empty path at encode time", () => {
		expect(() => encodeResolvedNodeId({ segments: [] })).toThrow(TypeError);
	});
});
