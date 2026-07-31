/**
 * @file `component-snapshot.recover` (plan 0021 T-023, TD 0016 §17.3).
 *
 * ## Repair the snapshot, touch nothing else
 *
 * When a document's snapshot registry is missing an entry — a document shared
 * without its snapshots, a GC that went too far, a hand-edited file — every
 * instance of that component renders as a selectable placeholder with its
 * overrides retained (plan 0021 T-016). Recovery re-fetches the bytes and puts
 * them back.
 *
 * What it must NOT do is the whole point. It never touches the instance: not its
 * `source` ref, not its overrides, not its variant selection, not its placement.
 * A "recovery" that quietly rewrote instances to a version that happened to be
 * available would silently restyle a document the user believed they were
 * repairing.
 *
 * ## Recovery is exact-version only
 *
 * The command stores a snapshot under the key its own ref derives. It cannot
 * substitute a different version, because a different version has a different
 * key and would leave the original still missing — a *swap* is a separate,
 * explicit, previewable operation (T-032, M3). This is enforced rather than
 * documented: `expectedRef` is compared to the candidate's ref.
 *
 * Registered through the extension seam for the same rank-4 reason as
 * `insert-external.ts`.
 */

import { CanvasCommandError } from "../../commands/runtime.js";
import type {
	CommandApplyOptions,
	CommandApplyResult,
} from "../../commands/types.js";
import { componentSourceRefsEqual } from "../../ir/component-source.js";
import { snapshotKey } from "../../ir/snapshot-key.js";
import type {
	CanvasExternalComponentRef,
	CanvasExternalComponentSnapshot,
	CanvasExternalComponentSnapshotRegistry,
	CanvasIR,
} from "../../ir/types.js";
import type { CanvasValidatedExternalSnapshot } from "../admission.js";
import { validateExternalClosure } from "../dependencies.js";

export const RECOVER_SNAPSHOT_COMMAND = "component-snapshot.recover";
export const UNRECOVER_SNAPSHOT_COMMAND = "component-snapshot.unrecover";

export interface CanvasComponentRecoverSnapshotCommand {
	readonly type: typeof RECOVER_SNAPSHOT_COMMAND;
	/** The verified snapshot to restore. */
	readonly candidate: CanvasValidatedExternalSnapshot;
	/**
	 * The reference the document's instances are actually pointing at.
	 *
	 * Checked against `candidate.ref`, so recovery can never quietly substitute
	 * a different version for the one the document asked for.
	 */
	readonly expectedRef: CanvasExternalComponentRef;
	/** Verified snapshots for any dependencies that are also missing. */
	readonly dependencies?: readonly CanvasValidatedExternalSnapshot[];
}

export interface CanvasComponentUnrecoverSnapshotCommand {
	readonly type: typeof UNRECOVER_SNAPSHOT_COMMAND;
	/** Exactly the keys this recovery added — see the DoD. */
	readonly addedSnapshotKeys: readonly string[];
	readonly redo: CanvasComponentRecoverSnapshotCommand;
}

function applyRecoverSnapshot(
	ir: CanvasIR,
	cmd: CanvasComponentRecoverSnapshotCommand,
	_options: CommandApplyOptions,
): CommandApplyResult<CanvasComponentUnrecoverSnapshotCommand> {
	if (!componentSourceRefsEqual(cmd.expectedRef, cmd.candidate.ref)) {
		throw new CanvasCommandError(
			"component-integrity-mismatch",
			`Recovery is exact-version only: the document references "${cmd.expectedRef.libraryId}/${cmd.expectedRef.componentId}@${cmd.expectedRef.version}" but the fetched snapshot is a different reference. Use swap to change version deliberately.`,
		);
	}

	const existing = ir.externalComponentSnapshots ?? {};
	const pending = [cmd.candidate, ...(cmd.dependencies ?? [])];

	const closureProblem = validateExternalClosure(
		cmd.candidate,
		{
			get: (ref) => {
				try {
					return existing[snapshotKey(ref)];
				} catch {
					return undefined;
				}
			},
		},
		{ pending },
	);
	if (closureProblem) {
		throw new CanvasCommandError(
			closureProblem.code === "component-dependency-missing"
				? "component-dependency-missing"
				: "invariant-violated",
			`${closureProblem.code}: ${closureProblem.message}`,
		);
	}

	const registry: Record<string, CanvasExternalComponentSnapshot> = {
		...existing,
	};
	const addedSnapshotKeys: string[] = [];
	for (const snapshot of pending) {
		const key = snapshotKey(snapshot.ref);
		// Already present means someone else recovered it first (or it was never
		// missing). That is a no-op, not an error — recovery is idempotent so a
		// double-click cannot produce two Undo entries with different effects.
		if (registry[key]) continue;
		registry[key] = snapshot;
		addedSnapshotKeys.push(key);
	}

	return {
		ir: {
			...ir,
			externalComponentSnapshots:
				registry as CanvasExternalComponentSnapshotRegistry,
		},
		inverse: {
			type: UNRECOVER_SNAPSHOT_COMMAND,
			addedSnapshotKeys,
			redo: cmd,
		},
	};
}

function applyUnrecoverSnapshot(
	ir: CanvasIR,
	cmd: CanvasComponentUnrecoverSnapshotCommand,
	_options: CommandApplyOptions,
): CommandApplyResult<CanvasComponentRecoverSnapshotCommand> {
	const registry = { ...(ir.externalComponentSnapshots ?? {}) };
	// ONLY the keys this recovery added (T-023 DoD). A recovery that reused an
	// already-present snapshot must not remove it on undo — another instance
	// still resolves against it.
	for (const key of cmd.addedSnapshotKeys) delete registry[key];

	const next: CanvasIR =
		Object.keys(registry).length === 0
			? (() => {
					const { externalComponentSnapshots: _empty, ...rest } = ir;
					return rest as CanvasIR;
				})()
			: {
					...ir,
					externalComponentSnapshots:
						registry as CanvasExternalComponentSnapshotRegistry,
				};

	return { ir: next, inverse: cmd.redo };
}

/** The recovery handler pair, for registration through `createCanvasRuntime`. */
export function createSnapshotRecoveryCommandHandlers() {
	return [
		{ type: RECOVER_SNAPSHOT_COMMAND, apply: applyRecoverSnapshot },
		{ type: UNRECOVER_SNAPSHOT_COMMAND, apply: applyUnrecoverSnapshot },
	] as const;
}
