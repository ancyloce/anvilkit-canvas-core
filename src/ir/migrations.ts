/** One step in the IR version chain, e.g. "1" → "2". */
export interface CanvasMigration {
	readonly from: string;
	readonly to: string;
	/** Structural upgrade applied BEFORE schema parse. */
	readonly up: (raw: unknown) => unknown;
}

export interface CanvasMigrationRegistry {
	register(m: CanvasMigration): void;
	has(from: string): boolean;
	/**
	 * Apply the chain from `raw.version` up to `target`. Returns `raw` unchanged
	 * when already at `target`. Throws on a missing step or a version cycle.
	 */
	migrate(raw: unknown, target: string): unknown;
}

function readVersion(raw: unknown): string | undefined {
	if (raw && typeof raw === "object") {
		const v = (raw as { version?: unknown }).version;
		if (typeof v === "string") return v;
	}
	return undefined;
}

/**
 * Production migrations for the core CanvasIR version chain, seeded into
 * every registry so a zero-extension runtime still reads old documents.
 *
 * v1 → v2 is a pure structural version bump — every valid v1 document is a
 * valid v2 document — so `up` only rewrites the version tag; all other
 * fields (including unknown ones) ride along via the spread.
 */
export const CANVAS_IR_MIGRATIONS: readonly CanvasMigration[] = [
	{
		from: "1",
		to: "2",
		up: (raw) => ({ ...(raw as object), version: "2" }),
	},
];

/**
 * Create a registry pre-seeded with {@link CANVAS_IR_MIGRATIONS}; `register`
 * adds extension steps (re-registering a `from` overrides the earlier step).
 */
export function createMigrationRegistry(): CanvasMigrationRegistry {
	const byFrom = new Map<string, CanvasMigration>(
		CANVAS_IR_MIGRATIONS.map((m) => [m.from, m]),
	);
	return {
		register(m) {
			byFrom.set(m.from, m);
		},
		has(from) {
			return byFrom.has(from);
		},
		migrate(raw, target) {
			let current = raw;
			let version = readVersion(current);
			const seen = new Set<string>();
			while (version !== target) {
				if (version === undefined) {
					throw new Error(
						`migrate: cannot read a string "version" from the document (target "${target}").`,
					);
				}
				if (seen.has(version)) {
					throw new Error(
						`migrate: migration cycle detected at version "${version}".`,
					);
				}
				seen.add(version);
				const step = byFrom.get(version);
				if (!step) {
					throw new Error(
						`migrate: no migration registered from version "${version}" toward "${target}".`,
					);
				}
				current = step.up(current);
				version = readVersion(current);
			}
			return current;
		},
	};
}
