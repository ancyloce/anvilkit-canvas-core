import type {
	CommandApplyOptions,
	CommandApplyResult,
} from "../commands/types.js";
import type { CanvasIR } from "../types.js";

/**
 * A command extension. `apply` must be reversible like the built-in
 * `applyCommand` — returning `{ ir, inverse }` so history undo/redo works.
 */
export interface CanvasCommandHandler<
	C extends { type: string } = { type: string },
> {
	readonly type: C["type"];
	readonly apply: (
		ir: CanvasIR,
		cmd: C,
		options: CommandApplyOptions,
	) => CommandApplyResult;
}

export interface CanvasCommandRegistry {
	register<C extends { type: string }>(handler: CanvasCommandHandler<C>): void;
	get(type: string): CanvasCommandHandler | undefined;
	has(type: string): boolean;
}

export function createCommandRegistry(): CanvasCommandRegistry {
	const map = new Map<string, CanvasCommandHandler>();
	return {
		register(handler) {
			map.set(handler.type, handler as unknown as CanvasCommandHandler);
		},
		get(type) {
			return map.get(type);
		},
		has(type) {
			return map.has(type);
		},
	};
}
