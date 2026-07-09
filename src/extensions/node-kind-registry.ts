import type { z } from "zod";
import type { CanvasNodeBase } from "../types.js";

/**
 * Domain extension registries for `@anvilkit/canvas-core`. These let a host add
 * custom node kinds / commands / migrations without forking core. Framework-free.
 */

/** A node whose `type` discriminant is not necessarily a built-in kind. */
export type CanvasUnknownNode = CanvasNodeBase & { type: string };

export type CanvasExtensionErrorCode =
	| "builtin-kind-shadowed"
	| "duplicate-kind";

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
	/** True if this kind contains `children` (walked recursively). Default false. */
	readonly isContainer?: boolean;
}

export interface CanvasNodeKindRegistry {
	/**
	 * Register an extension kind. Seeded built-in kinds are unshadowable and a
	 * kind may only be registered once.
	 *
	 * @throws CanvasExtensionError with code `"builtin-kind-shadowed"` when the
	 * kind is a seeded built-in, or `"duplicate-kind"` when another extension
	 * already registered it.
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
