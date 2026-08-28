import { execFileSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * M1-01 (plan 0023): the layering gate must classify the two new component
 * domains, and D-1's fold of `component-ops/` into the `templates` domain
 * must still forbid upward edges — templates is rank 4, `serialize/` is
 * rank 5, so a component-ops → serialize import is a violation the gate has
 * to catch. The gate's self-test pins that exact edge without writing a
 * temporary file into production `src/`, which would race parallel test files
 * running the whole-package gate.
 */

const PACKAGE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const SCRIPT = resolve(PACKAGE_ROOT, "scripts/check-layering.mjs");

function runGate(args: readonly string[] = []): { ok: boolean; output: string } {
	try {
		const output = execFileSync(process.execPath, [SCRIPT, ...args], {
			encoding: "utf8",
			stdio: ["ignore", "pipe", "pipe"],
		});
		return { ok: true, output };
	} catch (error) {
		const err = error as { stdout?: string; stderr?: string };
		return { ok: false, output: `${err.stdout ?? ""}${err.stderr ?? ""}` };
	}
}

describe("check:layering component domains (M1-01)", () => {
	it("passes on the clean tree with both domains classified", () => {
		const result = runGate();
		expect(result.ok, result.output).toBe(true);
	});

	it("fails a component-ops → serialize import (D-1 negative)", () => {
		const result = runGate(["--self-test"]);
		expect(result.ok, result.output).toBe(true);
		expect(result.output).toContain("self-test OK");
	});
});
