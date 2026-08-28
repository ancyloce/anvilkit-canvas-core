import {
	CANVAS_RELEASE_CAPABILITIES,
	CANVAS_RELEASE_FEATURE_FLAG_DEFAULTS,
	type CanvasCapabilityOwner,
	type CanvasFeatureFlagId,
	type CanvasReleaseCapabilityId,
	getCanvasReleaseCapability,
} from "./release-capabilities.js";

/** Non-capability switches used to stop risky release operations at runtime. */
export type CanvasOperationalFlagId =
	| "canvas.operation.migration-v1-to-v2"
	| "canvas.operation.migration-v2-to-v3";

/** Stable IDs for versioned Canvas IR migration steps. */
export type CanvasMigrationControlId =
	| "canvas-ir.v1-to-v2"
	| "canvas-ir.v2-to-v3";

/** Defaults used when the host's live control snapshot has no override. */
export const CANVAS_OPERATIONAL_FLAG_DEFAULTS = Object.freeze({
	"canvas.operation.migration-v1-to-v2": true,
	"canvas.operation.migration-v2-to-v3": true,
} satisfies Record<CanvasOperationalFlagId, boolean>);

export interface CanvasMigrationControl {
	readonly id: CanvasMigrationControlId;
	readonly owner: "canvas-core";
	readonly killSwitchId: CanvasOperationalFlagId;
	readonly defaultEnabled: boolean;
	readonly description: string;
}

/** Executable ownership for every migration step supported by this release. */
export const CANVAS_MIGRATION_CONTROLS = [
	{
		id: "canvas-ir.v1-to-v2",
		owner: "canvas-core",
		killSwitchId: "canvas.operation.migration-v1-to-v2",
		defaultEnabled: true,
		description: "Migrate Canvas IR version 1 documents to version 2 on read.",
	},
	{
		id: "canvas-ir.v2-to-v3",
		owner: "canvas-core",
		killSwitchId: "canvas.operation.migration-v2-to-v3",
		defaultEnabled: true,
		description: "Migrate Canvas IR version 2 documents to version 3 on read.",
	},
] as const satisfies readonly CanvasMigrationControl[];

export type CanvasRollbackSurfaceId =
	| "ai-design-provider"
	| "ai-image-provider"
	| "collaboration"
	| "high-resolution-export"
	| "new-ir-migrations";

/** Named operational roles permitted to activate a release kill switch. */
export type CanvasRollbackAuthority =
	| "ai-on-call"
	| "canvas-core-on-call"
	| "canvas-editor-on-call"
	| "collaboration-on-call"
	| "incident-commander";

export interface CanvasRollbackControl {
	readonly id: CanvasRollbackSurfaceId;
	readonly owner: CanvasCapabilityOwner;
	readonly capabilityIds: readonly CanvasReleaseCapabilityId[];
	readonly featureFlagIds: readonly CanvasFeatureFlagId[];
	readonly operationalFlagIds: readonly CanvasOperationalFlagId[];
	readonly authorizedDisableRoles: readonly CanvasRollbackAuthority[];
	readonly disabledBehavior: string;
	readonly verification: string;
}

/**
 * Reviewable ownership and rollback behavior for the E0 high-risk surfaces.
 *
 * Hosts should grant write access to the listed live flags only to the named
 * roles. `incident-commander` is deliberately present on every row so a
 * cross-team incident never waits for a package owner to publish a release.
 */
export const CANVAS_ROLLBACK_CONTROLS = [
	{
		id: "collaboration",
		owner: "collaboration",
		capabilityIds: ["canvas.collaboration", "canvas.comments"],
		featureFlagIds: ["canvas.feature.collaboration", "canvas.feature.comments"],
		operationalFlagIds: [],
		authorizedDisableRoles: ["collaboration-on-call", "incident-commander"],
		disabledBehavior:
			"Stop new collaboration sessions and comments while preserving local editing and persistence.",
		verification:
			"Confirm new sessions remain local-only and no collaboration provider connection is opened.",
	},
	{
		id: "ai-image-provider",
		owner: "ai",
		capabilityIds: ["canvas.ai.image"],
		featureFlagIds: ["canvas.feature.ai-image"],
		operationalFlagIds: [],
		authorizedDisableRoles: ["ai-on-call", "incident-commander"],
		disabledBehavior:
			"Reject new AI image jobs without affecting existing hosted assets or manual image insertion.",
		verification:
			"Confirm the AI image action is unavailable and no provider job is started.",
	},
	{
		id: "ai-design-provider",
		owner: "ai",
		capabilityIds: ["canvas.ai.design"],
		featureFlagIds: ["canvas.feature.ai-design"],
		operationalFlagIds: [],
		authorizedDisableRoles: ["ai-on-call", "incident-commander"],
		disabledBehavior:
			"Reject new AI design jobs while retaining deterministic templates and manual editing.",
		verification:
			"Confirm the AI design action is unavailable and no provider job is started.",
	},
	{
		id: "high-resolution-export",
		owner: "canvas-editor",
		capabilityIds: ["canvas.export.high-resolution"],
		featureFlagIds: ["canvas.feature.export-high-resolution"],
		operationalFlagIds: [],
		authorizedDisableRoles: ["canvas-editor-on-call", "incident-commander"],
		disabledBehavior:
			"Remove high-resolution choices while retaining standard raster export.",
		verification:
			"Confirm standard export remains available and high-resolution requests are rejected before rendering.",
	},
	{
		id: "new-ir-migrations",
		owner: "canvas-core",
		capabilityIds: ["canvas.persistence"],
		featureFlagIds: [],
		operationalFlagIds: ["canvas.operation.migration-v2-to-v3"],
		authorizedDisableRoles: ["canvas-core-on-call", "incident-commander"],
		disabledBehavior:
			"Stop the newest migration step and fail closed before a source document is rewritten.",
		verification:
			"Confirm version 2 input is rejected with migration-disabled classification and remains byte-for-byte unchanged.",
	},
] as const satisfies readonly CanvasRollbackControl[];

