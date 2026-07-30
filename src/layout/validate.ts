import {
	CANVAS_COMPONENTS_LOCAL_CAPABILITY,
	CANVAS_COMPONENTS_OVERRIDES_CAPABILITY,
	CANVAS_LAYOUT_AUTO_CAPABILITY,
} from "../ir/invariants.js";
import type {
	CanvasFrameNode,
	CanvasIR,
	CanvasLayoutDirection,
	CanvasLayoutSizing,
	CanvasNode,
} from "../ir/types.js";
import { CanvasIRDepthError, walk } from "../ir/walkers.js";
import { MAX_FINITE_LAYOUT_MAGNITUDE } from "../limits.js";
import { SIZING_FIELD_AXIS, SIZING_FIELDS } from "./axis.js";

/**
 * @file Layout invariants (TD §14) — the level-3 half of Auto Layout
 * validation.
 *
 * Deliberately parallel to `ir/invariants.ts`: a plain readonly record, never
 * thrown, with a throwing `assert*` wrapper alongside. It is **additive** to
 * `CanvasInvariantIssueCode`, not a replacement — that union keeps owning
 * document-wide facts (duplicate ids, dangling assets, `excessive-tree-depth`,
 * and now `missing-required-capability`), while this one owns layout
 * semantics.
 *
 * **Scope of this module in M1.** The 11-code union below is the complete,
 * frozen taxonomy (TD §14) and nothing may be added to it. Eight codes are
 * decidable from the IR alone and are emitted here. Three are inherently
 * resolution-time facts — they cannot be known without running the solver —
 * and are emitted by the resolver in M2 (T-M2-06):
 *
 * - `layout-insufficient-space` — needs resolved extents.
 * - `layout-measurement-missing` — needs the measurement port.
 * - `layout-materialization-stale` — needs the engine's `inputHash`.
 *
 * They are declared here so the contract is complete from M1 onward and M2
 * adds behaviour, never taxonomy.
 *
 * **On the "only Frame may carry `autoLayout`" rule (TD §6.2).** It is
 * enforced structurally rather than diagnostically: `autoLayout` exists only
 * on `CanvasFrameNodeShape`, so on any other kind it is an unknown key that
 * `z.looseObject` preserves and every consumer ignores. TD §14's union has no
 * member for "layout intent on the wrong kind", and inventing a 12th code
 * would create exactly the parallel taxonomy this design forbids — so a
 * misplaced `autoLayout` is inert data, and that is asserted by test rather
 * than reported as an issue.
 */

export type CanvasLayoutIssueCode =
	| "layout-invalid-number"
	| "layout-negative-gap"
	| "layout-negative-padding"
	| "layout-hug-unsupported"
	| "layout-fill-without-parent"
	| "layout-circular-sizing"
	| "layout-insufficient-space"
	| "layout-measurement-missing"
	| "layout-depth-exceeded"
	| "layout-materialization-stale"
	| "layout-capability-unsupported";

export type CanvasLayoutIssueSeverity = "warning" | "error";

/**
 * The deterministic degradation a consumer applies when an issue fires.
 *
 * Absent where TD §14's prescribed recovery is not one of these three (for
 * example "clamp to 0", which the negative-gap/padding codes use) — the field
 * names a *substituted geometry source*, not every possible remedy.
 */
export type CanvasLayoutIssueFallback =
	| "fixed-size"
	| "zero-fill"
	| "cached-geometry";

export interface CanvasLayoutIssue {
	readonly code: CanvasLayoutIssueCode;
	readonly severity: CanvasLayoutIssueSeverity;
	/** The node the issue was found on, when the issue is node-scoped. */
	readonly nodeId?: string;
	/** The axis the issue applies to, when the issue is axis-scoped. */
	readonly axis?: CanvasLayoutDirection;
	readonly message: string;
	readonly fallback?: CanvasLayoutIssueFallback;
}

