/**
 * @file The shared local/external definition lookup (plan 0021 T-016, TD 0016 §10/§17.1).
 *
 * ## One pipeline, not two
 *
 * Everything downstream of this module — override application, nested
 * expansion, virtual ids, provenance, serialization, export — is identical for
 * a document-local Source and an external library component. The *only*
 * difference is where the definition came from, and this is the one place that
 * asks. Two resolvers would drift; a `resolveExternalInstance` twin is exactly
 * the design this avoids.
 *
 * ## The resolver NEVER contacts a Provider
 *
 * A miss here is a resolution *state*, never a fetch. That is what makes a
 * document render identically online and offline (AC-003), and it is why this
 * module takes a snapshot index rather than anything resembling a client.
 * Recovering a missing snapshot is an explicit user action in the Editor
 * (T-023), not something a render can trigger.
 *
 * ## Placement
 *
 * The plan puts the resolution-state type in
 * `component-libraries/resolution-state.ts`. That domain is rank 4 and the
 * resolver is rank 2, which cannot import upward — so it lives here with its
 * consumer, and the public subpath re-exports it. Same call as T-015.
 */

import { snapshotKey } from "../ir/snapshot-key.js";
import type {
	CanvasComponentDefinition,
	CanvasComponentRegistry,
	CanvasComponentSourceRef,
	CanvasExternalComponentRef,
	CanvasExternalComponentSnapshot,
} from "../ir/types.js";
import type { CanvasExternalSnapshotIndex } from "./snapshot-index.js";

/**
 * What the document alone can say about an external Source (TD §17.1).
 *
 * Deliberately narrow: these are the states derivable from the document's own
 * snapshot registry. Provider-derived conditions — offline, unauthorized,
 * rate-limited, deprecated — are **not** here, because the resolver never
 * consults a Provider and therefore cannot observe them. They belong to the
 * Editor's request layer (M2/T-019), which reports them alongside, not through,
 * resolution.
 */
export type CanvasExternalComponentState =
	| {
			readonly kind: "resolved";
			readonly ref: CanvasExternalComponentRef;
			readonly snapshot: CanvasExternalComponentSnapshot;
	  }
	| {
			/** No snapshot for this exact ref. Recoverable by re-fetching (T-023). */
			readonly kind: "snapshot-missing";
			readonly ref: CanvasExternalComponentRef;
	  }
	| {
			/** The snapshot is present but its dependency closure is not (T-017). */
			readonly kind: "dependency-missing";
			readonly ref: CanvasExternalComponentRef;
			readonly missing: readonly CanvasExternalComponentRef[];
	  };

/** The outcome of asking "what definition does this Source name?". */
export type CanvasDefinitionLookup =
	| {
			readonly kind: "local";
			readonly componentId: string;
			readonly definition: CanvasComponentDefinition;
			/** Stable identity for cache keys and the cycle guard. */
			readonly sourceKey: string;
	  }
	| {
			readonly kind: "external";
			readonly ref: CanvasExternalComponentRef;
			readonly definition: CanvasComponentDefinition;
			readonly state: Extract<
				CanvasExternalComponentState,
				{ kind: "resolved" }
			>;
			readonly sourceKey: string;
	  }
	| {
			readonly kind: "unresolved";
			readonly source: CanvasComponentSourceRef;
			/**
			 * `local-missing` — not in `ir.components`.
			 * `snapshot-missing` — no admitted snapshot for this exact ref.
			 * `integrity-failed` — a snapshot IS stored under this exact ref, but
			 *   it was quarantined at load because its bytes no longer hash to its
			 *   `integrity` (T-045). Distinct from `snapshot-missing` because the
			 *   remedy differs: re-fetch or remove, never "carry on".
			 * `unkeyable` — the ref is malformed and no key can be derived.
			 */
			readonly reason:
				| "local-missing"
				| "snapshot-missing"
				| "integrity-failed"
				| "unkeyable";
			readonly externalState?: CanvasExternalComponentState;
	  };

/**
 * A stable identity for one Source, used as the cycle-guard stack entry and as
 * the component component of a cache key.
 *
 * Namespaced by kind so a local component and an external one that happen to
 * share an id can never be mistaken for each other — without the prefix, a
 * document with a local `button` and a library `button` would produce a false
 * cycle or a false cache hit.
 *
 * For an external Source the key embeds `integrity`, which is what makes cache
 * entries version-exact: a republished version with different bytes has a
 * different digest, hence a different key, hence no stale reuse. This is why an
 * external entry does NOT key on the definition's `revision` the way a local
 * one does — `revision` is an author-controlled counter inside the snapshot and
 * two distinct versions may well share one.
 */
export function componentSourceKey(source: CanvasComponentSourceRef): string {
	if (source.kind === "local") return `local:${source.componentId}`;
	return `library:${snapshotKey(source)}`;
}

/**
 * Resolve a Source to its definition, from the local Registry or the admitted
 * snapshot registry (TD §10).
 *
 * Total: every failure is a described `unresolved` result, never a throw. The
 * caller turns that into a selectable placeholder plus a diagnostic (INV-3).
 */
export function getDefinition(
	source: CanvasComponentSourceRef,
	local: CanvasComponentRegistry | undefined,
	external: CanvasExternalSnapshotIndex | undefined,
): CanvasDefinitionLookup {
	if (source.kind === "local") {
		const definition = local?.[source.componentId];
		if (!definition) {
			return { kind: "unresolved", source, reason: "local-missing" };
		}
		return {
			kind: "local",
			componentId: source.componentId,
			definition,
			sourceKey: componentSourceKey(source),
		};
	}

	// A malformed ref cannot be keyed, so it can never match a stored snapshot.
	// Reported distinctly from "we looked and it was not there" because the two
	// have different fixes: one is a broken document, the other a re-fetch.
	let sourceKey: string;
	try {
		sourceKey = componentSourceKey(source);
	} catch {
		return { kind: "unresolved", source, reason: "unkeyable" };
	}

	const snapshot = external?.get(source);
	if (!snapshot) {
		// Ask BEFORE reporting "missing": a quarantined snapshot is deliberately
		// invisible to `get`, so without this check a tampered document would be
		// indistinguishable from one that had simply never been fetched — and the
		// UI would offer "re-fetch" for both, quietly normalising the tampering.
		if (external?.isQuarantined(snapshotKey(source))) {
			return {
				kind: "unresolved",
				source,
				reason: "integrity-failed",
				externalState: { kind: "snapshot-missing", ref: source },
			};
		}
		return {
			kind: "unresolved",
			source,
			reason: "snapshot-missing",
			externalState: { kind: "snapshot-missing", ref: source },
		};
	}

	return {
		kind: "external",
		ref: source,
		definition: snapshot.definition,
		state: { kind: "resolved", ref: source, snapshot },
		sourceKey,
	};
}
