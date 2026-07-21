import type {
	CanvasCommand,
	CommandApplyOptions,
	CommandApplyResult,
} from "../commands/types.js";
import type { CanvasIR } from "../ir/types.js";
import { CanvasExtensionError } from "./node-kind-registry.js";

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
	/**
	 * Register an extension command handler. A built-in command type is
	 * unshadowable, and a type may only be registered once — mirroring
	 * {@link CanvasNodeKindRegistry.register}'s guard (C-13).
	 *
	 * @throws CanvasExtensionError with code `"builtin-command-shadowed"` when
	 * `handler.type` names a built-in command, or `"duplicate-command"` when
	 * another extension already registered it.
	 */
	register<
		C extends { type: string },
		Inverse extends { type: string } = C | CanvasCommand,
	>(handler: CanvasCommandHandler<C, Inverse>): void;
	get(type: string): CanvasCommandHandler | undefined;
	has(type: string): boolean;
}

/**
 * Create a command registry. `builtins` names every built-in command type
 * (e.g. `canvas-runtime.ts`'s `BUILTIN_COMMAND_TYPES`) so `register()` can
 * reject an attempt to shadow one instead of silently accepting a handler
 * that dispatch will never reach.
 */
export function createCommandRegistry(
	builtins: Iterable<string> = [],
): CanvasCommandRegistry {
	const builtinTypes: ReadonlySet<string> = new Set(builtins);
	const map = new Map<string, CanvasCommandHandler>();
	return {
		register(handler) {
			if (builtinTypes.has(handler.type)) {
				throw new CanvasExtensionError(
					"builtin-command-shadowed",
					`Cannot register command "${handler.type}": built-in command types cannot be shadowed by extensions.`,
				);
			}
			if (map.has(handler.type)) {
				throw new CanvasExtensionError(
					"duplicate-command",
					`Cannot register command "${handler.type}": it is already registered by another extension.`,
				);
			}
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
