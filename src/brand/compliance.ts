import type { CanvasFill, CanvasFontFamily, CanvasIR } from "../ir/types.js";
import { walk } from "../ir/walkers.js";
import type { BrandKitDefinition } from "./types.js";

export type BrandComplianceIssueCode =
	| "unresolved-color-token"
	| "unresolved-font-token"
	| "forbidden-color"
	| "forbidden-font"
	| "off-brand-color"
	| "off-brand-font";

export interface BrandComplianceIssue {
	nodeId: string;
	code: BrandComplianceIssueCode;
	/** Which property this issue was found on, e.g. `"fill"`, `"fontFamily"`. */
	property: string;
	/** The token id (for token issues) or literal value (for literal issues). */
	value: string;
}

export interface BrandComplianceReport {
	issues: BrandComplianceIssue[];
}

function caseInsensitiveEquals(a: string, b: string): boolean {
	return a.toLowerCase() === b.toLowerCase();
}

function checkColor(
	nodeId: string,
	property: string,
	fill: CanvasFill | undefined,
	brandKit: BrandKitDefinition,
	issues: BrandComplianceIssue[],
): void {
	if (fill === undefined) return;
	if (typeof fill !== "string") {
		if ("type" in fill && fill.type === "brand-token") {
			if (!brandKit.colors.some((c) => c.id === fill.id)) {
				issues.push({
					nodeId,
					code: "unresolved-color-token",
					property,
					value: fill.id,
				});
			}
		}
		return; // gradients aren't brand-checked
	}
	const forbidden = brandKit.rules.find(
		(r) => r.kind === "forbidden-color" && caseInsensitiveEquals(r.value, fill),
	);
	if (forbidden) {
		issues.push({ nodeId, code: "forbidden-color", property, value: fill });
		return;
	}
	if (brandKit.colors.length === 0) return;
	const onBrand = brandKit.colors.some((c) =>
		caseInsensitiveEquals(c.value, fill),
	);
	const allowed = brandKit.rules.some(
		(r) => r.kind === "allowed-color" && caseInsensitiveEquals(r.value, fill),
	);
	if (!onBrand && !allowed) {
		issues.push({ nodeId, code: "off-brand-color", property, value: fill });
	}
}

function checkFont(
	nodeId: string,
	property: string,
	fontFamily: CanvasFontFamily | undefined,
	brandKit: BrandKitDefinition,
	issues: BrandComplianceIssue[],
): void {
	if (fontFamily === undefined) return;
	if (typeof fontFamily !== "string") {
		if (!brandKit.fonts.some((f) => f.id === fontFamily.id)) {
			issues.push({
				nodeId,
				code: "unresolved-font-token",
				property,
				value: fontFamily.id,
			});
		}
		return;
	}
	const forbidden = brandKit.rules.find(
		(r) =>
			r.kind === "forbidden-font" && caseInsensitiveEquals(r.value, fontFamily),
	);
	if (forbidden) {
		issues.push({
			nodeId,
			code: "forbidden-font",
			property,
			value: fontFamily,
		});
		return;
	}
	if (brandKit.fonts.length === 0) return;
	const onBrand = brandKit.fonts.some((f) =>
		caseInsensitiveEquals(f.family, fontFamily),
	);
	const allowed = brandKit.rules.some(
		(r) =>
			r.kind === "allowed-font" && caseInsensitiveEquals(r.value, fontFamily),
	);
	if (!onBrand && !allowed) {
		issues.push({
			nodeId,
			code: "off-brand-font",
			property,
			value: fontFamily,
		});
	}
}

/**
 * Walks `document` and reports every unresolved brand-token reference,
 * forbidden color/font (per `brandKit.rules`), and off-brand literal color/font
 * value (a literal that matches neither a brand color/font nor an
 * `allowed-*` rule — only raised when the brand kit actually defines
 * colors/fonts to compare against, so an empty kit never floods the report).
 * Pure and read-only: never mutates `document`.
 */
export function generateBrandComplianceReport(
	document: CanvasIR,
	brandKit: BrandKitDefinition,
): BrandComplianceReport {
	const issues: BrandComplianceIssue[] = [];

	walk(document, ({ node }) => {
		switch (node.type) {
			case "rect":
			case "ellipse":
			case "polygon":
			case "star":
			case "path":
				checkColor(node.id, "fill", node.fill, brandKit, issues);
				// `stroke` is always a literal string (it cannot hold a brand
				// token — see applyBrandColors), but a literal can still be a
				// forbidden/off-brand color, so it's still worth flagging (C-17).
				checkColor(node.id, "stroke", node.stroke, brandKit, issues);
				break;
			case "line":
				checkColor(node.id, "stroke", node.stroke, brandKit, issues);
				break;
			case "text":
				checkColor(node.id, "fill", node.fill, brandKit, issues);
				checkFont(node.id, "fontFamily", node.fontFamily, brandKit, issues);
				break;
			case "rich-text":
				for (const paragraph of node.paragraphs) {
					for (const span of paragraph.spans) {
						checkColor(node.id, "fill", span.fill, brandKit, issues);
						checkFont(node.id, "fontFamily", span.fontFamily, brandKit, issues);
					}
				}
				break;
			case "frame":
				checkColor(node.id, "background", node.background, brandKit, issues);
				break;
			default:
				break;
		}
	});

	return { issues };
}
