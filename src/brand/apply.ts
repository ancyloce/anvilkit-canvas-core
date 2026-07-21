import { applyCommands } from "../commands/transaction.js";
import type {
	CanvasAnyNodeUpdateCommand,
	CanvasBatchCommand,
	CanvasCommand,
} from "../commands/types.js";
import type { CanvasIR, CanvasNode } from "../ir/types.js";
import { walk } from "../ir/walkers.js";
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

	walk(document, ({ node }) => {
		const command = buildCommand(node);
		if (!command) return;
		if (node.locked && !options.includeLocked) {
			report.skippedLockedNodeIds.push(node.id);
			return;
		}
		commands.push(command);
		report.affectedNodeIds.push(node.id);
	});

	if (commands.length === 0) return { document, command: null, report };
	const { ir } = applyCommands(document, commands, { label });
	const command: CanvasBatchCommand = { type: "batch", label, commands };
	return { document: ir, command, report };
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
