/**
 * Snap, smart-guide, and align/distribute geometry for `@anvilkit/canvas-core`.
 *
 * Framework-free (no React/Konva): operates purely on world-space rects so the
 * editor, headless consumers, and tests share one implementation. Lifted from
 * the editor's `snap/` modules; the edge-pair matching is unchanged, only
 * re-expressed without tuple indexing to satisfy `noUncheckedIndexedAccess`.
 */

export interface SnapRect {
	x: number;
	y: number;
	width: number;
	height: number;
}

export type SnapAxis = "x" | "y";

export interface SmartGuide {
	axis: SnapAxis;
	/** Coordinate of the alignment line in world space. */
	position: number;
	/** Endpoints of the visible guide line (covers candidate + target rects). */
	from: { x: number; y: number };
	to: { x: number; y: number };
}

export interface SnapInput {
	/** Rect of the thing being snapped (e.g. a dragging node) in world coords. */
	candidate: SnapRect;
	/** Other (unselected) node bounding rects to snap against. */
	others: readonly SnapRect[];
	/** When > 0 and no edge snap matches, snap the top-left to this grid size. */
	gridSize?: number;
	/** Maximum world-space distance for an edge snap. Default 6. */
	threshold?: number;
}

export interface SnapResult {
	dx: number;
	dy: number;
	guides: SmartGuide[];
}

export const DEFAULT_SNAP_THRESHOLD = 6;

type Edge = "start" | "center" | "end";

function edgeValue(rect: SnapRect, axis: SnapAxis, edge: Edge): number {
	const base = axis === "x" ? rect.x : rect.y;
	const size = axis === "x" ? rect.width : rect.height;
	if (edge === "start") return base;
	if (edge === "center") return base + size / 2;
	return base + size;
}

/**
 * Figma-style edge pairs: like-edges align (start↔start, end↔end), cross-edges
 * align (start↔end, end↔start) for adjacency, and centers align with each other
 * only — never start↔center or end↔center.
 */
const SNAP_PAIRS: ReadonlyArray<readonly [Edge, Edge]> = [
	["start", "start"],
	["start", "end"],
	["end", "start"],
	["end", "end"],
	["center", "center"],
];

interface EdgeMatch {
	delta: number;
	position: number;
	target: SnapRect;
}

function edgeSnap(
	candidate: SnapRect,
	others: readonly SnapRect[],
	threshold: number,
	axis: SnapAxis,
): EdgeMatch | null {
	let best: EdgeMatch | null = null;
	for (const other of others) {
		for (const [ci, oi] of SNAP_PAIRS) {
			const cEdge = edgeValue(candidate, axis, ci);
			const oEdge = edgeValue(other, axis, oi);
			const d = cEdge - oEdge;
			if (Math.abs(d) <= threshold) {
				if (!best || Math.abs(d) < Math.abs(best.delta)) {
					best = { delta: -d, position: oEdge, target: other };
				}
			}
		}
	}
	return best;
}

function gridSnap(value: number, gridSize: number): number {
	return Math.round(value / gridSize) * gridSize - value;
}

/**
 * Compute snap deltas + smart-guide overlays for a candidate rect.
 *
 * Edge-snap-to-other-nodes beats grid snap when both match within threshold;
 * grid only applies when no edge snap is available on that axis. Guides are
 * only emitted for edge snaps, never for grid snaps.
 */
