import type {
	CanvasFrameNode,
	CanvasImageNode,
	CanvasIR,
	CanvasRichTextNode,
	CanvasTextNode,
	CanvasUnit,
	FramePlaceholder,
} from "../ir/types.js";

/**
 * A safe-area inset, in the same unit as its owning {@link CanvasSizePreset}.
 */
export interface CanvasSafeArea {
	top: number;
	right: number;
	bottom: number;
	left: number;
}

/**
 * A lightweight, versioned width/height/unit preset (PRD §12.8) — e.g.
 * "Instagram Post" or "LinkedIn Banner". Deliberately NOT a full design: the
 * real preset catalog (Instagram/TikTok/YouTube/etc.) ships in canvas-m3-006
 * (FR-060). This placeholder shape exists now only so
 * {@link CanvasTemplateDefinition.supportedSizes} has something concrete to
 * validate against; canvas-m3-006 is additive on top of it, not a rewrite.
 */
export interface CanvasSizePreset {
	id: string;
	version: string;
	label: string;
	width: number;
	height: number;
	unit: CanvasUnit;
	dpi?: number;
	safeArea?: CanvasSafeArea;
}

/**
 * Fields every slot kind shares: an id and the stable ID of the node inside
 * the template's {@link CanvasTemplateDefinition.document} it controls.
 */
export interface TemplateSlotBase {
	id: string;
	nodeId: string;
}

/** A slot bound to a {@link CanvasTextNode} or {@link CanvasRichTextNode}'s text content. */
export interface TemplateTextSlot extends TemplateSlotBase {
	kind: "text";
}

/** A slot bound to an image-bearing node (typically a {@link CanvasImageNode}, or a {@link CanvasFrameNode} with an image {@link FramePlaceholder}). */
export interface TemplateImageSlot extends TemplateSlotBase {
	kind: "image";
}

/** A slot bound to a logo-bearing node — same shape as {@link TemplateImageSlot}, kept distinct so a Templates panel can present logo replacement separately from generic image replacement. */
export interface TemplateLogoSlot extends TemplateSlotBase {
	kind: "logo";
}

/** A slot bound to a {@link CanvasFrameNode} as a whole (its placeholder, clip, or background). */
export interface TemplateFrameSlot extends TemplateSlotBase {
	kind: "frame";
}

/** Which fill-bearing property on the target node a {@link TemplateColorSlot} controls. */
export type TemplateColorSlotProperty = "fill" | "background" | "stroke";

/** A slot bound to one fill-bearing property (fill/background/stroke) of a node. */
export interface TemplateColorSlot extends TemplateSlotBase {
	kind: "color";
	/** Defaults to `"fill"` when omitted. */
	property?: TemplateColorSlotProperty;
}

/** A slot bound to a text-bearing node's `fontFamily`. */
export interface TemplateFontSlot extends TemplateSlotBase {
	kind: "font";
}

/**
 * A named, editable point inside a template's {@link CanvasTemplateDefinition.document}
 * (FR-021) — one of the six supported kinds, each referencing a stable node ID.
 * Kind-specific metadata beyond the shared `id`/`nodeId` lives on the
 * individual slot interfaces (e.g. {@link TemplateColorSlot.property}).
 */
export type TemplateSlot =
	| TemplateTextSlot
	| TemplateImageSlot
	| TemplateLogoSlot
	| TemplateFrameSlot
	| TemplateColorSlot
	| TemplateFontSlot;

/** The six slot kinds a template can expose for controlled editing (FR-021). */
export type TemplateSlotKind = TemplateSlot["kind"];

/**
 * A user-facing control bound to a {@link TemplateSlot}. `defaultValue` fills
 * in when no value is supplied at instantiation; `required` (with no default)
 * surfaces as a structured warning instead of failing silently — see
 * `resolveTemplateVariables` in `./resolvers.js`.
 */
export interface TemplateVariable {
	id: string;
	label: string;
	slotId: string;
	defaultValue?: string;
	required?: boolean;
}

/** License metadata for a template. Extended into a real shape in canvas-m6-003 (FR-082). */
export interface TemplateLicense {
	type: string;
	attribution?: string;
}

/** Provenance metadata for a template. Extended in canvas-m6-003 (FR-082). */
export interface TemplateSourceMeta {
	author?: string;
	sourceUrl?: string;
}

/**
 * The canonical template definition contract (PRD FR-020, §12.5).
 *
 * Naming: this supersedes `@anvilkit/canvas-templates`'s existing
 * `CanvasTemplate` (`{slug, name, description, ir}`) — that package migrates
 * its 10 templates to this shape and re-exports `CanvasTemplateDefinition`
 * directly rather than keeping a separate, drifting type (see canvas-m2-004).
 * `@anvilkit/canvas-editor`'s `CanvasTemplateEntry` remains the editor-facing,
 * host-injected projection of this type — the editor cannot depend on the
 * private templates package, so it keeps its own structurally-compatible type
 * rather than importing this one (see `editor/src/templates/template-entry.ts`).
 *
 * Validates independently of normal Canvas IR: template-only metadata
 * (`id`, `category`, `tags`, `variables`, `editableSlots`, etc.) never leaks
 * into `document`, which is itself always a normal, independently-valid
 * {@link CanvasIR}.
 */
export interface CanvasTemplateDefinition {
	id: string;
	version: string;
	title: string;
	category: string;
	tags: string[];
	previewAssetId?: string;
	supportedSizes: CanvasSizePreset[];
	requiredAssets?: string[];
	document: CanvasIR;
	variables: TemplateVariable[];
	editableSlots: TemplateSlot[];
	lockedNodeIds: string[];
	license?: TemplateLicense;
	source?: TemplateSourceMeta;
}
