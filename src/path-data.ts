/**
 * SVG path-`d` primitives — the one place this package parses, vets, or
 * rewrites path data.
 *
 * ## Why this is its own rank-0 module
 *
 * `PATH_D_RE` / {@link isValidPathD} were written for and lived in
 * `serialize/svg.ts` (rank 5), guarding `<path d>` output. Two later consumers
 * cannot reach rank 5:
 *
 * - `ir/frame-clip.ts` (rank **1**) — the ONE frame-clip resolver has to decide
 *   whether a `kind: "path"` clip can be honoured. `cp4-001` left that question
 *   in `serialize/` precisely because rank 1 cannot import rank 5's regex, and
 *   the cost of that split was defect **D-1**: the SVG emitter accepted a `d`
 *   the Konva renderer rejected, so an export silently blanked a frame the
 *   editor drew normally.
 * - `commands/` (rank **3**) — a frame resize has to rescale a path clip's `d`
 *   with the box, or the mask desyncs from the frame that owns it.
 *
 * The choice was duplicate the allowlist or move it to the floor. Duplicating a
 * security primitive is how two allowlists drift until only one of them knows
 * about a novel dangerous character, so it moved — the same forcing argument
 * that produced `uri.ts`, `limits.ts` and `hash.ts`. `serialize/svg.ts`
 * re-exports every name it used to own, so no importer changed.
 *
 * @see `docs/architecture/src-layer-map.md`
 */

/**
 * An ALLOWLIST of the characters a path `d` may contain — command letters,
 * digits, and number punctuation. Nothing else, so `"` / `>` / `url(` and every
 * other injection vector is rejected before the string can reach an SVG
 * attribute.
 */
const PATH_D_RE = /^[\sMmLlHhVvCcSsQqTtAaZz0-9.,+\-eE]*$/;

/**
 * Is `d` free of characters that could break out of an SVG attribute?
 *
 * A SANITIZER, not a geometry check: it answers "is this safe to write", never
 * "does this draw anything". {@link hasDrawablePathGeometry} answers the second
 * question, and the two are deliberately independent — `"Z"` is perfectly safe
 * and draws nothing, `'M0 0" onload="…'` describes a real line and is hostile.
 */
export function isValidPathD(d: string): boolean {
	return PATH_D_RE.test(d);
}

/** Arguments each path command takes, keyed by its lowercase letter. */
const COMMAND_ARITY: Readonly<Record<string, number>> = {
	m: 2,
	l: 2,
	t: 2,
	h: 1,
	v: 1,
	c: 6,
	s: 4,
	q: 4,
	a: 7,
	z: 0,
};

/**
 * Which axis each argument of a command scales on. `"x"` scales by `sx`, `"y"`
 * by `sy`, and `null` is left alone — an arc's x-axis-rotation and its two
 * boolean flags are not lengths.
 */
type Axis = "x" | "y" | null;

const COMMAND_AXES: Readonly<Record<string, readonly Axis[]>> = {
	m: ["x", "y"],
	l: ["x", "y"],
	t: ["x", "y"],
	h: ["x"],
	v: ["y"],
	c: ["x", "y", "x", "y", "x", "y"],
	s: ["x", "y", "x", "y"],
	q: ["x", "y", "x", "y"],
	// rx ry x-axis-rotation large-arc-flag sweep-flag x y
	a: ["x", "y", null, null, null, "x", "y"],
	z: [],
};

const NUMBER_RE = /[+-]?(?:\d*\.\d+|\d+\.?)(?:[eE][+-]?\d+)?/g;

interface PathSegment {
	/** The command letter, case preserved — case is absolute-vs-relative. */
	command: string;
	args: number[];
}

/**
 * Tokenize `d` into segments, or `undefined` when it is not confidently
 * parseable.
 *
 * Total over arbitrary strings and deliberately STRICT: an unknown letter, a
 * number before any command, an argument after `Z`, or a segment whose argument
 * count does not match its command's arity all yield `undefined`. Callers treat
 * that as "cannot honour this" (degrade) or "must not rewrite this" (pass the
 * original through) — never as "close enough", because both callers would
 * otherwise turn a malformed path into a WRONG one.
 *
 * Implicit repetition is expanded, including the one case where the repeat is a
 * different command than the one written: `M x y x y` means moveto-then-lineto
 * per the SVG grammar, and a scaler that treated the tail as a second `M` would
 * still be right (scaling is per-coordinate), but a reader of these segments
 * would not be.
 */
