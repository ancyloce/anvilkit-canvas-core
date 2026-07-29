import { describe, expect, it } from "vitest";
import {
	CANVAS_IR_VERSION,
	type CanvasDocumentCompatibility,
	type CanvasIR,
	type CanvasIRVersion,
	type CanvasKnownCapability,
	type CanvasLayoutResolveOptions,
	type CanvasResolvedDocument,
	type CanvasResolvedNodeId,
	type CanvasResolvedNodeRecord,
	resolveCanvasLayout,
	toResolvedNodeId,
} from "../index.js";

/**
 * M0-01 dependency gate for plan 0023 (Local Components): every IR v3 /
 * resolved-document contract that PRD 0014 was required to deliver must be
 * importable from the public barrel with the shape TD 0014 §5.1/§5.4 specify.
 * A compile error here is an A-1 violation, not a flaky test.
 *
 * Known A-1 naming deviation, accepted: the capability union shipped as
 * `CanvasKnownCapability` (open-by-construction companion to the
 * `requiredCapabilities: readonly string[]` field), not `CanvasCapability`.
 * M1-05 widens this union with the two component capability ids.
 */
describe("IR v3 dependency gate (PRD 0014 contracts)", () => {
	it("pins the written version literal to '3'", () => {
		expect(CANVAS_IR_VERSION).toBe("3");
		const written: CanvasIR["version"] = CANVAS_IR_VERSION;
		expect(written).toBe("3");
		const readable: CanvasIRVersion = "3";
		expect(readable).toBe("3");
	});

	it("exposes CanvasIR.compatibility with open capability strings", () => {
		const compatibility: NonNullable<CanvasIR["compatibility"]> = {
			schemaVersion: "3",
			minReaderSchemaVersion: "3",
			requiredCapabilities: ["layout.auto.v1", "components.local.v1"],
		};
		const record: CanvasDocumentCompatibility = compatibility;
		expect(record.requiredCapabilities).toContain("components.local.v1");

		const known: CanvasKnownCapability = "layout.auto.v1";
		expect(known).toBe("layout.auto.v1");
	});

	it("brands CanvasResolvedNodeId so raw strings cannot cross the boundary", () => {
		// @ts-expect-error - a bare string must not be a resolved node id
		const rejected: CanvasResolvedNodeId = "node-1";
		expect(rejected).toBe("node-1");

		const branded: CanvasResolvedNodeId = toResolvedNodeId("node-1");
		expect(branded).toBe("node-1");
	});

	it("keeps the resolved record and document shapes TD 0014 §5.4 requires", () => {
		type RecordShape = {
			readonly id: CanvasResolvedNodeId;
			readonly sourceNodeId: string;
			readonly childIds: readonly CanvasResolvedNodeId[];
		};
		const recordShape: CanvasResolvedNodeRecord extends RecordShape
			? true
			: false = true;
		expect(recordShape).toBe(true);

		type DocumentShape = {
			readonly source: CanvasIR;
			readonly records: ReadonlyMap<
				CanvasResolvedNodeId,
				CanvasResolvedNodeRecord
			>;
			readonly pageRoots: ReadonlyMap<string, readonly CanvasResolvedNodeId[]>;
			readonly engineVersion: 1;
			readonly inputHash: string;
		};
		const documentShape: CanvasResolvedDocument extends DocumentShape
			? true
			: false = true;
		expect(documentShape).toBe(true);
	});

	it("keeps resolveCanvasLayout(ir, options) with all-optional options", () => {
		expect(typeof resolveCanvasLayout).toBe("function");
		expect(resolveCanvasLayout.length).toBe(2);

		const emptyOptions: CanvasLayoutResolveOptions = {};
		const resolver: (
			ir: CanvasIR,
			options: CanvasLayoutResolveOptions,
		) => CanvasResolvedDocument = resolveCanvasLayout;
		expect(resolver).toBe(resolveCanvasLayout);
		expect(emptyOptions).toEqual({});
	});
});
