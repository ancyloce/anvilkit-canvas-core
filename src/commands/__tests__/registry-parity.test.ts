import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { createCanvasRuntime } from "../../extensions/canvas-runtime.js";
import type { CanvasIR } from "../../ir/types.js";

/**
 * @file T-M0-02 (plan 0022 M0) — built-in command registry parity.
 *
 * `BUILTIN_COMMAND_TYPES` (`extensions/canvas-runtime.ts`) claims in its own
 * docstring to "mirror the `applyCommand` switch", and two behaviours depend
 * on that claim holding:
 *
 * 1. `rt.apply` routes a type in the set to the static `applyCommand`; a type
 *    NOT in the set falls through to the custom-handler lookup and throws
 *    "no command handler registered" even though it is a real, documented
 *    built-in.
 * 2. `createCommandRegistry(builtins)` rejects an extension that tries to
 *    shadow a built-in. A type missing from the set is therefore silently
 *    shadowable — an extension can hijack a core command.
 *
 * `applyCommand`'s throwing `default:` cannot catch this class of omission,
 * because an omitted type never reaches `applyCommand` at all — the
 * custom-handler lookup intercepts it first. The drift has bitten twice:
 * `page.set-layout-aids`, and then `node.applyStyle` in 0.1.2-rc.1.
 *
 * Parity is enforced in two complementary places. The *compile-time* half
 * lives in `canvas-runtime.ts`, where the built-in list is declared as a
 * `Record<CanvasCommand["type"], true>`: an omission fails typecheck naming
 * the missing command, and an extra key is an excess-property error. This
 * file covers the *runtime* half, asserting the guarantee each built-in is
 * supposed to carry. It deliberately does NOT import the set — a test that
 * restates the list it is checking drifts in exactly the way the list did.
 */

/**
 * Every `case "…":` label in `applyCommand`'s switch, read from source.
 *
 * The switch is the authoritative list of what Core actually implements, and
 * it is not enumerable at runtime (a TypeScript union erases at compile
 * time). Reading the source is what lets this test fail on an omission
 * rather than merely restating a hand-maintained array.
 */
function commandTypesHandledByApplyCommand(): ReadonlySet<string> {
	const source = readFileSync(
		fileURLToPath(new URL("../runtime.ts", import.meta.url)),
		"utf8",
	);
	const start = source.indexOf("export function applyCommand");
	expect(
		start,
		"applyCommand not found in commands/runtime.ts — this scan needs updating",
	).toBeGreaterThan(-1);
	// Bound the scan to applyCommand's own switch: it ends at the `default:`
	// branch that throws `unknown-command`.
	const end = source.indexOf('"unknown-command"', start);
	expect(
		end,
		"applyCommand's unknown-command default not found — this scan needs updating",
	).toBeGreaterThan(start);

	const types = new Set<string>();
	for (const match of source.slice(start, end).matchAll(/case\s+"([^"]+)":/g)) {
		const type = match[1];
		if (type !== undefined) types.add(type);
	}
	return types;
}

describe("built-in command registry parity (T-M0-02)", () => {
	it("finds the built-in command switch", () => {
		// Guards the guard: if the source scan ever silently matches nothing,
		// the per-command assertions below would vacuously pass.
		expect(commandTypesHandledByApplyCommand().size).toBeGreaterThan(20);
	});

	it("refuses to let an extension shadow any built-in command", () => {
		// The security property the built-in set exists to enforce, asserted
		// for every command Core implements rather than a hand-picked one.
		// Payload-free: registration is rejected at runtime construction,
		// before any command is applied.
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
				`extension shadowing built-in "${type}" was accepted — it is missing from BUILTIN_COMMAND_TYPES`,
			).toThrow(/builtin-command-shadowed|cannot be shadowed/i);
		}
	});
});
