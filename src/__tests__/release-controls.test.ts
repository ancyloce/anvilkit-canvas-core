import { describe, expect, it } from "vitest";
import {
	CANVAS_RELEASE_CAPABILITIES,
	CANVAS_RELEASE_CAPABILITY_IDS,
	CANVAS_RELEASE_FEATURE_FLAG_DEFAULTS,
} from "../release-capabilities.js";
import {
	CANVAS_MIGRATION_CONTROLS,
	CANVAS_OPERATIONAL_FLAG_DEFAULTS,
	CANVAS_RELEASE_CONTROLLED_CAPABILITY_IDS,
	CANVAS_ROLLBACK_CONTROLS,
	type CanvasReleaseControlSnapshot,
	createCanvasReleaseControls,
	evaluateCanvasReleaseCapability,
	isCanvasMigrationEnabled,
} from "../release-controls.js";

describe("Canvas release controls (E0-T6)", () => {
	it("gives every P0 capability a direct runtime kill switch", () => {
		for (const capability of CANVAS_RELEASE_CAPABILITIES) {
			if (capability.priority !== "P0") continue;
			const decision = evaluateCanvasReleaseCapability(capability.id, {
				revision: `disable:${capability.id}`,
				featureFlags: { [capability.featureFlag.id]: false },
			});
			expect(decision.enabled, capability.id).toBe(false);
			expect(decision.featureFlagEnabled, capability.id).toBe(false);
			expect(decision.featureFlagId, capability.id).toBe(
				capability.featureFlag.id,
			);
		}
	});

	it("propagates a dependency kill switch to downstream capabilities", () => {
		const decision = evaluateCanvasReleaseCapability("canvas.export.pdf", {
			revision: "editing-disabled",
			featureFlags: { "canvas.feature.editing": false },
		});
		expect(decision.enabled).toBe(false);
		expect(decision.disabledByDependencies).toEqual(["canvas.export.raster"]);
	});

	it("observes a changed host snapshot without recreating the evaluator", () => {
		let snapshot: CanvasReleaseControlSnapshot = {
			revision: "release-17",
		};
		const controls = createCanvasReleaseControls({
			getSnapshot: () => snapshot,
		});
		expect(controls.isCapabilityEnabled("canvas.export.high-resolution")).toBe(
			true,
		);

		snapshot = {
			revision: "incident-42",
			featureFlags: { "canvas.feature.export-high-resolution": false },
		};
		const decision = controls.evaluateCapability(
			"canvas.export.high-resolution",
		);
		expect(decision.enabled).toBe(false);
		expect(decision.snapshotRevision).toBe("incident-42");
	});

	it("defines executable kill switches for every supported migration", () => {
		for (const migration of CANVAS_MIGRATION_CONTROLS) {
			expect(
				isCanvasMigrationEnabled(migration.id, {
					revision: "default",
				}),
				migration.id,
			).toBe(true);
			expect(
				isCanvasMigrationEnabled(migration.id, {
					revision: `disable:${migration.id}`,
					operationalFlags: { [migration.killSwitchId]: false },
				}),
				migration.id,
			).toBe(false);
			expect(CANVAS_OPERATIONAL_FLAG_DEFAULTS[migration.killSwitchId]).toBe(
				migration.defaultEnabled,
			);
		}
	});

	it("assigns explicit disable authority and fallback behavior to E0 risks", () => {
		expect(CANVAS_ROLLBACK_CONTROLS.map(({ id }) => id).sort()).toEqual([
			"ai-design-provider",
			"ai-image-provider",
			"collaboration",
			"high-resolution-export",
			"new-ir-migrations",
		]);
		for (const control of CANVAS_ROLLBACK_CONTROLS) {
			expect(control.authorizedDisableRoles).toContain("incident-commander");
			expect(control.disabledBehavior.length, control.id).toBeGreaterThan(0);
			expect(control.verification.length, control.id).toBeGreaterThan(0);
			for (const capabilityId of control.capabilityIds) {
				expect(CANVAS_RELEASE_CAPABILITY_IDS).toContain(capabilityId);
			}
			for (const featureFlagId of control.featureFlagIds) {
				expect(CANVAS_RELEASE_FEATURE_FLAG_DEFAULTS).toHaveProperty(
					featureFlagId,
				);
			}
			for (const operationalFlagId of control.operationalFlagIds) {
				expect(CANVAS_OPERATIONAL_FLAG_DEFAULTS).toHaveProperty(
					operationalFlagId,
				);
			}
		}
		expect(CANVAS_RELEASE_CONTROLLED_CAPABILITY_IDS).toEqual(
			CANVAS_RELEASE_CAPABILITY_IDS,
		);
	});
});
