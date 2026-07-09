#!/usr/bin/env node

import { readdir, readFile } from "node:fs/promises";
import { dirname, extname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const PACKAGE_ROOT = resolve(__dirname, "..");
const SOURCE_DIR = resolve(PACKAGE_ROOT, "src");

const SOURCE_EXTENSIONS = new Set([
	".ts",
	".tsx",
	".mts",
	".cts",
	".js",
	".jsx",
	".mjs",
	".cjs",
]);

const TEST_FILE_PATTERN = /\.(test|spec)\.[cm]?[jt]sx?$/;
// canvas-core must stay React-free AND Konva-free (package contract).
const FORBIDDEN_IMPORT_PATTERN =
	/\bfrom\s+['"](react|react-dom|react-konva|konva)(\/[^'"]*)?['"]|\bimport\s*\(\s*['"](react|react-dom|react-konva|konva)(\/[^'"]*)?['"]\s*\)/;

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

		if (!entry.isFile()) {
			continue;
		}

		if (
			SOURCE_EXTENSIONS.has(extname(entry.name)) &&
			!TEST_FILE_PATTERN.test(entry.name)
		) {
			yield fullPath;
		}
	}
}

async function scanFile(filePath) {
	const text = await readFile(filePath, "utf8");
	const lines = text.split(/\r?\n/);
	const hits = [];

	for (let index = 0; index < lines.length; index += 1) {
		const line = lines[index];
		if (FORBIDDEN_IMPORT_PATTERN.test(line)) {
			hits.push({ line: index + 1, text: line.trim() });
		}
	}

	return hits;
}

async function main() {
	const offenders = [];

	for await (const filePath of walkSourceFiles(SOURCE_DIR)) {
		const hits = await scanFile(filePath);
		if (hits.length > 0) {
			offenders.push({ filePath, hits });
		}
	}

	if (offenders.length === 0) {
		console.log(
			"check-react-free: OK — no React or Konva imports found under src/",
		);
		return;
	}

	console.error("check-react-free: FAIL");
	console.error("");
	console.error(
		"The following source files import `react`, `react-dom`, `react-konva`, or `konva`:",
	);
	console.error("");

	for (const { filePath, hits } of offenders) {
		for (const hit of hits) {
			console.error(
				`  ${relative(PACKAGE_ROOT, filePath)}:${hit.line}  ${hit.text}`,
			);
		}
	}

	console.error("");
	console.error(
		"This package must stay React-free and Konva-free. Move the import to @anvilkit/canvas-editor or remove it.",
	);
	process.exit(1);
}

main().catch((error) => {
	console.error("check-react-free: crashed unexpectedly");
	console.error(error);
	process.exit(2);
});
