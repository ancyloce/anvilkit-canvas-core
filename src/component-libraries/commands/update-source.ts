/**
 * @file `component-instance.update-source` and `.swap-source`
 * (plan 0021 T-030/T-032, TD 0016 §12.5-§12.7 and §13).
 *
 * ## One machine, two entry points
 *
 * Update and swap are the same transaction — validate, migrate overrides,
 * rewrite refs, commit atomically — differing only in whether the component
 * *identity* may change. They share an implementation rather than being two
 * similar ones, because the failure they must both avoid (a document left half
 * migrated) is exactly what duplicated transaction code produces.
 *
 * ## Old snapshots are NOT collected here
 *
 * An update writes the new snapshot and leaves the old one in place. That is
 * deliberate (T-030 step 4): Undo must never need a Provider, so the bytes the
 * previous version resolved against have to still be in the document. Removing
 * them is an explicit, separately-previewed maintenance action
 * (`component-snapshot.collect-unused`, T-034).
 *
 * ## Explicit target list
 *
 * The command takes the instance ids it applies to rather than computing them
 * from the document, so a replay produces the same result as the original run
 * even if the document has since gained instances (§12.6). The editor
 * re-resolves the eligible set immediately before building the command and
 * re-presents the preview if it changed (§31.3).
 */

import {
	assertBrandPolicy,
	CanvasCommandError,
} from "../../commands/runtime.js";
import type {
	CommandApplyOptions,
	CommandApplyResult,
} from "../../commands/types.js";
import { updateNode } from "../../ir/mutations.js";
import { snapshotKey } from "../../ir/snapshot-key.js";
import type {
	CanvasComponentDefinition,
	CanvasComponentInstanceNode,
	CanvasComponentOverrideMap,
	CanvasExternalComponentRef,
	CanvasExternalComponentSnapshot,
	CanvasExternalComponentSnapshotRegistry,
	CanvasIR,
} from "../../ir/types.js";
import type { CanvasDocumentLocation } from "../../ir/walkers.js";
import { findNode } from "../../ir/walkers.js";
import type { CanvasValidatedExternalSnapshot } from "../admission.js";
import {
	type CanvasComponentCompatibilityReport,
	compareComponentDefinitions,
	migrateComponentOverrides,
} from "../compatibility.js";
import { validateExternalClosure } from "../dependencies.js";

export const UPDATE_SOURCE_COMMAND = "component-instance.update-source";
export const SWAP_SOURCE_COMMAND = "component-instance.swap-source";
export const REVERT_SOURCE_CHANGE_COMMAND =
	"component-instance.revert-source-change";

interface SourceChangeBase {
	/**
	 * The instances to change, named explicitly (§12.6).
	 *
	 * Never "every instance of X" computed at apply time: a replay on a document
	 * that has since gained instances would then affect more than the user
	 * previewed and approved.
	 */
	readonly instanceIds: readonly string[];
	/** The verified snapshot for the target version. */
	readonly candidate: CanvasValidatedExternalSnapshot;
	readonly dependencies?: readonly CanvasValidatedExternalSnapshot[];
	readonly location?: CanvasDocumentLocation;
}

export interface CanvasComponentUpdateSourceCommand extends SourceChangeBase {
	readonly type: typeof UPDATE_SOURCE_COMMAND;
	/**
	 * The ref being replaced. Every named instance must currently carry it —
	 * a mismatch means the preview was computed against a different document
	 * state and the command is refused rather than partly applied.
	 */
	readonly from: CanvasExternalComponentRef;
}

export interface CanvasComponentSwapSourceCommand extends SourceChangeBase {
	readonly type: typeof SWAP_SOURCE_COMMAND;
	readonly from: CanvasExternalComponentRef;
}

/** Per-instance record of what the change did, so the inverse is exact. */
interface InstanceRestore {
	readonly instanceId: string;
	readonly source: CanvasExternalComponentRef;
	readonly overrides?: CanvasComponentOverrideMap;
	readonly variantSelection?: Record<string, string>;
}

export interface CanvasComponentRevertSourceChangeCommand {
	readonly type: typeof REVERT_SOURCE_CHANGE_COMMAND;
	readonly restores: readonly InstanceRestore[];
	readonly addedSnapshotKeys: readonly string[];
	readonly location?: CanvasDocumentLocation;
	readonly redo:
		| CanvasComponentUpdateSourceCommand
		| CanvasComponentSwapSourceCommand;
}

