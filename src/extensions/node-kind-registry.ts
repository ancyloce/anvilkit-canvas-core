import type { z } from "zod";
import type { CanvasNodeBase } from "../ir/types.js";

/**
 * Domain extension registries for `@anvilkit/canvas-core`. These let a host add
 * custom node kinds / commands / migrations without forking core. Framework-free.
 */

/** A node whose `type` discriminant is not necessarily a built-in kind. */
export type CanvasUnknownNode = CanvasNodeBase & { type: string };

export type CanvasExtensionErrorCode =
	| "builtin-kind-shadowed"
	| "duplicate-kind"
	| "container-kind-unsupported"
	| "builtin-command-shadowed"
	| "duplicate-command";

/** Structured error thrown when an extension registration is rejected. */
export class CanvasExtensionError extends Error {
	readonly code: CanvasExtensionErrorCode;

	constructor(code: CanvasExtensionErrorCode, message: string) {
		super(message);
		this.name = "CanvasExtensionError";
		this.code = code;
	}
}

/**
 * Minimal, React/Konva-free SVG emit surface handed to a kind's `toSvg` hook so
 * a custom kind can render to the same `<svg>` the built-in serializer produces.
 */
export interface CanvasSvgHookContext {
	/** Common per-node attributes: transform / opacity / blend mode. */
	commonAttrs: (node: CanvasNodeBase) => string;
	/** Format a number for SVG output (matches the built-in serializer). */
	fmt: (n: number) => string;
	escapeAttr: (s: string) => string;
	escapeXml: (s: string) => string;
	/** Record a non-fatal serialization warning. */
	warn: (code: string, message: string, nodeId?: string) => void;
}

/** A node kind contributed at runtime. `N` is the concrete node type. */
export interface CanvasNodeKindDefinition<
	N extends CanvasUnknownNode = CanvasUnknownNode,
> {
	readonly kind: N["type"];
	/** Object schema for THIS kind only (a `z.looseObject({..., type: z.literal(kind)})`). */
	readonly schema: z.ZodType<N>;
	/**
	 * Pure factory; mirrors the `createRect`-style builders in ir-builders.ts.
	 * Optional: built-in kinds are created via the typed builders, and a
	 * parse/render-only kind (e.g. one received from a peer) may omit it.
	 */
	readonly create?: (opts: Record<string, unknown>) => N;
	/** Local-space content extent for group-bounds + hit-testing. */
	readonly contentExtent?: (node: N) => { width: number; height: number };
	/** SVG hook. Returns a fragment string, or `""` to skip. */
	readonly toSvg?: (node: N, ctx: CanvasSvgHookContext) => string;
	/**
	 * True if this kind contains `children` (walked recursively). Default false.
	 *
	 * NOT CURRENTLY SUPPORTED for extension kinds (P0-5): `ir/walkers.ts` and
	 * `ir/mutations.ts` — `findNode`/`parentOf`/`insertNode`/`removeNode`/
	 * `updateNode`/every other tree operation — recurse only into the static
	 * built-in container kinds (`group`, `frame`), never into this registry.
	 * Only `serialize/svg.ts`'s leaf `toSvg` fallback is registry-aware. Setting
	 * `isContainer: true` on an EXTENSION kind is rejected at `register()` time
	 * with `CanvasExtensionError("container-kind-unsupported", ...)` rather than
	 * silently accepted and then silently un-walked — a custom container is a
	 * future extension seam (runtime-aware traversal across every walker/
	 * mutation entry point), not a partially-working feature today. Built-in
	 * container kinds are seeded directly (bypassing `register()`) and are
	 * unaffected.
	 */
	readonly isContainer?: boolean;
}

export interface CanvasNodeKindRegistry {
	/**
	 * Register an extension kind. Seeded built-in kinds are unshadowable, a
	 * kind may only be registered once, and (P0-5) a container kind is rejected
	 * outright — see {@link CanvasNodeKindDefinition.isContainer}.
	 *
	 * @throws CanvasExtensionError with code `"builtin-kind-shadowed"` when the
	 * kind is a seeded built-in, `"duplicate-kind"` when another extension
	 * already registered it, or `"container-kind-unsupported"` when
	 * `def.isContainer` is true.
	 */
	register<N extends CanvasUnknownNode>(def: CanvasNodeKindDefinition<N>): void;
	get(kind: string): CanvasNodeKindDefinition | undefined;
	has(kind: string): boolean;
	list(): readonly CanvasNodeKindDefinition[];
}

/**
 * Create a node-kind registry, optionally seeded with built-in definitions.
 * Seeding is exempt from the shadow guard; later `register()` calls are not —
 * mirroring the built-in command-type protection in `createCanvasRuntime`.
 */
export function createNodeKindRegistry(
	builtins: readonly CanvasNodeKindDefinition[] = [],
): CanvasNodeKindRegistry {
	const map = new Map<string, CanvasNodeKindDefinition>();
	for (const def of builtins) map.set(def.kind, def);
	const builtinKinds: ReadonlySet<string> = new Set(map.keys());
	return {
		register(def) {
			if (builtinKinds.has(def.kind)) {
				throw new CanvasExtensionError(
					"builtin-kind-shadowed",
					`Cannot register node kind "${def.kind}": built-in kinds cannot be shadowed by extensions.`,
				);
			}
			if (def.isContainer) {
				throw new CanvasExtensionError(
					"container-kind-unsupported",
					`Cannot register node kind "${def.kind}" with isContainer: true — extension container kinds are not walked/mutated by core today (see CanvasNodeKindDefinition.isContainer). Register it as a leaf kind, or model containment via a built-in "group"/"frame" wrapping your leaf node.`,
				);
			}
			if (map.has(def.kind)) {
				throw new CanvasExtensionError(
					"duplicate-kind",
					`Cannot register node kind "${def.kind}": it is already registered by another extension.`,
				);
			}
			map.set(def.kind, def as unknown as CanvasNodeKindDefinition);
		},
		get(kind) {
			return map.get(kind);
		},
		has(kind) {
			return map.has(kind);
		},
		list() {
			return [...map.values()];
		},
	};
}
