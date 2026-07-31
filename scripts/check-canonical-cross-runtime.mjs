#!/usr/bin/env node

/**
 * Cross-runtime canonicalization check (plan 0021 T-006, GOLD; risk R-3).
 *
 * Runs the **shipped** `dist/component-libraries/canonicalize.js` inside a real
 * browser JavaScript engine and asserts it produces byte-identical output to the
 * committed goldens that Node's vitest suite verifies.
 *
 * ## Why a real browser, and not jsdom
 *
 * Of the three primitives the canonicalizer stands on, two are pinned by
 * ECMA-262 and cannot diverge: `JSON.stringify` number and string formatting, and
 * `TextEncoder`'s UTF-8. The third — `String.prototype.normalize("NFC")` — is
 * **ICU-backed**, and ICU ships with the engine. Node and a browser can carry
 * different ICU versions, and a Unicode version bump can change normalization for
 * newly-assigned or newly-composed characters.
 *
 * That is risk R-3, and it is the *only* one of the three that a jsdom "browser
 * environment" would not test at all, because jsdom runs on Node's own ICU. So
 * this check drives an actual browser or it reports that it did not run.
 *
 * ## Not part of `check:all`, on purpose
 *
 * `@anvilkit/canvas-core` is a submodule that must stay independently cloneable
 * and gate-green, and neither `playwright` nor a downloaded browser is one of its
 * dependencies (`playwright` is a devDependency of the superproject). Wiring a
 * check that can silently skip into `check:all` would let a skip read as a pass —
 * the precise failure mode this whole gate exists to prevent. It is therefore an
 * explicit script, and it exits **non-zero when it cannot verify**.
 *
 * Usage:
 *   node scripts/check-canonical-cross-runtime.mjs
 *   node scripts/check-canonical-cross-runtime.mjs --allow-skip   # CI opt-out
 */

import { execFileSync } from "node:child_process";
import { readFile, stat } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const PACKAGE_ROOT = resolve(__dirname, "..");
const DIST_ENTRY = resolve(
	PACKAGE_ROOT,
	"dist/component-libraries/canonicalize.js",
);
const GOLDENS = resolve(
	PACKAGE_ROOT,
	"src/component-libraries/__tests__/fixtures/canonical/goldens.json",
);

const ALLOW_SKIP = process.argv.includes("--allow-skip");
const PNPM_BIN = process.platform === "win32" ? "pnpm.cmd" : "pnpm";

const require = createRequire(import.meta.url);

function skipOrFail(reason) {
	if (ALLOW_SKIP) {
		console.log("");
		console.log(
			"check-canonical-cross-runtime: SKIPPED — NOT VERIFIED IN A BROWSER.",
		);
		console.log(`  reason: ${reason}`);
		console.log(
			"  This is NOT a pass. Cross-runtime NFC agreement (risk R-3) is unverified.",
		);
		console.log("");
		process.exit(0);
	}
	console.error("");
	console.error(`check-canonical-cross-runtime: CANNOT VERIFY — ${reason}`);
	console.error(
		"  Pass --allow-skip to downgrade this to a loud skip in an environment without a browser.",
	);
	process.exit(1);
}

async function ensureDist() {
	try {
		await stat(DIST_ENTRY);
	} catch {
		console.log(
			"check-canonical-cross-runtime: dist missing — running `pnpm build`",
		);
		execFileSync(PNPM_BIN, ["build"], { cwd: PACKAGE_ROOT, stdio: "inherit" });
	}
}

/**
 * Bundle the SHIPPED dist entry into one self-contained ESM string.
 *
 * Bundling `dist/` rather than `src/` is deliberate: it verifies the artifact a
 * consumer actually loads, and it avoids needing a TypeScript resolver for the
 * `.js`-suffixed specifiers `src/` uses.
 */
async function bundleForBrowser() {
	const { build } = await import("esbuild");
	const result = await build({
		absWorkingDir: PACKAGE_ROOT,
		bundle: true,
		entryPoints: [DIST_ENTRY],
		format: "iife",
		globalName: "AnvilKitCanonical",
		logLevel: "error",
		platform: "browser",
		target: "es2022",
		write: false,
	});

	if (result.errors.length > 0) {
		for (const error of result.errors) console.error(error);
		throw new Error("esbuild failed to bundle the canonicalizer");
	}

	return result.outputFiles[0].text;
}