function definitionForRef(
	ir: CanvasIR,
	ref: CanvasExternalComponentRef,
): CanvasComponentDefinition | undefined {
	try {
		return ir.externalComponentSnapshots?.[snapshotKey(ref)]?.definition;
	} catch {
		return undefined;
	}
}

/**
 * Compare the current and target definitions.
 *
 * Exported so the Editor can build the preview from exactly the same call the
 * command will make — a preview computed by different code is a preview that
 * can disagree with the commit.
 */
export function previewSourceChange(
	ir: CanvasIR,
	from: CanvasExternalComponentRef,
	to: CanvasComponentDefinition,
): CanvasComponentCompatibilityReport | undefined {
	const current = definitionForRef(ir, from);
	return current ? compareComponentDefinitions(current, to) : undefined;
}

function applySourceChange(
	ir: CanvasIR,
	cmd: CanvasComponentUpdateSourceCommand | CanvasComponentSwapSourceCommand,
	options: CommandApplyOptions,
): CommandApplyResult<CanvasComponentRevertSourceChangeCommand> {
	const isSwap = cmd.type === SWAP_SOURCE_COMMAND;
	const target = cmd.candidate.ref;

	if (cmd.instanceIds.length === 0) {
		throw new CanvasCommandError(
			"invariant-violated",
			"A source change must name at least one instance.",
		);
	}

	// An UPDATE keeps the component identity; only the version may move. A swap
	// is what may change identity, so the two are not interchangeable.
	if (
		!isSwap &&
		(target.libraryId !== cmd.from.libraryId ||
			target.componentId !== cmd.from.componentId)
	) {
		throw new CanvasCommandError(
			"invariant-violated",
			`Update may only change the version of "${cmd.from.libraryId}/${cmd.from.componentId}". Changing component identity is a swap.`,
		);
	}

	const currentDefinition = definitionForRef(ir, cmd.from);
	if (!currentDefinition) {
		throw new CanvasCommandError(
			"component-snapshot-missing",
			`No stored snapshot for the current version "${cmd.from.libraryId}/${cmd.from.componentId}@${cmd.from.version}"; nothing was changed.`,
		);
	}

	// Every named instance must currently carry `from`. Checked BEFORE any
	// mutation so a stale preview aborts instead of applying to a subset.
	const instances: CanvasComponentInstanceNode[] = [];
	for (const instanceId of cmd.instanceIds) {
		const found = findNode(ir, instanceId);
		if (!found || found.node.type !== "component-instance") {
			throw new CanvasCommandError(
				"node-not-found",
				`No component instance "${instanceId}" in this document; nothing was changed.`,
			);
		}
		const instance = found.node as CanvasComponentInstanceNode;
		const source = instance.source;
		if (
			source.kind !== "library" ||
			source.libraryId !== cmd.from.libraryId ||
			source.componentId !== cmd.from.componentId ||
			source.version !== cmd.from.version ||
			source.integrity !== cmd.from.integrity
		) {
			throw new CanvasCommandError(
				"invariant-violated",
				`Instance "${instanceId}" no longer references the version this change was previewed against; nothing was changed.`,
			);
		}
		instances.push(instance);
	}

	// Policy, per instance, after the whole batch is known to be valid and
	// BEFORE any mutation (plan 0021 M5 follow-up #1).
	//
	// Per instance rather than once for the command, because policy is an
	// intersection down each instance's own path (OD-08): a nested instance can
	// forbid what its parent permits, so asking once about the first would let
	// the rest through. And before any mutation, for the same reason the
	// `from`-check above is: a refusal must abort the batch rather than apply it
	// to a subset, which for an update across 200 instances is the difference
	// between "nothing happened" and "the document is now half-migrated".
	for (const instance of instances) {
		assertBrandPolicy(options, {
			operation: isSwap ? "source-swap" : "source-update",
			instanceId: instance.id,
			...(cmd.location !== undefined ? { location: cmd.location } : {}),
		});
	}

	const report = compareComponentDefinitions(
		currentDefinition,
		cmd.candidate.definition,
	);
	if (report.classification === "incompatible" && !isSwap) {
		throw new CanvasCommandError(
			"invariant-violated",
			`Update refused: the target version changes a property's type, so overrides cannot transfer. Use swap to change deliberately.`,
		);
	}

	// Closure first — a partial closure must abort before anything is written.
	const pending = [cmd.candidate, ...(cmd.dependencies ?? [])];
	const existing = ir.externalComponentSnapshots ?? {};
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

	// Build the next registry on a copy. The OLD snapshot stays: Undo must never
	// need a Provider (T-030 step 4).
	const nextRegistry: Record<string, CanvasExternalComponentSnapshot> = {
		...existing,
	};
	const addedSnapshotKeys: string[] = [];
	for (const snapshot of pending) {
		const key = snapshotKey(snapshot.ref);
		if (nextRegistry[key]) continue;
		nextRegistry[key] = snapshot;
		addedSnapshotKeys.push(key);
	}

	let next: CanvasIR = {
		...ir,
		externalComponentSnapshots:
			nextRegistry as CanvasExternalComponentSnapshotRegistry,
	};

	const restores: InstanceRestore[] = [];
	for (const instance of instances) {
		const migration = migrateComponentOverrides(instance.overrides, report);
		// Orphans are RETAINED alongside what transferred, so an undo — or a swap
		// back — returns the user's data (INV-6).
		const merged: CanvasComponentOverrideMap = {
			...migration.overrides,
			...migration.orphaned,
		};

		restores.push({
			instanceId: instance.id,
			source: instance.source as CanvasExternalComponentRef,
			...(instance.overrides !== undefined
				? { overrides: instance.overrides }
				: {}),
			...(instance.variantSelection !== undefined
				? { variantSelection: instance.variantSelection }
				: {}),
		});

		next = updateNode<"component-instance">(next, {
			id: instance.id,
			patch: {
				source: target,
				overrides: Object.keys(merged).length > 0 ? merged : undefined,
				// A swap may land on a component with different axes; the selection
				// is retained and re-resolved rather than reset, so a swap back
				// restores it (OD-07 collapse rule).
				...(instance.variantSelection !== undefined
					? { variantSelection: instance.variantSelection }
					: {}),
			},
			...(cmd.location !== undefined ? { location: cmd.location } : {}),
			now: options.now,
		});
	}

	return {
		ir: next,
		inverse: {
			type: REVERT_SOURCE_CHANGE_COMMAND,
			restores,
			addedSnapshotKeys,
			...(cmd.location !== undefined ? { location: cmd.location } : {}),
			redo: cmd,
		},
	};
}

