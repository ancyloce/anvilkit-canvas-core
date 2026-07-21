import type { CanvasIR } from "../ir/types.js";
import {
	type CanvasChange,
	type CanvasChangeRecord,
	type CanvasChangeSource,
	commandToChange,
	commandToChangeRecord,
} from "./change-events.js";
import { applyCommand } from "./runtime.js";
import type {
	CanvasBatchCommand,
	CanvasCommand,
	CommandApplyOptions,
} from "./types.js";

export interface TransactionApplyResult {
	ir: CanvasIR;
	/** A single composite inverse (a `batch`) for the history stack. */
	inverse: CanvasBatchCommand;
	/** Per-command change records, in apply order. */
	changes: CanvasChange[];
	/** Per-command enriched, persistable/replayable records (FR-070), in apply order. */
	records: CanvasChangeRecord[];
}

export interface ApplyCommandsOptions extends CommandApplyOptions {
	label?: string;
	/** Who applied this transaction. Forwarded to every record. Defaults to `"local"`. */
	actorId?: string;
	/** `"remote"` records may bypass a host's local undo stack. Defaults to `"local"`. */
	source?: CanvasChangeSource;
	/** Base sequence for this transaction; each command's record gets `sequence + index`. Defaults to `0`. */
	sequence?: number;
	/** Injectable id factory for each record's `commandId`. Defaults to `crypto.randomUUID`. */
	commandIdFactory?: () => string;
}

/**
 * Apply many commands as one reversible transaction — all-or-nothing, in
 * order, in a single fold over a local `working` IR. The caller's `ir` is
 * never mutated; a throw from any sub-command propagates before `working`/the
 * inverses/records are used, so nothing partial escapes.
 *
 * Each command's change record is derived from `working` as it stood
 * immediately BEFORE that command applied (not the transaction's original
 * `ir`) — required for commands whose record resolution depends on IR state a
 * prior command in the same transaction just created (e.g. `node.move`
 * following the `node.create` that made the node exist).
 */
export function applyCommands(
	ir: CanvasIR,
	commands: readonly CanvasCommand[],
	options: ApplyCommandsOptions = {},
): TransactionApplyResult {
	const {
		label,
		actorId,
		source,
		sequence,
		commandIdFactory,
		...applyOptions
	} = options;
	let working = ir;
	let nextSequence = sequence ?? 0;
	const changes: CanvasChange[] = [];
	const records: CanvasChangeRecord[] = [];

	// Recurses into nested `batch` commands so every LEAF sub-command gets its
	// own change/record — `commandToChange`/`commandToChangeRecord` return
	// `null` for `"batch"` on the assumption that this function maps
	// sub-commands individually (see their docstrings); a flat `.forEach`
	// over just the top-level `commands` broke that contract for a batch
	// nested inside `commands` (C-3).
	const applyOne = (cmd: CanvasCommand): CanvasCommand => {
		if (cmd.type === "batch") {
			const nestedInverses = cmd.commands.map(applyOne);
			nestedInverses.reverse();
			return {
				type: "batch",
				...(cmd.label !== undefined ? { label: cmd.label } : {}),
				commands: nestedInverses,
			};
		}
		const change = commandToChange(cmd);
		if (change !== null) changes.push(change);
		const record = commandToChangeRecord(cmd, working, {
			...applyOptions,
			actorId,
			source,
			sequence: nextSequence++,
			commandIdFactory,
		});
		if (record !== null) records.push(record);
		const result = applyCommand(working, cmd, applyOptions);
		working = result.ir;
		return result.inverse;
	};

	const inverses = commands.map(applyOne);
	inverses.reverse();
	const inverse: CanvasBatchCommand = {
		type: "batch",
		...(label !== undefined ? { label } : {}),
		commands: inverses,
	};
	return { ir: working, inverse, changes, records };
}
