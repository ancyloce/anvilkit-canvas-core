import { z } from "zod";
import { regenerateNodeIds } from "../ir/regenerate-ids.js";
import type { CanvasAssetRef, CanvasIR, CanvasNode } from "../ir/types.js";
import { CanvasAssetRefSchema, CanvasNodeSchema } from "../ir/validators.js";
import {
	CanvasIRDepthError,
	isContainerNode,
	MAX_TREE_DEPTH,
} from "../ir/walkers.js";

/**
 * @file Clipboard payload schema + validation (A-03, PRD 0012 §9.2).
 *
 * Core owns the DATA contract for copy/paste — the payload shape, its
 * validation (schema, version, depth, node-count, byte-size caps), and the
 * paste-side materialization (fresh ids via `regenerateNodeIds`, asset-ref
 * collision resolution). Clipboard BEHAVIOR (system clipboard access,
 * fallback store, selection updates) stays in the editor per §20.
 */

export const CANVAS_CLIPBOARD_VERSION = 1;

/**
 * MIME type the editor writes alongside `text/plain` when the system
 * clipboard is available — lets AnvilKit instances recognize each other's
 * payloads (FR-021 cross-editor paste).
 */
export const CANVAS_CLIPBOARD_MIME = "application/x-anvilkit-canvas+json";

/** Hostile/accidental mega-payload caps (PRD §9.2, §14.1). */
export const MAX_CLIPBOARD_NODES = 1_000;
export const MAX_CLIPBOARD_BYTES = 2 * 1024 * 1024;

export interface CanvasClipboardBounds {
	x: number;
	y: number;
	width: number;
	height: number;
}

export interface CanvasClipboardPayload {
	version: typeof CANVAS_CLIPBOARD_VERSION;
	sourceDocumentId?: string;
	sourcePageId?: string;
	nodes: readonly CanvasNode[];
	assetRefs: Readonly<Record<string, CanvasAssetRef>>;
	/** Combined AABB of `nodes` at copy time (paste-offset math). */
	bounds: CanvasClipboardBounds;
}

export type CanvasClipboardErrorCode =
	| "invalid-json"
	| "payload-too-large"
	| "unsupported-version"
	| "invalid-payload"
	| "too-many-nodes"
	| "excessive-depth";

export class CanvasClipboardError extends Error {
	readonly code: CanvasClipboardErrorCode;

	constructor(code: CanvasClipboardErrorCode, message: string) {
		super(message);
		this.name = "CanvasClipboardError";
		this.code = code;
	}
}

const CanvasClipboardBoundsSchema: z.ZodType<CanvasClipboardBounds> =
	z.looseObject({
		x: z.number(),
		y: z.number(),
		width: z.number(),
		height: z.number(),
	});

/**
 * Loose (unknown-key-preserving) schema, matching the IR validators'
 * convention so compatible unknown fields survive a copy/paste round-trip
 * between mixed editor versions.
 */
export const CanvasClipboardPayloadSchema: z.ZodType<CanvasClipboardPayload> =
	z.looseObject({
		version: z.literal(CANVAS_CLIPBOARD_VERSION),
		sourceDocumentId: z.string().optional(),
		sourcePageId: z.string().optional(),
		nodes: z.array(CanvasNodeSchema),
		assetRefs: z.record(z.string(), CanvasAssetRefSchema),
		bounds: CanvasClipboardBoundsSchema,
	}) as z.ZodType<CanvasClipboardPayload>;

function countNodes(roots: readonly CanvasNode[]): number {
	let count = 0;
	const visit = (node: CanvasNode, depth: number, chain: string[]): void => {
		if (depth > MAX_TREE_DEPTH) {
			throw new CanvasIRDepthError([...chain, node.id]);
		}
		count += 1;
		if (isContainerNode(node)) {
			chain.push(node.id);
			for (const child of node.children) visit(child, depth + 1, chain);
			chain.pop();
		}
	};
	for (const root of roots) visit(root, 0, []);
	return count;
}

/**
 * Validate an already-parsed candidate payload: version, schema, node-count
 * cap, and tree-depth cap. Throws {@link CanvasClipboardError}; returns the
 * schema-validated payload (unknown keys preserved).
 */
export function validateClipboardPayload(
	data: unknown,
): CanvasClipboardPayload {
	const versionProbe = data as { version?: unknown } | null;
	if (
		versionProbe &&
		typeof versionProbe === "object" &&
		versionProbe.version !== undefined &&
		versionProbe.version !== CANVAS_CLIPBOARD_VERSION
	) {
		throw new CanvasClipboardError(
			"unsupported-version",
			`Unsupported clipboard payload version ${String(versionProbe.version)} (expected ${CANVAS_CLIPBOARD_VERSION})`,
		);
	}
	const parsed = CanvasClipboardPayloadSchema.safeParse(data);
	if (!parsed.success) {
		throw new CanvasClipboardError(
			"invalid-payload",
			`Clipboard payload failed validation: ${parsed.error.message}`,
		);
	}
	let total: number;
	try {
		total = countNodes(parsed.data.nodes);
	} catch (err) {
		if (err instanceof CanvasIRDepthError) {
			throw new CanvasClipboardError(
				"excessive-depth",
				`Clipboard payload exceeds the maximum tree depth of ${MAX_TREE_DEPTH}`,
			);
		}
		throw err;
	}
	if (total > MAX_CLIPBOARD_NODES) {
		throw new CanvasClipboardError(
			"too-many-nodes",
			`Clipboard payload contains ${total} nodes (max ${MAX_CLIPBOARD_NODES})`,
		);
	}
	return parsed.data;
}