/**
 * The normative TD §14 severity/fallback table, as data.
 *
 * A `Record` keyed by the union rather than a list of literals at each emit
 * site, so it is **compiler-enforced exhaustive**: omitting a code is a
 * typecheck failure naming the missing member, and naming a non-code is an
 * excess-property error. That is what stops the taxonomy and the table from
 * drifting apart as M2 lands the three resolution-time codes — the same class
 * of bug `BUILTIN_COMMAND_TYPE_FLAGS` exists to prevent for commands.
 *
 * `fallback` is omitted where TD §14's prescribed recovery is not a
 * substituted geometry source (the negative-gap and negative-padding codes
 * clamp to 0 instead).
 */
export const CANVAS_LAYOUT_ISSUE_DEFAULTS: Readonly<
	Record<
		CanvasLayoutIssueCode,
		{
			readonly severity: CanvasLayoutIssueSeverity;
			readonly fallback?: CanvasLayoutIssueFallback;
		}
	>
> = {
	"layout-invalid-number": { severity: "error", fallback: "fixed-size" },
	"layout-negative-gap": { severity: "error" },
	"layout-negative-padding": { severity: "error" },
	"layout-hug-unsupported": { severity: "warning", fallback: "fixed-size" },
	"layout-fill-without-parent": {
		severity: "warning",
		fallback: "fixed-size",
	},
	"layout-circular-sizing": { severity: "error", fallback: "cached-geometry" },
	"layout-insufficient-space": { severity: "warning", fallback: "zero-fill" },
	"layout-measurement-missing": {
		severity: "warning",
		fallback: "cached-geometry",
	},
	"layout-depth-exceeded": { severity: "error", fallback: "cached-geometry" },
	"layout-materialization-stale": { severity: "warning" },
	"layout-capability-unsupported": {
		severity: "error",
		fallback: "cached-geometry",
	},
};

/**
 * Build an issue with its severity/fallback taken from the normative table.
 *
 * Exported for the rest of the `layout/` domain — the resolver, the dependency
 * graph and the measurement pass all emit issues, and each choosing its own
 * severity literal is how a code's severity ends up disagreeing with TD §14
 * depending on which module happened to raise it. Deliberately **not** in
 * `layout/index.ts`: emitting a diagnostic is the resolver's job, not a host's.
 */
export function createLayoutIssue(
	code: CanvasLayoutIssueCode,
	detail: { message: string; nodeId?: string; axis?: CanvasLayoutDirection },
): CanvasLayoutIssue {
	const { severity, fallback } = CANVAS_LAYOUT_ISSUE_DEFAULTS[code];
	return { code, severity, ...(fallback ? { fallback } : {}), ...detail };
}

/** Domain-internal alias keeping the emit sites in this file terse. */
const issue = createLayoutIssue;

/**
 * Capabilities this build implements. Used ONLY to decide whether a declared
 * capability is honourable — never to constrain what a document may declare
 * (see `CanvasDocumentCompatibility.requiredCapabilities`).
 */
const KNOWN_CAPABILITIES: ReadonlySet<string> = new Set([
	CANVAS_LAYOUT_AUTO_CAPABILITY,
	// Plan 0023 M6-06 — the flip M3-12 deliberately deferred to this phase. From
	// here on this build IMPLEMENTS Local Components, so a component-bearing
	// document is fully editable rather than routed to read-only preview. Flipping
	// it earlier would have declared support the resolver/editor did not yet have.
	CANVAS_COMPONENTS_LOCAL_CAPABILITY,
	CANVAS_COMPONENTS_OVERRIDES_CAPABILITY,
]);

/**
 * Kinds whose size is *only* their stored bounds, so Hug has nothing to
 * measure on either axis.
 *
 * Deliberately conservative: it lists the pure geometric primitives, whose
 * lack of intrinsic content is unambiguous, and stays silent about the
 * debatable cases. The normative per-kind sizing-precedence table is owned by
 * T-M2-05; this set exists so the clear violations are caught in M1 without
 * pre-empting that table's judgement calls.
 */
const NON_INTRINSIC_KINDS: ReadonlySet<CanvasNode["type"]> = new Set([
	"rect",
	"ellipse",
	"polygon",
	"star",
	"line",
	"path",
]);

