/**
 * @file `component-instance.insert-external` (plan 0021 T-021, TD 0016 §8.2).
 *
 * ## Why this is an EXTENSION command and not a built-in
 *
 * The command carries a {@link CanvasValidatedExternalSnapshot} — a branded type
 * declared in `component-libraries/admission.ts` at rank 4. `commands/` is rank
 * 3 and cannot import upward (`scripts/check-layering.mjs`), so this command
 * cannot be a member of the built-in `CanvasCommand` union no matter how it is
 * written. It registers through the extension seam instead
 * (`CanvasExtension.commands` -> `createCanvasRuntime`), which is the mechanism
 * that exists for exactly this. M0's ledger predicted this; the plan's
 * "Modify `commands/runtime.ts`" step is not implementable.
 *
 * Requiring the branded type is the point: "was this snapshot verified?" is
 * answered by the compiler, not by a runtime flag a caller could set or by
 * trusting that admission ran first.
 *
 * ## Atomic, and synchronous
 *
 * One snapshot (plus any dependencies), one instance, one Undo entry. Every
 * check here is synchronous — verification already happened asynchronously in
 * `admitExternalSnapshot`, which is why the two phases exist. Nothing mutates
 * until every check has passed, so a rejected insert leaves the document
 * byte-identical.
 */

import { CanvasCommandError } from "../../commands/runtime.js";
import type {
	CommandApplyOptions,
	CommandApplyResult,
} from "../../commands/types.js";
import { createComponentInstance } from "../../ir/builders.js";
import { componentSourceRefsEqual } from "../../ir/component-source.js";
import { insertNode, removeNode } from "../../ir/mutations.js";
import { snapshotKey } from "../../ir/snapshot-key.js";
import type {
	CanvasBounds,
	CanvasComponentOverrideMap,
	CanvasExternalComponentRef,
	CanvasExternalComponentSnapshot,
	CanvasExternalComponentSnapshotRegistry,
	CanvasIR,
	CanvasLayoutItem,
	CanvasTransform,
} from "../../ir/types.js";
import type { CanvasDocumentLocation } from "../../ir/walkers.js";
import type { CanvasValidatedExternalSnapshot } from "../admission.js";
import { canonicalizeComponentPayloadToString } from "../canonicalize.js";
import { validateExternalClosure } from "../dependencies.js";

export const INSERT_EXTERNAL_COMMAND = "component-instance.insert-external";
export const REVERT_EXTERNAL_INSERT_COMMAND =
	"component-instance.revert-external-insert";

export interface CanvasComponentInsertExternalCommand {
	readonly type: typeof INSERT_EXTERNAL_COMMAND;
	/** The verified snapshot to store. Only `admitExternalSnapshot` can make one. */
	readonly candidate: CanvasValidatedExternalSnapshot;
	/**
	 * Verified snapshots for the candidate's dependency closure.
	 *
	 * Admitted in the same transaction, so they are validated together and
	 * committed together — a closure that is only partly present would render a
	 * hole inside an otherwise-correct component.
	 */
	readonly dependencies?: readonly CanvasValidatedExternalSnapshot[];
	/**
	 * The reference the INSTANCE will carry.
	 *
	 * Deliberately redundant with `candidate.ref` and checked for deep equality:
	 * without the check, a caller could store one component's bytes and point the
	 * instance at another's identity, and every individual field would still
	 * validate (TD §22.1).
	 */
	readonly source: CanvasExternalComponentRef;
	readonly instanceId: string;
	readonly bounds: CanvasBounds;
	readonly transform?: Partial<CanvasTransform>;
	readonly overrides?: CanvasComponentOverrideMap;
	readonly name?: string;
	readonly layoutItem?: CanvasLayoutItem;
	readonly parentId?: string;
	readonly index?: number;
	readonly location?: CanvasDocumentLocation;
}

export interface CanvasComponentRevertExternalInsertCommand {
	readonly type: typeof REVERT_EXTERNAL_INSERT_COMMAND;
	readonly instanceId: string;
	readonly location?: CanvasDocumentLocation;
	/**
	 * Keys this insert ADDED. Snapshots it reused are absent, so undoing an
	 * insert that reused an existing snapshot never removes one another instance
	 * still depends on.
	 */
	readonly addedSnapshotKeys: readonly string[];
	/** The command to replay for redo. */
	readonly redo: CanvasComponentInsertExternalCommand;
}

/**
 * Canonical bytes of a snapshot's identity-bearing content, for byte-identity
 * comparison. Excludes `fetchedAt` — two fetches of the same component at
 * different times are the same snapshot.
 */
function identityOf(snapshot: CanvasExternalComponentSnapshot): string {
	return canonicalizeComponentPayloadToString({
		ref: snapshot.ref,
		definition: snapshot.definition,
		dependencies: snapshot.dependencies,
		canonicalFormatVersion: snapshot.canonicalFormatVersion,
	});
}

/**
 * Merge one snapshot into the registry.
 *
 * Returns the key when the entry is NEW, or `null` when an identical entry was
 * already present (reuse). Throws when the key is taken by different content.
 */
