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
 * Apply many commands as one reversible transaction. Wraps them in a `batch`
 * command (so application is all-or-nothing and the inverse is a single
 * composite) and additionally derives the granular change records. The caller's
 * `ir` is never mutated; a throw from any sub-command propagates without partial
 * application.
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
	const batch: CanvasBatchCommand = {
		type: "batch",
		...(label !== undefined ? { label } : {}),
		commands: [...commands],
	};
	const result = applyCommand(ir, batch, applyOptions);
	const changes = commands
		.map(commandToChange)
		.filter((c): c is CanvasChange => c !== null);
	const baseSequence = sequence ?? 0;
	const records = commands
		.map((cmd, index) =>
			commandToChangeRecord(cmd, ir, {
				...applyOptions,
				actorId,
				source,
				sequence: baseSequence + index,
				commandIdFactory,
			}),
		)
		.filter((r): r is CanvasChangeRecord => r !== null);
	return {
		ir: result.ir,
		inverse: result.inverse as CanvasBatchCommand,
		changes,
		records,
	};
}