/** Is this frame standing in for content it does not have yet? */
function rendersPlaceholder(node: CanvasFrameNode): boolean {
	return node.placeholder !== undefined && node.children.length === 0;
}

function isFrameWithLayout(node: CanvasNode | null): node is CanvasFrameNode & {
	autoLayout: NonNullable<CanvasFrameNode["autoLayout"]>;
} {
	return (
		node !== null && node.type === "frame" && node.autoLayout !== undefined
	);
}

/**
 * Axis a given sizing field controls, and the fields to iterate.
 *
 * Both moved to `axis.ts` in T-M2-04 so the dependency graph and the solver
 * read the same table this validator does — a second copy is how an issue's
 * `axis` ends up disagreeing with the axis the solver actually demoted.
 */
const AXIS_OF = SIZING_FIELD_AXIS;

function isBadNumber(value: number): boolean {
	return (
		!Number.isFinite(value) || Math.abs(value) > MAX_FINITE_LAYOUT_MAGNITUDE
	);
}

/**
 * Validate Auto Layout semantics across a document (TD §6.2, level 3).
 *
 * Pure and read-only; never throws for a malformed-but-schema-valid document
 * — malformations are reported as issues (use {@link assertLayoutInvariants}
 * for a throwing variant). Runs a single `walk` over the document.
 *
 * Issues come back in the fully specified TD §14 order, so the output is
 * byte-stable across runs and safe to snapshot.
 */