function parsePathSegments(d: string): PathSegment[] | undefined {
	const segments: PathSegment[] = [];
	let command: string | undefined;
	let i = 0;

	while (i < d.length) {
		const ch = d[i] as string;
		// Whitespace and the comma are both argument separators in the grammar.
		if (ch === "," || ch.trim() === "") {
			i += 1;
			continue;
		}

		if (/[a-zA-Z]/.test(ch)) {
			if (!(ch.toLowerCase() in COMMAND_ARITY)) return undefined;
			command = ch;
			segments.push({ command: ch, args: [] });
			i += 1;
			continue;
		}

		if (command === undefined) return undefined;
		NUMBER_RE.lastIndex = i;
		const match = NUMBER_RE.exec(d);
		if (!match || match.index !== i) return undefined;

		const arity = COMMAND_ARITY[command.toLowerCase()] as number;
		if (arity === 0) return undefined;
		let segment = segments[segments.length - 1] as PathSegment;
		if (segment.args.length === arity) {
			const repeat =
				command === "M" ? "L" : command === "m" ? "l" : (command as string);
			segment = { command: repeat, args: [] };
			segments.push(segment);
		}
		segment.args.push(Number(match[0]));
		i += match[0].length;
	}

	for (const segment of segments) {
		if (
			segment.args.length !==
			(COMMAND_ARITY[segment.command.toLowerCase()] as number)
		) {
			return undefined;
		}
	}
	return segments;
}

/**
 * Does `d` describe geometry, rather than an empty region?
 *
 * THE QUESTION `isValidPathD` DOES NOT ANSWER, and the one defect D-1 turned
 * on. `CanvasFrameShapeSchema` requires only a non-empty `d`, so `"Z"`, `"M"`
 * and an SVG import's junk all reach renderers as legal documents — and a
 * `<clipPath>` holding one of them is an EMPTY clip region, which erases
 * everything the frame contains instead of degrading. Every consumer must treat
 * a `false` here as "clip to the box instead".
 *
 * Strict by design: anything {@link parsePathSegments} cannot read confidently
 * is not drawable. Degrading a path that would in fact have drawn is a visible,
 * recoverable inconvenience; emitting an empty clip is silent content loss.
 */
export function hasDrawablePathGeometry(d: string): boolean {
	if (typeof d !== "string") return false;
	const segments = parsePathSegments(d);
	return segments !== undefined && segments.some((s) => s.args.length > 0);
}

/** Trim float noise without changing the number a reader sees. */
function fmtNumber(value: number): string {
	if (!Number.isFinite(value)) return "0";
	const rounded = Math.round(value * 1e6) / 1e6;
	return Object.is(rounded, -0) ? "0" : String(rounded);
}

/**
 * Scale every coordinate in `d` by `sx`/`sy` about the origin.
 *
 * A frame's clip path is authored in the frame's LOCAL units with the origin at
 * its top-left (both render paths draw it inside the frame's group), so a frame
 * resize has to carry the mask with it — the other four `CanvasFrameShape` kinds
 * are derived from `bounds` at render time and track it for free. Scaling about
 * the origin is a pure linear map, which is why RELATIVE commands need no
 * special handling: a delta scales exactly like an absolute coordinate.
 *
 * Returns `d` UNCHANGED when it cannot be parsed confidently or when either
 * factor is not a positive finite number. Refusing to rewrite is the only safe
 * failure: a half-scaled path is a mask nobody authored.
 *
 * KNOWN IMPRECISION, recorded rather than hidden: an elliptical arc (`A`/`a`)
 * carrying a non-zero x-axis-rotation is only approximated under a
 * NON-UNIFORM scale — exactly scaling a rotated ellipse re-parameterizes its
 * radii and rotation together, which cannot be expressed by scaling `rx` and
 * `ry` in place. Uniform scales and unrotated arcs are exact.
 */
export function scalePathData(d: string, sx: number, sy: number): string {
	if (!Number.isFinite(sx) || !Number.isFinite(sy) || sx <= 0 || sy <= 0) {
		return d;
	}
	if (sx === 1 && sy === 1) return d;
	const segments = parsePathSegments(d);
	if (segments === undefined) return d;

	return segments
		.map((segment) => {
			const axes = COMMAND_AXES[segment.command.toLowerCase()] as
				| readonly Axis[]
				| undefined;
			if (!axes) return segment.command;
			const args = segment.args.map((value, index) => {
				const axis = axes[index];
				if (axis === "x") return fmtNumber(value * sx);
				if (axis === "y") return fmtNumber(value * sy);
				return fmtNumber(value);
			});
			return args.length > 0
				? `${segment.command} ${args.join(" ")}`
				: segment.command;
		})
		.join(" ");
}
