import { applyCommands } from "../commands/transaction.js";
import type {
	CanvasAnyNodeUpdateCommand,
	CanvasBatchCommand,
	CanvasCommand,
} from "../commands/types.js";
import type {
	CanvasComponentDefinition,
	CanvasComponentOverride,
	CanvasComponentRegistry,
	CanvasIR,
	CanvasNode,
} from "../ir/types.js";
import { isContainerNode, walkDocument } from "../ir/walkers.js";
import type {
	BrandAsset,
	BrandColorToken,
	BrandFontToken,
	BrandKitDefinition,
	BrandTypographyPreset,
} from "./types.js";

/** What one `apply*` transform did to a document (FR-032). */
export interface BrandApplyReport {
	/** Ids of nodes the transform actually patched. */
	affectedNodeIds: string[];
	/** Ids of nodes that matched but were skipped because they're locked. */
	skippedLockedNodeIds: string[];
}

export interface BrandApplyResult {
	document: CanvasIR;
	/**
	 * The reversible batch that produced `document` from the input, or `null`
	 * when nothing matched. Apply it yourself (e.g. `ctx.commit(command)` in
	 * canvas-editor) to get proper undo-stack tracking — `document` alone is
	 * NOT re-appliable as a command.
	 *
	 * Covers PAGE nodes only. Component Source trees are patched structurally
	 * (with a `revision` bump per touched definition — the LC-PROPAGATE
	 * signal) and are NOT in this batch: command-addressable Source mutation
	 * arrives with the M3 component commands (plan 0023, DEV-M1-C).
	 */
	command: CanvasBatchCommand | null;
	report: BrandApplyReport;
}

export interface BrandApplyOptions {
	/** When `true`, locked nodes are patched too. Defaults to `false`. */
	includeLocked?: boolean;
}

function caseInsensitiveEquals(a: string, b: string): boolean {
	return a.toLowerCase() === b.toLowerCase();
}

function findColorToken(
	value: string,
	colors: readonly BrandColorToken[],
): BrandColorToken | undefined {
	return colors.find((c) => caseInsensitiveEquals(c.value, value));
}

function findFontToken(
	value: string,
	fonts: readonly BrandFontToken[],
): BrandFontToken | undefined {
	return fonts.find((f) => caseInsensitiveEquals(f.family, value));
}

/**
 * Runs `buildCommand` over every node in `document`, skipping locked nodes
 * (unless `options.includeLocked`), and applies the resulting patches as one
 * reversible batch — the shared engine behind every `apply*` transform below.
 */
function runBrandTransform(
	document: CanvasIR,
	options: BrandApplyOptions,
	label: string,
	buildCommand: (node: CanvasNode) => CanvasAnyNodeUpdateCommand | null,
): BrandApplyResult {
	const commands: CanvasCommand[] = [];
	const report: BrandApplyReport = {
		affectedNodeIds: [],
		skippedLockedNodeIds: [],
	};
	// componentId → (nodeId → patch), collected off the SAME buildCommand so
	// a transform can never treat a Source tree differently from a page tree
	// (plan 0023 M1-08 — brand transforms were Registry-blind before this).
	const definitionPatches = new Map<
		string,
		Map<string, Record<string, unknown>>
	>();

	walkDocument(document, ({ node, location }) => {
		const command = buildCommand(node);
		if (!command) return;
		if (node.locked && !options.includeLocked) {
			report.skippedLockedNodeIds.push(node.id);
			return;
		}
		if (location.kind === "page") {
			commands.push(command);
			report.affectedNodeIds.push(node.id);
			return;
		}
		let patches = definitionPatches.get(location.id);
		if (!patches) {
			patches = new Map();
			definitionPatches.set(location.id, patches);
		}
		patches.set(command.nodeId, command.patch as Record<string, unknown>);
		report.affectedNodeIds.push(node.id);
	});

	if (commands.length === 0 && definitionPatches.size === 0) {
		return { document, command: null, report };
	}
	let next = document;
	if (commands.length > 0) {
		next = applyCommands(next, commands, { label }).ir;
	}
	if (definitionPatches.size > 0 && next.components) {
		next = {
			...next,
			components: patchDefinitions(next.components, definitionPatches),
		};
	}
	const command: CanvasBatchCommand | null =
		commands.length > 0 ? { type: "batch", label, commands } : null;
	return { document: next, command, report };
}

