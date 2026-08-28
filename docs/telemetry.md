# Canvas telemetry contract

`@anvilkit/canvas-core` exports the PLAN-0039 E0-T3 telemetry vocabulary from
its root entry. It covers load, save, recovery, export, collaboration, AI jobs,
performance phases, and classified errors.

Telemetry is operational metadata only. The contract excludes raw document
text, image/media bytes, prompts, provider tokens, asset URLs, email addresses,
user identity, and free-form error messages. `emitCanvasTelemetry()` checks the
event recursively before delivery and drops unsafe data. It also isolates the
user operation from a throwing host sink.

Use stable `errorCode` and `CanvasTelemetryErrorClass` values instead of an
exception message or stack. Use node-count buckets instead of serializing a
document or node data. Provider identity is reduced to `host`, `mock`, or
`remote`; provider-specific names belong in the host's access-controlled
operational system, not this client event.

The schema is versioned by `CANVAS_TELEMETRY_SCHEMA_VERSION`. A breaking wire
change requires a schema-version increment and a dashboard migration.
