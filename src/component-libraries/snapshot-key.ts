/**
 * Snapshot-registry key codec — re-export shim (plan 0021 T-005, relocated in T-014).
 *
 * The codec moved to `../ir/snapshot-key.js` (rank 1) because
 * `CanvasIR.externalComponentSnapshots` is keyed by these strings and
 * `ir/validators.ts` must assert `key === snapshotKey(entry.ref)` — rank 1 cannot
 * import upward from this rank-4 domain. See that module for the full rationale
 * and `docs/architecture/src-layer-map.md` for the constraint it satisfies.
 *
 * This file remains the public door: `@anvilkit/canvas-core/component-libraries`
 * exports the codec through here, so the published surface is unchanged.
 */

export {
	isSnapshotKey,
	parseSnapshotKey,
	SnapshotKeySchema,
	snapshotKey,
} from "../ir/snapshot-key.js";