/** Apply collected patches to a node tree, sharing every untouched subtree. */
function patchNodeTree(
	node: CanvasNode,
	patches: ReadonlyMap<string, Record<string, unknown>>,
): CanvasNode {
	const patch = patches.get(node.id);
	const patched: CanvasNode = patch
		? ({ ...node, ...patch } as CanvasNode)
		: node;
	if (!isContainerNode(patched)) return patched;
	let childChanged = false;
	const children = patched.children.map((child) => {
		const nextChild = patchNodeTree(child, patches);
		if (nextChild !== child) childChanged = true;
		return nextChild;
	});
	if (!childChanged) return patched;
	return { ...patched, children } as CanvasNode;
}

/**
 * Structurally rewrite the touched definitions, bumping `revision` on each —
 * the propagation signal every instance resolution keys on. Never mutates
 * the input registry (INV-4).
 */
function patchDefinitions(
	registry: CanvasComponentRegistry,
	definitionPatches: ReadonlyMap<
		string,
		ReadonlyMap<string, Record<string, unknown>>
	>,
): CanvasComponentRegistry {
	const next: Record<string, CanvasComponentDefinition> = { ...registry };
	for (const [componentId, patches] of definitionPatches) {
		const definition = next[componentId];
		if (!definition) continue;
		next[componentId] = {
			...definition,
			revision: definition.revision + 1,
			root: patchNodeTree(definition.root, patches),
		};
	}
	return next;
}

/**
 * Links every literal (non-token) fill/background that matches a brand
 * color BY VALUE (case-insensitive) to that color's `BrandTokenRef`, so
 * future brand-color edits propagate to it. Colors with no matching brand
 * swatch are left untouched — this transform never invents a color choice
 * for a node, only formalizes an already-correct one into a token reference.
 * `stroke` is deliberately NOT covered (C-17): it is `string`-typed on
 * every node kind that has one, with no `BrandTokenRef` variant to link to —
 * `generateBrandComplianceReport` still flags an off-brand/forbidden
 * literal stroke color, it just can't be tokenized here.
 */
export function applyBrandColors(
	document: CanvasIR,
	brandKit: BrandKitDefinition,
	options: BrandApplyOptions = {},
): BrandApplyResult {
	return runBrandTransform(
		document,
		options,
		"Apply brand colors",
		(node): CanvasAnyNodeUpdateCommand | null => {
			switch (node.type) {
				case "rect":
				case "ellipse":
				case "polygon":
				case "star":
				case "path":
				case "text": {
					if (typeof node.fill !== "string") return null;
					const token = findColorToken(node.fill, brandKit.colors);
					if (!token?.id) return null;
					return {
						type: "node.update",
						nodeId: node.id,
						kind: node.type,
						patch: {
							fill: { type: "brand-token", tokenType: "color", id: token.id },
						},
					};
				}
				case "frame": {
					if (typeof node.background !== "string") return null;
					const token = findColorToken(node.background, brandKit.colors);
					if (!token?.id) return null;
					return {
						type: "node.update",
						nodeId: node.id,
						kind: "frame",
						patch: {
							background: {
								type: "brand-token",
								tokenType: "color",
								id: token.id,
							},
						},
					};
				}
				case "component-instance": {
					// COLOR OVERRIDES carry CanvasFill values, so a literal that
					// matches a brand color links exactly like a node fill does
					// (plan 0023 M1-08). Non-color and unmatched entries ride
					// through verbatim — never dropped, never reordered.
					if (!node.overrides) return null;
					let changed = false;
					const nextOverrides: Record<string, CanvasComponentOverride> = {};
					for (const [propertyId, override] of Object.entries(node.overrides)) {
						if (
							override.kind === "color" &&
							typeof override.value === "string"
						) {
							const token = findColorToken(override.value, brandKit.colors);
							if (token?.id) {
								nextOverrides[propertyId] = {
									kind: "color",
									value: {
										type: "brand-token",
										tokenType: "color",
										id: token.id,
									},
								};
								changed = true;
								continue;
							}
						}
						nextOverrides[propertyId] = override;
					}
					if (!changed) return null;
					return {
						type: "node.update",
						nodeId: node.id,
						kind: "component-instance",
						patch: { overrides: nextOverrides },
					};
				}
				default:
					return null;
			}
		},
	);
}

