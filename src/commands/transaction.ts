import type { CanvasIR } from "../types.js";
import { type CanvasChange, commandToChange } from "./change-events.js";
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
}

export interface ApplyCommandsOptions extends CommandApplyOptions {
	label?: string;
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
	const { label, ...applyOptions } = options;
	const batch: CanvasBatchCommand = {
		type: "batch",
		...(label !== undefined ? { label } : {}),
		commands: [...commands],
	};
	const result = applyCommand(ir, batch, applyOptions);
	const changes = commands
		.map(commandToChange)
		.filter((c): c is CanvasChange => c !== null);
	return {
		ir: result.ir,
		inverse: result.inverse as CanvasBatchCommand,
		changes,
	};
}
