import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
	BUILTIN_COMMAND_TYPES,
	createCanvasRuntime,
} from "../../extensions/canvas-runtime.js";
import type { CanvasIR } from "../../ir/types.js";

/**
 * @file T-M0-02 (plan 0022 M0) — built-in command registry parity.
 *
 * `BUILTIN_COMMAND_TYPES` (`extensions/canvas-runtime.ts`) claims in its own
 * docstring to "mirror the `applyCommand` switch", and three behaviours
 * depend on that claim holding:
 *
 * 1. `rt.apply` routes a type in the set to the static `applyCommand`; a
 *    type NOT in the set falls through to the custom-handler lookup and
 *    throws "no command handler registered" even though it is a real,
 *    documented built-in.
 * 2. `createCommandRegistry(builtins)` rejects an extension that tries to
 *    shadow a built-in. A type missing from the set is therefore silently
 *    shadowable — an extension can hijack a core command.
 * 3. `applyCommand` has a throwing `default:`, so an omission never fails
 *    the build; it fails at first real use, in a host application.
 *
 * This drift has already bitten once (`page.set-layout-aids`, covered by a
 * single-command regression test in `extensions/__tests__/canvas-runtime.test.ts`)
 * and again for `node.applyStyle`. A per-command test only ever catches the
 * command someone thought to write a test for, so this suite derives the
 * expected set from the `applyCommand` switch itself.
 */

/**
 * Every `case "…":` label in `applyCommand`'s switch, read from source.
 *
 * The switch is the authoritative list of what Core actually implements, and
 * it is not enumerable at runtime (a TypeScript union erases). Reading the
 * source is what lets this test fail on an omission rather than merely
 * restating a hand-maintained list — a duplicated literal array here would
 * drift in exactly the same way the set under test did.
 */
function commandTypesHandledByApplyCommand(): ReadonlySet<string> {
	const source = readFileSync(
		fileURLToPath(new URL("../runtime.ts", import.meta.url)),
		"utf8",
	);
	const start = source.indexOf("export function applyCommand");
	expect(
		start,
		"applyCommand not found in commands/runtime.ts",
	).toBeGreaterThan(-1);
	// Bound the scan to applyCommand's own switch: it ends at the `default:`
	// branch that throws `unknown-command`.
	const end = source.indexOf('"unknown-command"', start);
	expect(
		end,
		"applyCommand's unknown-command default not found",
	).toBeGreaterThan(start);

	const body = source.slice(start, end);
	const types = new Set<string>();
	for (const match of body.matchAll(/case\s+"([^"]+)":/g)) {
		const type = match[1];
		if (type !== undefined) types.add(type);
	}
	return types;
}

describe("built-in command registry parity (T-M0-02)", () => {
	it("BUILTIN_COMMAND_TYPES covers every command applyCommand handles", () => {
		const handled = commandTypesHandledByApplyCommand();

		// Guard the guard: if the source scan ever silently matches nothing,
		// the set-difference assertions below would vacuously pass.
		expect(handled.size).toBeGreaterThan(20);

		const missing = [...handled]
			.filter((type) => !BUILTIN_COMMAND_TYPES.has(type))
			.sort();
		expect(
			missing,
			"command types implemented by applyCommand but absent from BUILTIN_COMMAND_TYPES — these are shadowable by extensions and unreachable through rt.apply",
		).toEqual([]);
	});

	it("BUILTIN_COMMAND_TYPES contains no type applyCommand cannot handle", () => {
		const handled = commandTypesHandledByApplyCommand();
		const extra = [...BUILTIN_COMMAND_TYPES]
			.filter((type) => !handled.has(type))
			.sort();
		expect(
			extra,
			"types registered as built-in but not implemented by applyCommand — rt.apply would route these to a throwing default",
		).toEqual([]);
	});

	it("rejects an extension shadowing any built-in command", () => {
		// The security property the set exists to enforce, asserted for every
		// built-in rather than a hand-picked one. Payload-free: registration is
		// rejected at runtime construction, before any command is applied.
		for (const type of commandTypesHandledByApplyCommand()) {
			expect(
				() =>
					createCanvasRuntime([
						{
							id: `shadow-${type}`,
							commands: [
								{
									type,
									apply: (ir: CanvasIR) => ({ ir, inverse: { type } }),
								},
							],
						},
					]),
				`extension shadowing built-in "${type}" was accepted`,
			).toThrow(/builtin-command-shadowed|cannot be shadowed/i);
		}
	});
});