async function main() {
	const goldens = JSON.parse(await readFile(GOLDENS, "utf8"));
	if (!Array.isArray(goldens) || goldens.length === 0) {
		console.error(
			"check-canonical-cross-runtime: FAIL — the golden fixture set is empty, so there is nothing to verify.",
		);
		process.exit(1);
	}

	let chromium;
	try {
		({ chromium } = require("playwright"));
	} catch {
		skipOrFail(
			"`playwright` is not resolvable from this package (it is a superproject devDependency)",
		);
		return;
	}

	await ensureDist();
	const bundle = await bundleForBrowser();

	let browser;
	try {
		browser = await chromium.launch();
	} catch (error) {
		skipOrFail(`chromium failed to launch: ${error.message}`);
		return;
	}

	try {
		const page = await browser.newPage();
		await page.setContent("<!doctype html><title>canonical</title>");
		await page.addScriptTag({ content: bundle });

		const engine = await page.evaluate(() => navigator.userAgent);

		const results = await page.evaluate((fixtures) => {
			const encoder = new TextEncoder();
			// biome-ignore lint/suspicious/noExplicitAny: browser-side global from the injected bundle
			const api = /** @type {any} */ (window).AnvilKitCanonical;
			if (!api?.canonicalizeComponentPayloadToString) {
				return { error: "bundle did not expose the canonicalizer" };
			}
			return {
				rows: fixtures.map((fixture) => {
					try {
						const text = api.canonicalizeComponentPayloadToString(fixture.input);
						const bytes = api.canonicalizeComponentPayload(fixture.input);
						return {
							name: fixture.name,
							text,
							// Hex so the comparison is byte-level, not string-level.
							hex: [...bytes]
								.map((b) => b.toString(16).padStart(2, "0"))
								.join(""),
							expectedHex: [...encoder.encode(fixture.expected)]
								.map((b) => b.toString(16).padStart(2, "0"))
								.join(""),
						};
					} catch (error) {
						return { name: fixture.name, threw: String(error) };
					}
				}),
			};
		}, goldens);

		if (results.error) {
			console.error(`check-canonical-cross-runtime: FAIL — ${results.error}`);
			process.exit(1);
		}

		const failures = [];
		for (const [index, row] of results.rows.entries()) {
			const golden = goldens[index];
			if (row.threw) {
				failures.push(`${row.name}: threw in browser — ${row.threw}`);
				continue;
			}
			if (row.text !== golden.expected) {
				failures.push(
					`${row.name}: text differs\n      browser:  ${JSON.stringify(row.text)}\n      expected: ${JSON.stringify(golden.expected)}`,
				);
				continue;
			}
			if (row.hex !== row.expectedHex) {
				failures.push(
					`${row.name}: BYTES differ despite equal text\n      browser:  ${row.hex}\n      expected: ${row.expectedHex}`,
				);
			}
		}

		console.log("check-canonical-cross-runtime");
		console.log(`  engine:   ${engine}`);
		console.log(`  fixtures: ${goldens.length}`);

		if (failures.length > 0) {
			console.error("");
			console.error(
				`check-canonical-cross-runtime: FAIL — ${failures.length}/${goldens.length} fixture(s) diverge between Node and the browser.`,
			);
			for (const failure of failures) console.error(`    ${failure}`);
			console.error("");
			console.error(
				"  A divergence here means stored snapshots would verify in one runtime and fail in the other. Do NOT paper over it by regenerating the goldens.",
			);
			process.exit(1);
		}

		console.log(
			`check-canonical-cross-runtime: OK — ${goldens.length}/${goldens.length} fixtures byte-identical in Node and the browser.`,
		);
	} finally {
		await browser.close();
	}
}

main().catch((error) => {
	console.error("check-canonical-cross-runtime: crashed unexpectedly");
	console.error(error);
	process.exit(2);
});