export function validateLayoutInvariants(ir: CanvasIR): CanvasLayoutIssue[] {
	const issues: CanvasLayoutIssue[] = [];

	// Unsupportedness is level 4 and NEVER rejects: the document may be
	// perfectly well-formed and merely newer than this reader. Reported first
	// because it is document-scoped and carries no node.
	for (const capability of ir.compatibility?.requiredCapabilities ?? []) {
		if (!KNOWN_CAPABILITIES.has(capability)) {
			issues.push(
				issue("layout-capability-unsupported", {
					message: `Document requires capability "${capability}", which this build does not implement. Render read-only from the materialized cache; block mutating commands.`,
				}),
			);
		}
	}

	// Position index for the TD §14 sort key, filled by the same walk that
	// does the validation — pre-order, so `order` IS tree order.
	const position = new Map<string, { pageIndex: number; order: number }>();
	const pageIndexOf = new Map<string, number>();
	ir.pages.forEach((page, index) => pageIndexOf.set(page.id, index));
	let order = 0;

	try {
		walk(ir, ({ node, page, parent }) => {
			position.set(node.id, {
				pageIndex: pageIndexOf.get(page.id) ?? 0,
				order: order++,
			});

			if (node.type === "frame" && node.autoLayout) {
				const { gap, padding } = node.autoLayout;
				if (isBadNumber(gap)) {
					issues.push(
						issue("layout-invalid-number", {
							nodeId: node.id,
							message: `Frame "${node.id}" has a non-finite or out-of-range gap (${gap}).`,
						}),
					);
				} else if (gap < 0) {
					issues.push(
						issue("layout-negative-gap", {
							nodeId: node.id,
							message: `Frame "${node.id}" has a negative gap (${gap}). Gap never collapses — an overfull frame overflows instead.`,
						}),
					);
				}
				for (const edge of ["top", "right", "bottom", "left"] as const) {
					const value = padding[edge];
					if (isBadNumber(value)) {
						issues.push(
							issue("layout-invalid-number", {
								nodeId: node.id,
								message: `Frame "${node.id}" has a non-finite or out-of-range ${edge} padding (${value}).`,
							}),
						);
					} else if (value < 0) {
						issues.push(
							issue("layout-negative-padding", {
								nodeId: node.id,
								message: `Frame "${node.id}" has a negative ${edge} padding (${value}).`,
							}),
						);
					}
				}
			}

			const item = node.layoutItem;
			if (!item) return;

			const positioning = item.positioning ?? "flow";
			const parentHasLayout = isFrameWithLayout(parent);

			for (const field of SIZING_FIELDS) {
				const sizing: CanvasLayoutSizing | undefined = item[field];
				if (sizing === undefined) continue;
				const axis = AXIS_OF[field];

				if (sizing === "fill") {
					if (!parentHasLayout) {
						issues.push(
							issue("layout-fill-without-parent", {
								nodeId: node.id,
								axis,
								message: `Node "${node.id}" requests ${axis} Fill but its parent is not an Auto Layout frame.`,
							}),
						);
					} else if (positioning === "absolute") {
						// Absolute children are outside the flow entirely, so there is
						// no remaining space for them to take a share of.
						issues.push(
							issue("layout-fill-without-parent", {
								nodeId: node.id,
								axis,
								message: `Node "${node.id}" is absolutely positioned and cannot ${axis} Fill — Fill divides the flow's remaining space.`,
							}),
						);
					} else if (
						node.type === "text" &&
						axis === SIZING_FIELD_AXIS.widthSizing
					) {
						// A plain `text` node is single-line and cannot wrap, so its
						// inline extent is dictated by its content, not by its container.
						//
						// Reported as `layout-hug-unsupported`, NOT
						// `layout-fill-without-parent`: PRD §9.2 and TD §7.2 both name
						// this code, and the parent here IS a valid Auto Layout frame —
						// telling a host "no Auto Layout parent" would send it to fix
						// the one thing that is not wrong. The shared meaning is "this
						// axis cannot be sized that way by intrinsic means".
						issues.push(
							issue("layout-hug-unsupported", {
								nodeId: node.id,
								axis,
								message: `Text node "${node.id}" cannot Fill its inline (${axis}) axis — a "text" node does not wrap. Use "rich-text" for wrapping content.`,
							}),
						);
					}
				}

				if (sizing === "hug") {
					if (NON_INTRINSIC_KINDS.has(node.type)) {
						issues.push(
							issue("layout-hug-unsupported", {
								nodeId: node.id,
								axis,
								message: `Node "${node.id}" of kind "${node.type}" has no intrinsic ${axis} size to Hug.`,
							}),
						);
					} else if (node.type === "frame" && rendersPlaceholder(node)) {
						issues.push(
							issue("layout-hug-unsupported", {
								nodeId: node.id,
								axis,
								message: `Frame "${node.id}" is rendering its placeholder and has no measurable content to Hug on the ${axis} axis.`,
							}),
						);
					}
				}
			}

			// Hug/Fill cycle: the parent sizes itself from this child while the
			// child sizes itself from the parent. Unsolvable without iterating to
			// a fixpoint, which the O(nodes) solver contract forbids.
			if (parentHasLayout && positioning === "flow") {
				for (const field of SIZING_FIELDS) {
					if (item[field] !== "fill") continue;
					if (parent.layoutItem?.[field] !== "hug") continue;
					issues.push(
						issue("layout-circular-sizing", {
							nodeId: node.id,
							axis: AXIS_OF[field],
							message: `Node "${node.id}" Fills the ${AXIS_OF[field]} axis while its parent frame "${parent.id}" Hugs it — a circular sizing dependency.`,
						}),
					);
				}
			}
		});
	} catch (err) {
		if (err instanceof CanvasIRDepthError) {
			// The walkers throw past MAX_TREE_DEPTH; the resolver never will (it
			// stops descending and reports). Both codes on one document is
			// complementary, not duplicate: `excessive-tree-depth` is the
			// document-level fact, this is the resolution-level consequence.
			issues.push(
				issue("layout-depth-exceeded", {
					message: err.message,
				}),
			);
		} else {
			throw err;
		}
	}

	return orderLayoutIssues(issues, position);
}

const AXIS_RANK: Record<string, number> = {
	undefined: 0,
	horizontal: 1,
	vertical: 2,
};

/** Where a node sits in the normative ordering: page index, then pre-order rank. */
export interface CanvasLayoutDocumentOrder {
	readonly pageIndex: number;
	readonly order: number;
}