function applyRevertSourceChange(
	ir: CanvasIR,
	cmd: CanvasComponentRevertSourceChangeCommand,
	options: CommandApplyOptions,
): CommandApplyResult<
	CanvasComponentUpdateSourceCommand | CanvasComponentSwapSourceCommand
> {
	let next = ir;
	for (const restore of cmd.restores) {
		next = updateNode<"component-instance">(next, {
			id: restore.instanceId,
			patch: {
				source: restore.source,
				overrides: restore.overrides,
				variantSelection: restore.variantSelection,
			},
			...(cmd.location !== undefined ? { location: cmd.location } : {}),
			now: options.now,
		});
	}

	const registry = { ...(next.externalComponentSnapshots ?? {}) };
	for (const key of cmd.addedSnapshotKeys) delete registry[key];
	next =
		Object.keys(registry).length === 0
			? (() => {
					const { externalComponentSnapshots: _empty, ...rest } = next;
					return rest as CanvasIR;
				})()
			: {
					...next,
					externalComponentSnapshots:
						registry as CanvasExternalComponentSnapshotRegistry,
				};

	return { ir: next, inverse: cmd.redo };
}

/** The three handlers, for registration through `createCanvasRuntime`. */
export function createSourceChangeCommandHandlers() {
	return [
		{ type: UPDATE_SOURCE_COMMAND, apply: applySourceChange },
		{ type: SWAP_SOURCE_COMMAND, apply: applySourceChange },
		{ type: REVERT_SOURCE_CHANGE_COMMAND, apply: applyRevertSourceChange },
	] as const;
}
