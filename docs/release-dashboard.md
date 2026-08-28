# Canvas release dashboard

`buildCanvasReleaseDashboard()` turns a privacy-safe telemetry window into the
release signals required by PLAN-0039 E0. The aggregation is deterministic;
the host supplies persistence, visualization, time-window selection, and alert
delivery.

## Metrics and ownership

The executable `CANVAS_RELEASE_ALERT_THRESHOLDS` table is the source of truth
for warning/critical values, minimum sample sizes, units, and responder owners.
It covers:

- load, save, and export success rates;
- unrecoverable error and fatal crash rates;
- p95 input-to-preview interaction latency;
- collaboration reconnect success and convergence failures;
- AI job success and user cancellation rates; and
- budget/resource rejection rate.

Metrics remain `insufficient-data` until their minimum sample size is met.
Collaboration convergence is deliberately zero-tolerance: the first failed
convergence check is critical.

## Operational contract

1. Emit only events accepted by the telemetry privacy gate.
2. Build dashboards over an explicitly selected release and time window.
3. Route alerts to the owner declared by the threshold table.
4. Treat threshold edits as release-policy changes requiring owner review.
5. Keep telemetry optional; dashboard or alerting failures must never affect
   document operations.

The dashboard contains only aggregate counters, ratios, and durations. It does
not add document content, identifiers, prompts, tokens, URLs, or binary data to
the telemetry contract.
