#!/usr/bin/env node

import { readdir, readFile } from "node:fs/promises";
import { dirname, extname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const PACKAGE_ROOT = resolve(__dirname, "..");
const SOURCE_DIR = resolve(PACKAGE_ROOT, "src");

/**
 * Dependency-direction gate for the domain layout documented in
 * docs/architecture/canvas-core-src-layout-review.md (§4). A module may only
 * import strictly lower-ranked domains (or its own domain). This is a coarse
 * direction check, not the full per-domain allowlist — its job is to stop
 * upward edges (e.g. ir/ importing extensions/) from creeping back in.
 * `__tests__` and *.test.ts files are exempt importers.
 *
 * A source file that matches no layer fails the check on purpose: new
 * top-level files/directories must be added here (and to the review doc)
 * so their layer assignment is a conscious decision.
 */
const LAYERS = [
	{ domain: "clock", rank: 0, match: (p) => p === "clock.ts" },
	{ domain: "ir", rank: 1, match: (p) => p.startsWith("ir/") },
	{ domain: "ai-contracts", rank: 2, match: (p) => p === "ai-contracts.ts" },
	// The headless text-measurement port. A host-implemented contract over IR
	// types, exactly like ai-contracts — so it sits at the same rank: it may read
	// `ir/` (rank 1) and nothing above.
	{ domain: "text-contracts", rank: 2, match: (p) => p === "text-contracts.ts" },
	{ domain: "geometry", rank: 2, match: (p) => p.startsWith("geometry/") },
	// The headless export job contract (FR-040, canvas-m3-001). Reads `ir/`
	// only — it defines types + a document-resolution helper, never calls the
	// `serialize/` (rank 5) serializers itself. Same rank as ai-contracts/
	// text-contracts/geometry for the same reason.
	{ domain: "export", rank: 2, match: (p) => p.startsWith("export/") },
	// The headless comment anchor contract (FR-072, canvas-m5-003). Reads `ir/`
	// only — a discriminated union + resolver over page/node ids, never touches
	// commands/extensions. Same rank as ai-contracts/text-contracts/export.
	{
		domain: "comment-contracts",
		rank: 2,
		match: (p) => p === "comment-contracts.ts",
	},
	{ domain: "commands", rank: 3, match: (p) => p.startsWith("commands/") },
	{ domain: "extensions", rank: 4, match: (p) => p.startsWith("extensions/") },
	// Template definition/instantiation (FR-020..022). Same rank as extensions —
	// it needs ir + commands (for the reversible-batch instantiation wrapper,
	// canvas-m2-003) but never touches extensions, and vice versa.
	{ domain: "templates", rank: 4, match: (p) => p.startsWith("templates/") },
	// The canonical Brand Kit contract (FR-031) + apply-brand transforms
	// (FR-032, canvas-m2-006). Bumped from rank 2 to rank 4 in canvas-m2-006:
	// the contract itself only reads `ir/`, but `applyBrandColors`/etc. wrap
	// their edits as a reversible `commands/` batch, the same pattern
	// `templates/` uses — so brand needs the same rank templates has.
	{ domain: "brand", rank: 4, match: (p) => p.startsWith("brand/") },
	{ domain: "serialize", rank: 5, match: (p) => p.startsWith("serialize/") },
	// Design-level AI job contracts (FR-050/052, canvas-m4-001/003). Needs
	// BOTH templates (CanvasSizePreset id) and brand (BrandKitDefinition)
	// types — same-rank siblings that don't depend on each other — plus
	// commands (CanvasCommand payload shape) and ir/validators (schema
	// validation for canvas-m4-003's quarantine layer), so it must outrank
	// all of them, hence rank 5 alongside serialize (no dependency either
	// way between the two).
	{
		domain: "ai-design-contracts",
		rank: 5,
		match: (p) => p === "ai-design-contracts.ts",
	},
	{ domain: "root", rank: 6, match: (p) => p === "index.ts" },
];

const TEST_FILE_PATTERN = /\.(test|spec)\.[cm]?tsx?$/;
const IMPORT_SPECIFIER_PATTERN =
	/\b(?:from|import)\s*\(?\s*["'](\.{1,2}\/[^"']+)["']/g;

function classify(srcRelativePath) {
	return LAYERS.find((layer) => layer.match(srcRelativePath)) ?? null;
}

/** Returns a violation message for edge importer→importee, or null if legal. */
function checkEdge(importerPath, importeePath) {
	const importer = classify(importerPath);
	const importee = classify(importeePath);
	if (!importer) {
		return `${importerPath} matches no layer in check-layering.mjs — assign it one.`;
	}
	if (!importee) {
		return `${importerPath} imports ${importeePath}, which matches no layer in check-layering.mjs — assign it one.`;
	}
	if (importer.domain === importee.domain) return null;
	if (importer.rank > importee.rank) return null;
	return `${importerPath} -> ${importeePath}  (${importer.domain}, rank ${importer.rank}, must not depend on ${importee.domain}, rank ${importee.rank})`;
}

async function* walkSourceFiles(dir) {
	const entries = await readdir(dir, { withFileTypes: true });
	for (const entry of entries) {
		const fullPath = join(dir, entry.name);
		if (entry.isDirectory()) {
			if (entry.name === "__tests__" || entry.name === "node_modules") {
				continue;
			}
			yield* walkSourceFiles(fullPath);
			continue;
		}
		if (
			entry.isFile() &&
			extname(entry.name) === ".ts" &&
			!TEST_FILE_PATTERN.test(entry.name)
		) {
			yield fullPath;
		}
	}
}

/** Resolve a relative specifier to a src-relative .ts path (posix separators). */
function resolveSpecifier(importerSrcRelative, specifier) {
	const joined = join(dirname(importerSrcRelative), specifier);
	const normalized = joined.split("\\").join("/");
	if (normalized.startsWith("..")) return null; // escapes src/ (not an internal edge)
	return normalized.replace(/\.js$/, ".ts");
}

async function collectViolations() {
	const violations = [];
	let edgeCount = 0;

	for await (const filePath of walkSourceFiles(SOURCE_DIR)) {
		const importerSrcRelative = relative(SOURCE_DIR, filePath)
			.split("\\")
			.join("/");
		const text = await readFile(filePath, "utf8");
		for (const match of text.matchAll(IMPORT_SPECIFIER_PATTERN)) {
			const importeeSrcRelative = resolveSpecifier(
				importerSrcRelative,
				match[1],
			);
			if (!importeeSrcRelative) continue;
			edgeCount += 1;
			const violation = checkEdge(importerSrcRelative, importeeSrcRelative);
			if (violation) violations.push(violation);
		}
	}

	return { violations, edgeCount };
}

function selfTest() {
	const cases = [
		// [importer, importee, expectViolation]
		["ir/validators.ts", "extensions/canvas-runtime.ts", true], // upward
		["extensions/canvas-runtime.ts", "ir/migrations.ts", false], // downward
		["geometry/affine.ts", "ai-contracts.ts", true], // equal rank, cross-domain
		["ir/builders.ts", "ir/validators.ts", false], // same domain
		["commands/runtime.ts", "clock.ts", false], // downward to leaf
		["clock.ts", "unmapped-thing.ts", true], // unmapped importee
	];
	const failures = cases.filter(
		([importer, importee, expectViolation]) =>
			Boolean(checkEdge(importer, importee)) !== expectViolation,
	);
	if (failures.length > 0) {
		console.error("check-layering: SELF-TEST FAIL");
		for (const [importer, importee] of failures) {
			console.error(`  unexpected verdict for ${importer} -> ${importee}`);
		}
		process.exit(1);
	}
	console.log(`check-layering: self-test OK (${cases.length} cases).`);
}

async function main() {
	if (process.argv.includes("--self-test")) {
		selfTest();
		return;
	}

	const { violations, edgeCount } = await collectViolations();
	if (violations.length === 0) {
		console.log(
			`check-layering: OK — ${edgeCount} internal import edges respect the layer order.`,
		);
		return;
	}

	console.error("check-layering: FAIL");
	console.error("");
	console.error("The following imports point at an equal or higher layer:");
	console.error("");
	for (const violation of violations) {
		console.error(`  ${violation}`);
	}
	console.error("");
	console.error(
		"Lower layers must not depend on higher ones (see docs/architecture/canvas-core-src-layout-review.md §4).",
	);
	process.exit(1);
}

main().catch((error) => {
	console.error("check-layering: crashed unexpectedly");
	console.error(error);
	process.exit(2);
});
