# Canvas release controls and rollback ownership

PLAN-0039 E0-T6 defines a host-operated control plane for risky Canvas
surfaces. The executable source of truth is `src/release-controls.ts`; this
document describes how hosts operate it.

## Runtime contract

A host supplies `CanvasReleaseControlSource.getSnapshot()`. Every capability or
migration evaluation reads the source again, so a remote flag change takes
effect without rebuilding or publishing `@anvilkit/canvas-core`.

Capability decisions combine the capability's own feature flag with every
declared dependency. Disabling `canvas.feature.editing`, for example, also
disables exports and persistence. Every P0 row has its own direct switch as
well, so an incident does not need to disable a broader dependency.

Migration switches are operational flags rather than user-visible capability
flags. A load path must call `isMigrationEnabled()` before applying the named
step and fail closed while leaving the source bytes unchanged when disabled.

## Ownership matrix

| Surface | Owner | Direct authority | Disabled behavior |
| --- | --- | --- | --- |
| Collaboration and comments | Collaboration | Collaboration on-call, incident commander | New sessions remain local-only; editing and persistence continue. |
| AI image provider | AI | AI on-call, incident commander | New image jobs are rejected; existing assets remain usable. |
| AI design provider | AI | AI on-call, incident commander | New design jobs are rejected; templates and manual editing remain usable. |
| High-resolution export | Canvas Editor | Canvas Editor on-call, incident commander | High-resolution choices are removed; standard export continues. |
| New IR migrations | Canvas Core | Canvas Core on-call, incident commander | The affected migration fails closed before document rewrite. |

`CANVAS_ROLLBACK_CONTROLS` carries the exact flag IDs, capability IDs,
authorities, disabled behavior, and verification statement for automation and
runbook generation. Any new migration step must add a migration control and a
tested operational flag in the same package change.

## Incident procedure

1. Record the current snapshot revision and the incident identifier.
2. An authorized role writes `false` to the row's direct kill switch.
3. Verify the row's declared fallback behavior and that no new provider job,
   collaboration connection, high-resolution render, or migration starts.
4. Monitor the release dashboard until the affected metric stabilizes.
5. Re-enable only after the owning team has validated the fix against the
   reference fixtures and required CI gates.