/** A host-fetched snapshot. Changing it never requires publishing a package. */
export interface CanvasReleaseControlSnapshot {
	readonly revision: string;
	readonly featureFlags?: Readonly<
		Partial<Record<CanvasFeatureFlagId, boolean>>
	>;
	readonly operationalFlags?: Readonly<
		Partial<Record<CanvasOperationalFlagId, boolean>>
	>;
}

/** Live source read for every evaluation, rather than captured at startup. */
export interface CanvasReleaseControlSource {
	getSnapshot(): CanvasReleaseControlSnapshot;
}

export interface CanvasReleaseCapabilityDecision {
	readonly capabilityId: CanvasReleaseCapabilityId;
	readonly enabled: boolean;
	readonly featureFlagId: CanvasFeatureFlagId;
	readonly featureFlagEnabled: boolean;
	readonly disabledByDependencies: readonly CanvasReleaseCapabilityId[];
	readonly snapshotRevision: string;
}

/** Evaluate a capability flag and its complete dependency chain. */
export function evaluateCanvasReleaseCapability(
	capabilityId: CanvasReleaseCapabilityId,
	snapshot: CanvasReleaseControlSnapshot,
): CanvasReleaseCapabilityDecision {
	const memo = new Map<
		CanvasReleaseCapabilityId,
		CanvasReleaseCapabilityDecision
	>();
	const visiting = new Set<CanvasReleaseCapabilityId>();

	const visit = (
		id: CanvasReleaseCapabilityId,
	): CanvasReleaseCapabilityDecision => {
		const cached = memo.get(id);
		if (cached) return cached;
		if (visiting.has(id)) {
			throw new Error(`Canvas release capability dependency cycle at ${id}`);
		}
		visiting.add(id);
		const capability = getCanvasReleaseCapability(id);
		const featureFlagEnabled =
			snapshot.featureFlags?.[capability.featureFlag.id] ??
			CANVAS_RELEASE_FEATURE_FLAG_DEFAULTS[capability.featureFlag.id];
		const disabledByDependencies = capability.dependencies.filter(
			(dependencyId) => !visit(dependencyId).enabled,
		);
		const decision: CanvasReleaseCapabilityDecision = {
			capabilityId: id,
			enabled: featureFlagEnabled && disabledByDependencies.length === 0,
			featureFlagId: capability.featureFlag.id,
			featureFlagEnabled,
			disabledByDependencies,
			snapshotRevision: snapshot.revision,
		};
		visiting.delete(id);
		memo.set(id, decision);
		return decision;
	};

	return visit(capabilityId);
}

/** Resolve whether one versioned migration step may run in this snapshot. */
export function isCanvasMigrationEnabled(
	migrationId: CanvasMigrationControlId,
	snapshot: CanvasReleaseControlSnapshot,
): boolean {
	const migration = CANVAS_MIGRATION_CONTROLS.find(
		(candidate) => candidate.id === migrationId,
	);
	if (!migration)
		throw new Error(`Unknown Canvas migration control: ${migrationId}`);
	return (
		snapshot.operationalFlags?.[migration.killSwitchId] ??
		CANVAS_OPERATIONAL_FLAG_DEFAULTS[migration.killSwitchId]
	);
}

export interface CanvasReleaseControls {
	evaluateCapability(
		capabilityId: CanvasReleaseCapabilityId,
	): CanvasReleaseCapabilityDecision;
	isCapabilityEnabled(capabilityId: CanvasReleaseCapabilityId): boolean;
	isMigrationEnabled(migrationId: CanvasMigrationControlId): boolean;
}

/**
 * Create a live evaluator whose next call observes the source's latest
 * revision. The source is host-owned, so an incident rollback is a remote
 * configuration write rather than a new Canvas package release.
 */
export function createCanvasReleaseControls(
	source: CanvasReleaseControlSource,
): CanvasReleaseControls {
	return {
		evaluateCapability(capabilityId) {
			return evaluateCanvasReleaseCapability(
				capabilityId,
				source.getSnapshot(),
			);
		},
		isCapabilityEnabled(capabilityId) {
			return evaluateCanvasReleaseCapability(capabilityId, source.getSnapshot())
				.enabled;
		},
		isMigrationEnabled(migrationId) {
			return isCanvasMigrationEnabled(migrationId, source.getSnapshot());
		},
	};
}

/** Feature flags declared by the release registry, useful to control planes. */
export const CANVAS_RELEASE_CONTROLLED_CAPABILITY_IDS =
	CANVAS_RELEASE_CAPABILITIES.map(({ id }) => id);
