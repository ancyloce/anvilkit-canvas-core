import { execFileSync } from "node:child_process";
import { rmSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

/**
 * M1-01 (plan 0023): the layering gate must classify the two new component
 * domains, and D-1's fold of `component-ops/` into the `templates` domain
 * must still forbid upward edges — templates is rank 4, `serialize/` is
 * rank 5, so a component-ops → serialize import is a violation the gate has
 * to catch. Probed by writing a real (non-test-exempt) file into the domain
 * and running the actual gate script, because the gate has no other seam.
 */

const PACKAGE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const SCRIPT = resolve(PACKAGE_ROOT, "scripts/check-layering.mjs");
const PROBE = resolve(PACKAGE_ROOT, "src/component-ops/__layering-probe.ts");

function runGate(): { ok: boolean; output: string } {
	try {
		const output = execFileSync(process.execPath, [SCRIPT], {
			encoding: "utf8",
			stdio: ["ignore", "pipe", "pipe"],
		});
		return { ok: true, output };
	} catch (error) {
		const err = error as { stdout?: string; stderr?: string };
		return { ok: false, output: `${err.stdout ?? ""}${err.stderr ?? ""}` };
	}
}

afterEach(() => {
	rmSync(PROBE, { force: true });
});

describe("check:layering component domains (M1-01)", () => {
	it("passes on the clean tree with both domains classified", () => {
		const result = runGate();
		expect(result.ok, result.output).toBe(true);
	});

	it("fails a component-ops → serialize import (D-1 negative)", () => {
		writeFileSync(
			PROBE,
			'import { serializePageToSvg } from "../serialize/svg.js";\n' +
				"export const probe = typeof serializePageToSvg;\n",
		);
		const result = runGate();
		expect(result.ok).toBe(false);
		expect(result.output).toContain("component-ops");
	});
});