function admitInto(
	registry: Record<string, CanvasExternalComponentSnapshot>,
	snapshot: CanvasExternalComponentSnapshot,
): string | null {
	const key = snapshotKey(snapshot.ref);
	const existing = registry[key];
	if (existing) {
		if (identityOf(existing) !== identityOf(snapshot)) {
			// A key embeds the integrity digest, so equal keys should imply equal
			// bytes. Reaching here means a stored snapshot disagrees with its own
			// digest — a corrupted or hand-edited document. Refusing beats
			// overwriting content other instances already resolve against.
			throw new CanvasCommandError(
				"component-integrity-mismatch",
				`Snapshot "${key}" already exists with different content. The same reference cannot name two different components; nothing was inserted.`,
			);
		}
		return null;
	}
	registry[key] = snapshot;
	return key;
}

function applyInsertExternal(
	ir: CanvasIR,
	cmd: CanvasComponentInsertExternalCommand,
	options: CommandApplyOptions,
): CommandApplyResult<CanvasComponentRevertExternalInsertCommand> {
	// 1. Identity: the instance must point at exactly what is being stored.
	if (!componentSourceRefsEqual(cmd.source, cmd.candidate.ref)) {
		throw new CanvasCommandError(
			"component-integrity-mismatch",
			`Insert refuses to store one component's content under another's reference: instance source and verified candidate differ.`,
		);
	}

	// 2. Closure, against the document PLUS everything admitted in this
	//    transaction. Runs before any mutation so a partial closure inserts
	//    nothing at all.
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
		// Only `component-dependency-missing` is a plan-0021 ABORT code
		// (`CanvasCommandErrorCode`); `component-snapshot-invalid` is deliberately
		// diagnostic-only, because a structurally invalid snapshot is supposed to
		// have been refused at admission. If one reaches here anyway the document
		// invariant is what broke, so the pre-existing generic abort code is the
		// honest one — and the diagnostic code is kept in the message rather than
		// widening a public union to say it.
		throw new CanvasCommandError(
			closureProblem.code === "component-dependency-missing"
				? "component-dependency-missing"
				: "invariant-violated",
			`${closureProblem.code}: ${closureProblem.message}`,
		);
	}

	// 3. Build the next registry on a COPY. Nothing observable has changed yet,
	//    so a throw from `admitInto` leaves `ir` untouched.
	const nextRegistry: Record<string, CanvasExternalComponentSnapshot> = {
		...existing,
	};
	const addedSnapshotKeys: string[] = [];
	for (const snapshot of pending) {
		const added = admitInto(nextRegistry, snapshot);
		if (added !== null) addedSnapshotKeys.push(added);
	}

	// 4. The instance itself.
	const node = createComponentInstance({
		id: cmd.instanceId,
		source: cmd.source,
		bounds: cmd.bounds,
		...(cmd.transform !== undefined ? { transform: cmd.transform } : {}),
		...(cmd.overrides !== undefined ? { overrides: cmd.overrides } : {}),
		...(cmd.name !== undefined ? { name: cmd.name } : {}),
		...(cmd.layoutItem !== undefined ? { layoutItem: cmd.layoutItem } : {}),
	});
	const withSnapshots: CanvasIR = {
		...ir,
		externalComponentSnapshots:
			nextRegistry as CanvasExternalComponentSnapshotRegistry,
	};
	const next = insertNode(withSnapshots, {
		parentId: cmd.parentId ?? (withSnapshots.pages[0]?.root.id as string),
		node,
		...(cmd.index !== undefined ? { index: cmd.index } : {}),
		...(cmd.location !== undefined ? { location: cmd.location } : {}),
		now: options.now,
	});

	return {
		ir: next,
		inverse: {
			type: REVERT_EXTERNAL_INSERT_COMMAND,
			instanceId: cmd.instanceId,
			...(cmd.location !== undefined ? { location: cmd.location } : {}),
			addedSnapshotKeys,
			redo: cmd,
		},
	};
}

function applyRevertExternalInsert(
	ir: CanvasIR,
	cmd: CanvasComponentRevertExternalInsertCommand,
	options: CommandApplyOptions,
): CommandApplyResult<CanvasComponentInsertExternalCommand> {
	const withoutNode = removeNode(ir, {
		id: cmd.instanceId,
		...(cmd.location !== undefined ? { location: cmd.location } : {}),
		now: options.now,
	});

	const registry = { ...(withoutNode.externalComponentSnapshots ?? {}) };
	for (const key of cmd.addedSnapshotKeys) delete registry[key];

	// INV-10: an empty registry normalizes to omission, so undoing the only
	// external insert in a document restores it byte-identically to before.
	const next: CanvasIR =
		Object.keys(registry).length === 0
			? (() => {
					const { externalComponentSnapshots: _empty, ...rest } = withoutNode;
					return rest as CanvasIR;
				})()
			: {
					...withoutNode,
					externalComponentSnapshots:
						registry as CanvasExternalComponentSnapshotRegistry,
				};

	return { ir: next, inverse: cmd.redo };
}

/**
 * The two handlers, as an extension bundle fragment.
 *
 * Exposed as a factory rather than a frozen array so a host registering them
 * twice gets two distinct objects and the registry's duplicate guard reports
 * the real problem (`duplicate-command`) rather than an identity coincidence.
 */
export function createExternalInsertCommandHandlers() {
	return [
		{
			type: INSERT_EXTERNAL_COMMAND,
			apply: applyInsertExternal,
		},
		{
			type: REVERT_EXTERNAL_INSERT_COMMAND,
			apply: applyRevertExternalInsert,
		},
	] as const;
}
