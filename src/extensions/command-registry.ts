import type {
	CanvasCommand,
	CommandApplyOptions,
	CommandApplyResult,
} from "../commands/types.js";
import type { CanvasIR } from "../ir/types.js";

/**
 * A command extension. `apply` must be reversible like the built-in
 * `applyCommand` — returning `{ ir, inverse }` so history undo/redo works.
 *
 * `Inverse` (P0-4) is the type of the command this handler's `apply` may
 * return as `inverse`. It defaults to `C | CanvasCommand` — the handler's own
 * command type (the common "symmetric" case, e.g. a toggle whose inverse is
 * itself) union the built-in command types (when the inverse happens to be
 * expressible as one) — so a handler that returns a genuinely different
 * custom inverse type supplies it explicitly:
 * `CanvasCommandHandler<MyCmd, MyCmd | MyOtherCustomInverse>`. Either way,
 * `apply` never needs an unsafe cast to satisfy this type.
 */
export interface CanvasCommandHandler<
	C extends { type: string } = { type: string },
	Inverse extends { type: string } = C | CanvasCommand,
> {
	readonly type: C["type"];
	readonly apply: (
		ir: CanvasIR,
		cmd: C,
		options: CommandApplyOptions,
	) => CommandApplyResult<Inverse>;
}

export interface CanvasCommandRegistry {
	register<
		C extends { type: string },
		Inverse extends { type: string } = C | CanvasCommand,
	>(handler: CanvasCommandHandler<C, Inverse>): void;
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