/**
 * Parse serialized clipboard text (byte-size cap → JSON → full validation).
 * This is the entry point for text arriving from the SYSTEM clipboard —
 * treat it as hostile (PRD §14.1).
 */
export function parseClipboardPayload(text: string): CanvasClipboardPayload {
	// `text.length` counts UTF-16 code units, not bytes — a CJK/emoji-heavy
	// hostile payload would pass this cap at ~3-4x its documented byte size
	// (C-11). Measure the real encoded byte length instead.
	const byteLength = new TextEncoder().encode(text).byteLength;
	if (byteLength > MAX_CLIPBOARD_BYTES) {
		throw new CanvasClipboardError(
			"payload-too-large",
			`Clipboard payload is ${byteLength} bytes (max ${MAX_CLIPBOARD_BYTES})`,
		);
	}
	let data: unknown;
	try {
		data = JSON.parse(text);
	} catch {
		throw new CanvasClipboardError(
			"invalid-json",
			"Clipboard text is not valid JSON",
		);
	}
	return validateClipboardPayload(data);
}

export interface MaterializeClipboardOptions {
	/** Fresh-id source for node AND re-keyed asset ids (deterministic tests). */
	idFactory?: () => string;
}

export interface MaterializedClipboard {
	/** Deep copies of the payload nodes with brand-new ids. */
	nodes: readonly CanvasNode[];
	/** old node id → new node id, across every pasted subtree. */
	idMap: ReadonlyMap<string, string>;
	/**
	 * Asset entries the paste must ADD to the target document (already
	 * re-keyed where a collision required it). Same-document pastes and
	 * already-present identical assets contribute nothing here.
	 */
	assetsToAdd: Readonly<Record<string, CanvasAssetRef>>;
}

function defaultAssetIdFactory(): string {
	const c = (globalThis as { crypto?: { randomUUID?: () => string } }).crypto;
	if (c && typeof c.randomUUID === "function") return c.randomUUID();
	return `asset-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

function sameAssetRef(a: CanvasAssetRef, b: CanvasAssetRef): boolean {
	return JSON.stringify(a) === JSON.stringify(b);
}

/**
 * Prepare a validated payload for insertion into `target` (FR-021):
 *
 * - Every node subtree gets fresh ids via the shared `regenerateNodeIds`.
 * - Same-document paste (`sourceDocumentId === target.id`): nodes keep their
 *   asset references; nothing is added to the asset table.
 * - Cross-document paste: each payload asset is copied into the target unless
 *   an IDENTICAL entry already exists; an id collision with a DIFFERENT asset
 *   is re-keyed and every `assetId`/`maskAssetId` reference in the pasted
 *   nodes is rewritten. Transferring asset BINARIES between hosts stays a
 *   host concern — only refs travel.
 */
export function materializeClipboardNodes(
	payload: CanvasClipboardPayload,
	target: CanvasIR,
	options: MaterializeClipboardOptions = {},
): MaterializedClipboard {
	const idMap = new Map<string, string>();
	const remappedRoots: CanvasNode[] = [];
	for (const root of payload.nodes) {
		const result = regenerateNodeIds(
			root,
			options.idFactory ? { idFactory: options.idFactory } : {},
		);
		remappedRoots.push(result.node);
		for (const [oldId, newId] of result.idMap) idMap.set(oldId, newId);
	}

	const sameDocument =
		payload.sourceDocumentId !== undefined &&
		payload.sourceDocumentId === target.id;
	if (sameDocument) {
		return { nodes: remappedRoots, idMap, assetsToAdd: {} };
	}

	const assetIdFactory = options.idFactory ?? defaultAssetIdFactory;
	const assetsToAdd: Record<string, CanvasAssetRef> = {};
	const assetIdRewrites = new Map<string, string>();
	for (const [key, ref] of Object.entries(payload.assetRefs)) {
		const existing = target.assets?.[key];
		if (existing && sameAssetRef(existing, ref)) {
			continue; // identical asset already present — reuse it
		}
		if (existing) {
			const newId = assetIdFactory();
			assetIdRewrites.set(key, newId);
			assetsToAdd[newId] = { ...ref, id: newId };
		} else {
			assetsToAdd[key] = ref;
		}
	}

	if (assetIdRewrites.size > 0) {
		const rewrite = (node: CanvasNode): void => {
			const record = node as unknown as Record<string, unknown>;
			// Mirrors the reference fields `ir/invariants.ts`'s
			// `assetIdsReferencedByNode` enumerates, so a rewritten asset id can
			// never desync from what the invariant checker considers a reference.
			for (const field of ["assetId", "maskAssetId", "poster"] as const) {
				const value = record[field];
				if (typeof value === "string" && assetIdRewrites.has(value)) {
					record[field] = assetIdRewrites.get(value);
				}
			}
			const placeholder = record.placeholder as
				| Record<string, unknown>
				| undefined;
			if (placeholder) {
				const placeholderAssetId = placeholder.assetId;
				if (
					typeof placeholderAssetId === "string" &&
					assetIdRewrites.has(placeholderAssetId)
				) {
					placeholder.assetId = assetIdRewrites.get(placeholderAssetId);
				}
			}
			if (isContainerNode(node)) {
				for (const child of node.children) rewrite(child);
			}
		};
		for (const root of remappedRoots) rewrite(root);
	}

	return { nodes: remappedRoots, idMap, assetsToAdd };
}
