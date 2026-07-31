/**
 * @file `component-snapshot.collect-unused` (plan 0021 T-034, OD-06, TD §19).
 *
 * ## `retainedSnapshotKeys` is REQUIRED, and that is the whole design
 *
 * Undo history is Editor-owned: `stores/history-store.ts` keeps up to 100 whole
 * `CanvasIR` copies, and Core has no access to them. A GC that collected
 * everything the *current* document does not reference would therefore delete
 * snapshots that an undo step still needs, and the user would undo into a
 * document full of missing components.
 *
 * Making the parameter required rather than optional-with-a-default is what
 * prevents that: a caller cannot forget it, and a caller who genuinely has no
 * history must say so by passing an empty set. An optional parameter would have
 * made "safe" the thing you get by not thinking about it, when it is the
 * opposite.
 *
 * ## "Eligible", never "reclaimed"
 *
 * The preview reports how many bytes are **eligible** for collection. It cannot
 * say "reclaimed": the document is JSON that a host serializes however it
 * likes, so actual bytes-on-disk is not ours to claim (T-034 DoD).
 */

import { CanvasCommandError } from "../../commands/runtime.js";
import type {
	CommandApplyOptions,
	CommandApplyResult,
} from "../../commands/types.js";
import type {
	CanvasExternalComponentSnapshot,
	CanvasExternalComponentSnapshotRegistry,
	CanvasIR,
} from "../../ir/types.js";
import { collectReferencedSnapshotKeys } from "../reference-index.js";

export const COLLECT_UNUSED_COMMAND = "component-snapshot.collect-unused";
export const RESTORE_COLLECTED_COMMAND = "component-snapshot.restore-collected";

export interface CanvasComponentCollectUnusedCommand {
	readonly type: typeof COLLECT_UNUSED_COMMAND;
	/**
	 * Keys that must survive regardless of document reachability — the Editor's
	 * undo/redo closure. **Required**: see the module header.
	 */
	readonly retainedSnapshotKeys: ReadonlySet<string>;
}

export interface CanvasComponentRestoreCollectedCommand {
	readonly type: typeof RESTORE_COLLECTED_COMMAND;
	/** The exact entries removed, so undo restores them byte-for-byte. */
	readonly removed: Readonly<Record<string, CanvasExternalComponentSnapshot>>;
}

/** What a collection WOULD do. Pure; the dialog renders this before committing. */
export interface CanvasCollectionPreview {
	/** Keys that would be removed, sorted. */
	readonly eligibleKeys: readonly string[];
	/**
	 * Approximate serialized size of those entries.
	 *
	 * Named `eligibleBytes`, never `reclaimedBytes`: this is the size of the JSON
	 * this command would drop, not a promise about a file on disk.
	 */
	readonly eligibleBytes: number;
	/** Keys kept only because `retainedSnapshotKeys` asked for them. */
	readonly retainedOnlyByHistory: readonly string[];
}

/**
 * Compute what a collection would remove, without removing it.
 *
 * Exported so the dialog and the command agree by construction rather than by
 * two implementations that might drift.
 */
export function previewCollectUnused(
	ir: CanvasIR,
	retainedSnapshotKeys: ReadonlySet<string>,
): CanvasCollectionPreview {
	const registry = ir.externalComponentSnapshots ?? {};
	const referenced = collectReferencedSnapshotKeys(ir);

	const eligibleKeys: string[] = [];
	const retainedOnlyByHistory: string[] = [];
	let eligibleBytes = 0;

	for (const key of Object.keys(registry).sort()) {
		if (referenced.has(key)) continue;
		if (retainedSnapshotKeys.has(key)) {
			retainedOnlyByHistory.push(key);
			continue;
		}
		eligibleKeys.push(key);
		eligibleBytes += JSON.stringify(registry[key]).length;
	}

	return { eligibleKeys, eligibleBytes, retainedOnlyByHistory };
}

function applyCollectUnused(
	ir: CanvasIR,
	cmd: CanvasComponentCollectUnusedCommand,
	_options: CommandApplyOptions,
): CommandApplyResult<CanvasComponentRestoreCollectedCommand> {
	if (!(cmd.retainedSnapshotKeys instanceof Set)) {
		// A caller that omitted it would otherwise collect the whole history
		// closure. Failing loudly beats silently deleting undo state.
		throw new CanvasCommandError(
			"invariant-violated",
			"collect-unused requires an explicit `retainedSnapshotKeys` set (pass an empty Set if there is genuinely no history).",
		);
	}

	const registry = ir.externalComponentSnapshots ?? {};
	const { eligibleKeys } = previewCollectUnused(ir, cmd.retainedSnapshotKeys);
	if (eligibleKeys.length === 0) {
		return {
			ir,
			inverse: { type: RESTORE_COLLECTED_COMMAND, removed: {} },
		};
	}

	const next: Record<string, CanvasExternalComponentSnapshot> = { ...registry };
	const removed: Record<string, CanvasExternalComponentSnapshot> = {};
	for (const key of eligibleKeys) {
		const entry = next[key];
		if (!entry) continue;
		removed[key] = entry;
		delete next[key];
	}

	return {
		ir:
			Object.keys(next).length === 0
				? (() => {
						const { externalComponentSnapshots: _empty, ...rest } = ir;
						return rest as CanvasIR;
					})()
				: {
						...ir,
						externalComponentSnapshots:
							next as CanvasExternalComponentSnapshotRegistry,
					},
		inverse: { type: RESTORE_COLLECTED_COMMAND, removed },
	};
}

function applyRestoreCollected(
	ir: CanvasIR,
	cmd: CanvasComponentRestoreCollectedCommand,
	_options: CommandApplyOptions,
): CommandApplyResult<CanvasComponentCollectUnusedCommand> {
	const restoredKeys = Object.keys(cmd.removed);
	const next: CanvasIR =
		restoredKeys.length === 0
			? ir
			: {
					...ir,
					externalComponentSnapshots: {
						...(ir.externalComponentSnapshots ?? {}),
						...cmd.removed,
					} as CanvasExternalComponentSnapshotRegistry,
				};

	return {
		ir: next,
		// Redoing the collection must not re-derive the eligible set from a
		// document that has since changed; it names exactly what was removed.
		inverse: {
			type: COLLECT_UNUSED_COMMAND,
			retainedSnapshotKeys: new Set<string>(),
		},
	};
}

export function createCollectUnusedCommandHandlers() {
	return [
		{ type: COLLECT_UNUSED_COMMAND, apply: applyCollectUnused },
		{ type: RESTORE_COLLECTED_COMMAND, apply: applyRestoreCollected },
	] as const;
}