export function computeSnap(input: SnapInput): SnapResult {
	const threshold = input.threshold ?? DEFAULT_SNAP_THRESHOLD;
	const guides: SmartGuide[] = [];

	const edgeX = edgeSnap(input.candidate, input.others, threshold, "x");
	const edgeY = edgeSnap(input.candidate, input.others, threshold, "y");

	let dx = 0;
	let dy = 0;

	if (edgeX) {
		dx = edgeX.delta;
		const yMin = Math.min(input.candidate.y, edgeX.target.y);
		const yMax = Math.max(
			input.candidate.y + input.candidate.height,
			edgeX.target.y + edgeX.target.height,
		);
		guides.push({
			axis: "x",
			position: edgeX.position,
			from: { x: edgeX.position, y: yMin },
			to: { x: edgeX.position, y: yMax },
		});
	} else if (input.gridSize && input.gridSize > 0) {
		dx = gridSnap(input.candidate.x, input.gridSize);
	}

	if (edgeY) {
		dy = edgeY.delta;
		const xMin = Math.min(input.candidate.x, edgeY.target.x);
		const xMax = Math.max(
			input.candidate.x + input.candidate.width,
			edgeY.target.x + edgeY.target.width,
		);
		guides.push({
			axis: "y",
			position: edgeY.position,
			from: { x: xMin, y: edgeY.position },
			to: { x: xMax, y: edgeY.position },
		});
	} else if (input.gridSize && input.gridSize > 0) {
		dy = gridSnap(input.candidate.y, input.gridSize);
	}

	// Normalize -0 → +0 so callers using Object.is for equality don't trip.
	return { dx: dx || 0, dy: dy || 0, guides };
}

export type AlignEdge =
	| "left"
	| "hcenter"
	| "right"
	| "top"
	| "vcenter"
	| "bottom";

/**
 * Per-rect displacement (along the edge's axis) to align every rect to the
 * selection's bounding box: left/right/hcenter move on X, top/bottom/vcenter on
 * Y. Returned array is index-aligned with `rects`; empty input → empty output.
 */
export function alignRects(
	rects: readonly SnapRect[],
	edge: AlignEdge,
): number[] {
	if (rects.length === 0) return [];
	let minLeft = Number.POSITIVE_INFINITY;
	let maxRight = Number.NEGATIVE_INFINITY;
	let minTop = Number.POSITIVE_INFINITY;
	let maxBottom = Number.NEGATIVE_INFINITY;
	for (const r of rects) {
		minLeft = Math.min(minLeft, r.x);
		maxRight = Math.max(maxRight, r.x + r.width);
		minTop = Math.min(minTop, r.y);
		maxBottom = Math.max(maxBottom, r.y + r.height);
	}
	const cx = (minLeft + maxRight) / 2;
	const cy = (minTop + maxBottom) / 2;
	return rects.map((r) => {
		switch (edge) {
			case "left":
				return minLeft - r.x;
			case "right":
				return maxRight - (r.x + r.width);
			case "hcenter":
				return cx - (r.x + r.width / 2);
			case "top":
				return minTop - r.y;
			case "bottom":
				return maxBottom - (r.y + r.height);
			case "vcenter":
				return cy - (r.y + r.height / 2);
		}
	});
}

/**
 * Per-rect displacement (along `axis`) to even out the gaps between rects,
 * keeping the first and last (by position) fixed — like Figma's "distribute
 * spacing". Returned array is index-aligned with `rects`; needs ≥3 rects,
 * otherwise all zeros.
 */
export function distributeRects(
	rects: readonly SnapRect[],
	axis: SnapAxis,
): number[] {
	const n = rects.length;
	const deltas = new Array<number>(n).fill(0);
	if (n < 3) return deltas;

	const pos = (r: SnapRect) => (axis === "x" ? r.x : r.y);
	const size = (r: SnapRect) => (axis === "x" ? r.width : r.height);

	let totalSize = 0;
	let minStart = Number.POSITIVE_INFINITY;
	let maxEnd = Number.NEGATIVE_INFINITY;
	for (const r of rects) {
		totalSize += size(r);
		minStart = Math.min(minStart, pos(r));
		maxEnd = Math.max(maxEnd, pos(r) + size(r));
	}
	const gap = (maxEnd - minStart - totalSize) / (n - 1);

	const entries = rects.map((rect, index) => ({ rect, index }));
	entries.sort((a, b) => pos(a.rect) - pos(b.rect));

	let cursor = minStart;
	for (const { rect, index } of entries) {
		deltas[index] = cursor - pos(rect);
		cursor += size(rect) + gap;
	}
	return deltas;
}

