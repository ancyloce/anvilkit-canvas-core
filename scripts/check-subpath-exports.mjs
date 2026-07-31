#!/usr/bin/env node

/**
 * Resolution gate for every entry in `package.json` `exports` (plan 0021
 * T-001).
 *
 * `check:publint` already validates the exports MAP against a real packed
 * tarball, and `check:bundle-budget` measures each entry's cost — but neither
 * one ever *loads* a subpath. This gate does, through Node's own resolver via
 * package self-reference, so the failure modes those two cannot see are caught:
 *
 * - a `types` condition pointing at a `.d.cts` the CJS declaration pass never
 *   emitted (`dist/cjs/**`), which typechecks fine in this repo and breaks only
 *   in a consumer's `require()`;
 * - an `import`/`require` target that survives `publint` because the file
 *   exists, but throws on evaluation;
 * - a subpath added to `exports` whose source barrel was never created.
 *
 * Deliberately built on Node built-ins only (`import()`, `createRequire`,
 * `node:fs`) rather than a resolver library — the point is to exercise the real
 * resolver a consumer will use, not a model of it.
 */

import { createRequire } from "node:module";
import { readFile, stat } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const PACKAGE_ROOT = resolve(__dirname, "..");
const PACKAGE_JSON = resolve(PACKAGE_ROOT, "package.json");

const require = createRequire(import.meta.url);

async function fileExists(absolutePath) {
	try {
		return (await stat(absolutePath)).isFile();
	} catch {
		return false;
	}
}

/**
 * Collect the { condition, specifier, target } triples declared for one export
 * key. Only the shapes this package actually uses are understood; an unexpected
 * shape is reported rather than skipped, so a future refactor cannot silently
 * drop a subpath out of coverage.
 */
function collectTargets(exportKey, exportValue, failures) {
	const targets = [];

	if (typeof exportValue === "string") {
		targets.push({ condition: "default", target: exportValue });
		return targets;
	}

	if (exportValue === null || typeof exportValue !== "object") {
		failures.push(`${exportKey}: unsupported exports value ${typeof exportValue}`);
		return targets;
	}

	for (const [condition, value] of Object.entries(exportValue)) {
		if (condition !== "import" && condition !== "require") {
			failures.push(
				`${exportKey}: unrecognized top-level condition "${condition}" — extend check-subpath-exports.mjs`,
			);
			continue;
		}
		if (value === null || typeof value !== "object") {
			failures.push(`${exportKey}.${condition}: expected an object of conditions`);
			continue;
		}
		for (const [inner, target] of Object.entries(value)) {
			if (typeof target !== "string") {
				failures.push(`${exportKey}.${condition}.${inner}: target is not a string`);
				continue;
			}
			targets.push({ condition: `${condition}.${inner}`, target });
		}
	}

	return targets;
}

async function main() {
	const pkg = JSON.parse(await readFile(PACKAGE_JSON, "utf8"));
	const exportsMap = pkg.exports;

	if (!exportsMap || typeof exportsMap !== "object") {
		console.error("check-subpath-exports: FAIL — package.json has no `exports` object.");
		process.exit(1);
	}

	const failures = [];
	let checkedFiles = 0;
	let loadedEsm = 0;
	let loadedCjs = 0;

	for (const [exportKey, exportValue] of Object.entries(exportsMap)) {
		// `./package.json` is a raw JSON passthrough, not a module entry.
		if (exportKey === "./package.json") continue;

		for (const { condition, target } of collectTargets(
			exportKey,
			exportValue,
			failures,
		)) {
			const absolute = resolve(PACKAGE_ROOT, target);
			if (await fileExists(absolute)) {
				checkedFiles += 1;
			} else {
				failures.push(
					`${exportKey} [${condition}] -> ${target} does not exist (run \`pnpm build\`)`,
				);
			}
		}

		// Exercise the real resolver via self-reference, which is what a
		// consumer's `import`/`require` of this specifier will do.
		const specifier =
			exportKey === "." ? pkg.name : `${pkg.name}${exportKey.slice(1)}`;

		try {
			await import(specifier);
			loadedEsm += 1;
		} catch (error) {
			failures.push(`import("${specifier}") threw: ${error.message}`);
		}

		try {
			require(specifier);
			loadedCjs += 1;
		} catch (error) {
			failures.push(`require("${specifier}") threw: ${error.message}`);
		}
	}

	const entryCount = Object.keys(exportsMap).filter(
		(key) => key !== "./package.json",
	).length;

	if (failures.length > 0) {
		console.error("check-subpath-exports: FAIL");
		console.error("");
		for (const failure of failures) {
			console.error(`  ${failure}`);
		}
		process.exit(1);
	}

	console.log(
		`check-subpath-exports: OK — ${entryCount} entries, ${checkedFiles} declared files present, ${loadedEsm} loaded via import(), ${loadedCjs} via require().`,
	);
}

main().catch((error) => {
	console.error("check-subpath-exports: crashed unexpectedly");
	console.error(error);
	process.exit(2);
});