/**
 * Build the pre-order position index the TD §14 sort key needs.
 *
 * Exported so the resolver orders *its* diagnostics by exactly the same index
 * this validator uses. `validateLayoutInvariants` does not call it — it fills
 * the map during the walk it was already doing, which is free — but both
 * produce the identical mapping, and a test pins that.
 *
 * Depth failures are swallowed: an over-deep document still gets an ordering
 * for the part that could be walked, because refusing to order diagnostics is
 * strictly worse than ordering most of them.
 */
export function buildDocumentOrder(
	ir: CanvasIR,
): ReadonlyMap<string, CanvasLayoutDocumentOrder> {
	const position = new Map<string, CanvasLayoutDocumentOrder>();
	const pageIndexOf = new Map<string, number>();
	ir.pages.forEach((page, index) => pageIndexOf.set(page.id, index));
	let order = 0;
	try {
		walk(ir, ({ node, page }) => {
			position.set(node.id, {
				pageIndex: pageIndexOf.get(page.id) ?? 0,
				order: order++,
			});
		});
	} catch (err) {
		if (!(err instanceof CanvasIRDepthError)) throw err;
	}
	return position;
}

/**
 * The fully specified TD §14 ordering: page order, then pre-order tree order,
 * then axis (unscoped before horizontal before vertical), then code.
 *
 * Every component is a stable, document-derived value. The code comparison is
 * a plain code-unit comparison, never `localeCompare` — a locale-sensitive
 * collation would make diagnostic order depend on the host's locale, which is
 * exactly the kind of environment coupling AC-008's determinism forbids.
 * Document-scoped issues (no `nodeId`) sort before every node-scoped one.
 *
 * `Array.prototype.sort` is stable in every engine this package supports, so
 * two issues identical on all four key components keep their emission order
 * rather than being permuted — which is what makes the output byte-stable
 * rather than merely set-equal.
 */
export function orderLayoutIssues(
	issues: readonly CanvasLayoutIssue[],
	position: ReadonlyMap<string, CanvasLayoutDocumentOrder>,
): CanvasLayoutIssue[] {
	const at = (issue: CanvasLayoutIssue) =>
		(issue.nodeId ? position.get(issue.nodeId) : undefined) ?? {
			pageIndex: -1,
			order: -1,
		};

	return [...issues].sort((a, b) => {
		const pa = at(a);
		const pb = at(b);
		if (pa.pageIndex !== pb.pageIndex) return pa.pageIndex - pb.pageIndex;
		if (pa.order !== pb.order) return pa.order - pb.order;
		const axisDiff =
			(AXIS_RANK[String(a.axis)] ?? 0) - (AXIS_RANK[String(b.axis)] ?? 0);
		if (axisDiff !== 0) return axisDiff;
		if (a.code < b.code) return -1;
		if (a.code > b.code) return 1;
		return 0;
	});
}

/** Thrown by {@link assertLayoutInvariants}; carries every issue found, not just the first. */
export class CanvasLayoutInvariantError extends Error {
	readonly issues: readonly CanvasLayoutIssue[];

	constructor(issues: readonly CanvasLayoutIssue[]) {
		super(
			`CanvasIR failed ${issues.length} layout invariant check(s): ${issues
				.map((i) => i.message)
				.join(" | ")}`,
		);
		this.name = "CanvasLayoutInvariantError";
		this.issues = issues;
	}
}

/**
 * Throwing wrapper around {@link validateLayoutInvariants}.
 *
 * Throws only on `severity: "error"` issues. Warnings describe a degradation
 * the resolver applies deterministically (a Hug that falls back to the stored
 * Fixed size still renders), so treating them as a hard failure would reject
 * documents that render correctly.
 */
export function assertLayoutInvariants(ir: CanvasIR): void {
	const issues = validateLayoutInvariants(ir);
	const errors = issues.filter((issue) => issue.severity === "error");
	if (errors.length > 0) {
		throw new CanvasLayoutInvariantError(errors);
	}
}