/** Per-rect displacement produced by {@link tidyUpRects}. */
export interface TidyUpDelta {
	dx: number;
	dy: number;
}

function median(values: readonly number[]): number {
	if (values.length === 0) return 0;
	const sorted = [...values].sort((a, b) => a - b);
	const mid = Math.floor(sorted.length / 2);
	const lower = sorted[mid - 1] ?? sorted[mid] ?? 0;
	const upper = sorted[mid] ?? 0;
	return sorted.length % 2 === 0 ? (lower + upper) / 2 : upper;
}

/**
 * FR-072 "Tidy Up" (C-12): arrange a rough scatter into a clean grid.
 * Rects cluster into rows by vertical-center proximity (threshold: half the
 * median height), each row lays out left-to-right from the selection's left
 * edge, and rows stack from its top edge — with uniform gaps derived from
 * the MEDIAN existing horizontal/vertical gaps (clamped ≥ 0), so a tidy of
 * an already-tidy grid is a no-op rather than a re-spacing. Returned array
 * is index-aligned with `rects`; fewer than 2 rects → all zeros. Pure.
 */
export function tidyUpRects(rects: readonly SnapRect[]): TidyUpDelta[] {
	const n = rects.length;
	const deltas: TidyUpDelta[] = Array.from({ length: n }, () => ({
		dx: 0,
		dy: 0,
	}));
	if (n < 2) return deltas;

	const entries = rects.map((rect, index) => ({ rect, index }));
	entries.sort(
		(a, b) => a.rect.y + a.rect.height / 2 - (b.rect.y + b.rect.height / 2),
	);
	const rowThreshold = median(rects.map((r) => r.height)) / 2;

	const rows: Array<Array<{ rect: SnapRect; index: number }>> = [];
	let currentRow: Array<{ rect: SnapRect; index: number }> = [];
	let rowCenterSum = 0;
	for (const entry of entries) {
		const cy = entry.rect.y + entry.rect.height / 2;
		if (
			currentRow.length > 0 &&
			Math.abs(cy - rowCenterSum / currentRow.length) > rowThreshold
		) {
			rows.push(currentRow);
			currentRow = [];
			rowCenterSum = 0;
		}
		currentRow.push(entry);
		rowCenterSum += cy;
	}
	if (currentRow.length > 0) rows.push(currentRow);
	for (const row of rows) row.sort((a, b) => a.rect.x - b.rect.x);

	// Uniform gaps from the MEDIAN existing spacing (overlaps clamp to 0).
	const hGaps: number[] = [];
	for (const row of rows) {
		for (let i = 1; i < row.length; i += 1) {
			const prev = row[i - 1];
			const next = row[i];
			if (prev && next)
				hGaps.push(next.rect.x - (prev.rect.x + prev.rect.width));
		}
	}
	const vGaps: number[] = [];
	for (let i = 1; i < rows.length; i += 1) {
		const prevBottom = Math.max(
			...(rows[i - 1] ?? []).map((e) => e.rect.y + e.rect.height),
		);
		const nextTop = Math.min(...(rows[i] ?? []).map((e) => e.rect.y));
		vGaps.push(nextTop - prevBottom);
	}
	const gapX = Math.max(0, median(hGaps));
	const gapY = Math.max(0, median(vGaps));

	let minLeft = Number.POSITIVE_INFINITY;
	let minTop = Number.POSITIVE_INFINITY;
	for (const r of rects) {
		minLeft = Math.min(minLeft, r.x);
		minTop = Math.min(minTop, r.y);
	}

	let y = minTop;
	for (const row of rows) {
		let x = minLeft;
		let rowHeight = 0;
		for (const { rect, index } of row) {
			deltas[index] = { dx: x - rect.x, dy: y - rect.y };
			x += rect.width + gapX;
			rowHeight = Math.max(rowHeight, rect.height);
		}
		y += rowHeight + gapY;
	}
	return deltas;
}
