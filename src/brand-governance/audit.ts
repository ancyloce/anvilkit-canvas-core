import { fingerprint64 } from "../hash.js";
import type { CanvasComponentSourceRef } from "../ir/component-source.js";
import { snapshotKey } from "../ir/snapshot-key.js";

/**
 * @file The governance audit envelope (plan 0021 T-050, TD 0016 §24.2).
 *
 * ## Audit is not analytics
 *
 * Analytics answers "is the feature working"; audit answers "who was stopped
 * from doing what, and under which policy". They have different retention,
 * different consumers, and different redaction rules, so they are different
 * types in different packages rather than one event stream with a `kind` field.
 *
 * ## Identity is the host's, deliberately
 *
 * The envelope carries no actor. TD §24.2: "The host adds authenticated actor
 * identity in its audit system. Canvas does not persist it in IR." Canvas has
 * no authenticated notion of who the user is — it receives a capability
 * snapshot, already decided — so any identity it emitted would be self-reported
 * and worthless as an audit record. Better to carry none than to carry one that
 * looks authoritative and is not.
 *
 * ## Why the identifiers are hashed
 *
 * Document ids and component refs are customer data: a library name can reveal
 * an unannounced brand, a document id can be a campaign codename. The audit
 * consumer needs to correlate events, not to read names, and `documentIdHash` /
 * `componentRefHash` give correlation without disclosure.
 */

export type CanvasGovernanceAuditOutcome =
	| "allowed"
	| "warning"
	| "blocked"
	| "failed";

export interface CanvasGovernanceAuditEvent {
	/** Stable event name, e.g. `component-instance.detach`. Never localized. */
	readonly event: string;
	readonly documentIdHash: string;
	readonly componentRefHash?: string;
	readonly documentRevision: number;
	readonly policyRevision?: string;
	readonly outcome: CanvasGovernanceAuditOutcome;
	/** Stable diagnostic/deny codes. Never messages. */
	readonly issueCodes?: readonly string[];
	/** ISO 8601. Supplied by the caller — this module owns no clock. */
	readonly timestamp: string;
}

/**
 * The one hashing primitive for governance identifiers.
 *
 * Exported so the Editor's analytics module uses the SAME function rather than
 * a second one: two hashes of the same library id would break correlation
 * between an audit record and the analytics event describing the same action,
 * which is the main thing an operator wants to do with both streams.
 *
 * Not a cryptographic hash and not claimed to be. The requirement is that a
 * pipeline does not receive private library and component names in the clear
 * and that the same input yields the same token.
 */
export function hashIdentifier(value: string): string {
	return fingerprint64(value);
}

/** Correlatable, not reversible. See the file header. */
export function hashDocumentId(documentId: string): string {
	return hashIdentifier(documentId);
}

/**
 * Hash a component Source.
 *
 * Local and external Sources are namespaced before hashing, so a local `card`
 * and a library `card` cannot produce the same token — the same reason
 * `componentSourceKey` namespaces its cache keys.
 */
export function hashComponentRef(source: CanvasComponentSourceRef): string {
	if (source.kind === "local") {
		return hashIdentifier(`local:${source.componentId}`);
	}
	try {
		return hashIdentifier(`library:${snapshotKey(source)}`);
	} catch {
		// An unkeyable ref still needs a stable token — an audit record that
		// silently loses its subject is worse than one with a coarse one.
		return hashIdentifier(
			`library:${source.libraryId}/${source.componentId}/${source.version}`,
		);
	}
}

export interface BuildGovernanceAuditEventInput {
	readonly event: string;
	readonly documentId: string;
	readonly documentRevision: number;
	readonly outcome: CanvasGovernanceAuditOutcome;
	readonly timestamp: string;
	readonly source?: CanvasComponentSourceRef;
	readonly policyRevision?: string;
	readonly issueCodes?: readonly string[];
}

/**
 * Build an audit record with the identifiers already hashed.
 *
 * The only supported way to construct one: taking the raw ids and hashing here
 * means a caller cannot accidentally pass a plaintext document id into a field
 * named `...Hash`. Optional fields are omitted rather than set to `undefined`,
 * so a serialized record has no empty keys (INV-10's convention).
 */
export function buildGovernanceAuditEvent(
	input: BuildGovernanceAuditEventInput,
): CanvasGovernanceAuditEvent {
	return {
		event: input.event,
		documentIdHash: hashDocumentId(input.documentId),
		...(input.source
			? { componentRefHash: hashComponentRef(input.source) }
			: {}),
		documentRevision: input.documentRevision,
		...(input.policyRevision !== undefined
			? { policyRevision: input.policyRevision }
			: {}),
		outcome: input.outcome,
		...(input.issueCodes && input.issueCodes.length > 0
			? { issueCodes: input.issueCodes }
			: {}),
		timestamp: input.timestamp,
	};
}

/** The host sink for audit records. Optional; never load-bearing. */
export type CanvasGovernanceAuditSink = (
	event: CanvasGovernanceAuditEvent,
) => void;
