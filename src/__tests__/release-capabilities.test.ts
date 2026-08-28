import { describe, expect, it } from "vitest";
import {
	CANVAS_RELEASE_CAPABILITIES,
	CANVAS_RELEASE_CAPABILITY_IDS,
	CANVAS_RELEASE_FEATURE_FLAG_DEFAULTS,
	getCanvasReleaseCapability,
} from "../release-capabilities.js";

const EXPORT_FORMATS = new Set([
	"jpeg",
	"json",
	"pdf",
	"pdf-print",
	"png",
	"svg",
	"webp",
]);

describe("Canvas release capability registry (E0-T1)", () => {
	it("gives every capability a complete, unique release declaration", () => {
		const capabilityIds = new Set<string>();
		const featureFlagIds = new Set<string>();

		for (const capability of CANVAS_RELEASE_CAPABILITIES) {
			expect(capabilityIds.has(capability.id), capability.id).toBe(false);
			expect(featureFlagIds.has(capability.featureFlag.id), capability.id).toBe(
				false,
			);
			capabilityIds.add(capability.id);
			featureFlagIds.add(capability.featureFlag.id);

			expect(capability.owner.length, capability.id).toBeGreaterThan(0);
			expect(["experimental", "beta", "stable"]).toContain(capability.maturity);
			expect(["P0", "P1"]).toContain(capability.priority);
			expect(
				capability.publicDescription.trim().length,
				capability.id,
			).toBeGreaterThan(0);
			expect(typeof capability.featureFlag.defaultEnabled).toBe("boolean");

			for (const provider of capability.providerRequirements) {
				expect(provider.id.length, capability.id).toBeGreaterThan(0);
				expect(provider.description.trim().length, provider.id).toBeGreaterThan(
					0,
				);
			}
			for (const format of capability.supportedFormats) {
				expect(EXPORT_FORMATS.has(format), `${capability.id}:${format}`).toBe(
					true,
				);
			}
		}

		expect(CANVAS_RELEASE_CAPABILITY_IDS).toEqual(
			CANVAS_RELEASE_CAPABILITIES.map(({ id }) => id),
		);
		expect(Object.keys(CANVAS_RELEASE_FEATURE_FLAG_DEFAULTS)).toHaveLength(
			CANVAS_RELEASE_CAPABILITIES.length,
		);
	});

	it("declares only existing dependencies and orders them before consumers", () => {
		const seen = new Set<string>();
		for (const capability of CANVAS_RELEASE_CAPABILITIES) {
			for (const dependency of capability.dependencies) {
				expect(seen.has(dependency), `${capability.id} -> ${dependency}`).toBe(
					true,
				);
			}
			seen.add(capability.id);
		}
	});

	it("keeps gated release surfaces disabled by default", () => {
		for (const id of [
			"canvas.ai.design",
			"canvas.ai.image",
			"canvas.collaboration",
			"canvas.comments",
			"canvas.components.external",
			"canvas.components.local",
			"canvas.components.variants",
		] as const) {
			const capability = getCanvasReleaseCapability(id);
			expect(capability.featureFlag.defaultEnabled, id).toBe(false);
			expect(["experimental", "beta"]).toContain(capability.maturity);
		}
	});

	it("exposes print PDF as a default-enabled export capability", () => {
		const printPdf = getCanvasReleaseCapability("canvas.export.pdf-print");
		expect(printPdf.supportedFormats).toEqual(["pdf-print"]);
		expect(printPdf.featureFlag.defaultEnabled).toBe(true);
		expect(printPdf.maturity).toBe("beta");
	});
});
