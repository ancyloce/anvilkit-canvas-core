import type { z } from "zod";
import type { CanvasNodeBase } from "../types.js";

/**
 * Domain extension registries for `@anvilkit/canvas-core`. These let a host add
 * custom node kinds / commands / migrations without forking core. Framework-free.
 */

/** A node whose `type` discriminant is not necessarily a built-in kind. */
export type CanvasUnknownNode = CanvasNodeBase & { type: string };

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
	register<N extends CanvasUnknownNode>(def: CanvasNodeKindDefinition<N>): void;
	get(kind: string): CanvasNodeKindDefinition | undefined;
	has(kind: string): boolean;
	list(): readonly CanvasNodeKindDefinition[];
}

/** Create a node-kind registry, optionally seeded with built-in definitions. */
export function createNodeKindRegistry(
	builtins: readonly CanvasNodeKindDefinition[] = [],
): CanvasNodeKindRegistry {
	const map = new Map<string, CanvasNodeKindDefinition>();
	for (const def of builtins) map.set(def.kind, def);
	return {
		register(def) {
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