/**
 * Links every literal font-family that matches a brand font BY NAME
 * (case-insensitive) to that font's `BrandTokenRef`. `rich-text` spans are
 * out of scope here (canvas-m1-009's MVP applies span-level style uniformly
 * via the editor, not per-property core transforms) — this covers `text`
 * nodes, the common case.
 */
export function replaceFonts(
	document: CanvasIR,
	brandKit: BrandKitDefinition,
	options: BrandApplyOptions = {},
): BrandApplyResult {
	return runBrandTransform(
		document,
		options,
		"Replace fonts",
		(node): CanvasAnyNodeUpdateCommand | null => {
			if (node.type !== "text" || typeof node.fontFamily !== "string") {
				return null;
			}
			const token = findFontToken(node.fontFamily, brandKit.fonts);
			if (!token?.id) return null;
			return {
				type: "node.update",
				nodeId: node.id,
				kind: "text",
				patch: {
					fontFamily: { type: "brand-token", tokenType: "font", id: token.id },
				},
			};
		},
	);
}

function pickLogo(brandKit: BrandKitDefinition): BrandAsset | undefined {
	return brandKit.logos.find((l) => l.kind === "logo") ?? brandKit.logos[0];
}

/**
 * Fills every EMPTY logo-kind frame placeholder with the brand's logo (the
 * first asset tagged `kind: "logo"`, else the first logo asset). A
 * placeholder that already has an `assetId` or `assetToken` is left alone —
 * this only fills gaps, it never replaces a deliberate choice.
 */
export function replaceLogoPlaceholders(
	document: CanvasIR,
	brandKit: BrandKitDefinition,
	options: BrandApplyOptions = {},
): BrandApplyResult {
	const logo = pickLogo(brandKit);
	if (!logo)
		return {
			document,
			command: null,
			report: { affectedNodeIds: [], skippedLockedNodeIds: [] },
		};

	return runBrandTransform(
		document,
		options,
		"Replace logo placeholders",
		(node): CanvasAnyNodeUpdateCommand | null => {
			if (node.type !== "frame") return null;
			const placeholder = node.placeholder;
			if (
				!placeholder ||
				placeholder.kind !== "logo" ||
				placeholder.assetId ||
				placeholder.assetToken
			) {
				return null;
			}
			return {
				type: "node.update",
				nodeId: node.id,
				kind: "frame",
				patch: {
					placeholder: {
						...placeholder,
						assetToken: {
							type: "brand-token",
							tokenType: "logo",
							id: logo.id,
						},
					},
				},
			};
		},
	);
}

function selectTypographyPreset(
	brandKit: BrandKitDefinition,
	presetId?: string,
): BrandTypographyPreset | undefined {
	if (presetId) return brandKit.typography.find((p) => p.id === presetId);
	return brandKit.typography[0];
}

export interface NormalizeTypographyOptions extends BrandApplyOptions {
	/** Which preset to apply. Defaults to the brand kit's first typography preset. */
	presetId?: string;
}

/**
 * Applies a brand typography preset's `fontSize`/`fontWeight` uniformly to
 * every `text` node (unlike {@link applyBrandColors}/{@link replaceFonts},
 * which only formalize an already-matching value, this one overwrites —
 * "normalize" means bringing every text element onto the same scale, not
 * linking an existing coincidental match). Font family is untouched — that's
 * {@link replaceFonts}' concern.
 */
export function normalizeTypography(
	document: CanvasIR,
	brandKit: BrandKitDefinition,
	options: NormalizeTypographyOptions = {},
): BrandApplyResult {
	const preset = selectTypographyPreset(brandKit, options.presetId);
	if (!preset) {
		return {
			document,
			command: null,
			report: { affectedNodeIds: [], skippedLockedNodeIds: [] },
		};
	}

	return runBrandTransform(
		document,
		options,
		"Normalize typography",
		(node): CanvasAnyNodeUpdateCommand | null => {
			if (node.type !== "text") return null;
			const patch: Partial<{ fontSize: number; fontWeight: string }> = {};
			if (preset.fontSize !== undefined) patch.fontSize = preset.fontSize;
			if (preset.fontWeight !== undefined) patch.fontWeight = preset.fontWeight;
			if (Object.keys(patch).length === 0) return null;
			return { type: "node.update", nodeId: node.id, kind: "text", patch };
		},
	);
}
