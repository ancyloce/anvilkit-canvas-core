# Export limit reference validation

Status: accepted starting policy for PLAN-0039 E2-T2 (2026-08-27).

The secure defaults are 8,192 px per output edge, 64 megapixels per raster
page, 256 megapixels per job, 100 pages, and 4× requested scale. They are hard
ceilings, not an interactive-performance target. The estimator routes jobs
above 16 megapixels away from the interactive tier before a renderer is
selected.

## Reference-suite analysis

The environment IDs and ownership remain in `bench/REFERENCE-SUITE.md`.

| Reference surface | Check | Result |
| --- | --- | --- |
| Primary desktop, 16 GB, DPR 2 | 1,920×1,080 at 2× is 8.29 MP / 33.18 MB raw RGBA | Below every ceiling and the 16 MP interactive tier |
| Low-tier desktop, 8 GB, DPR 1 | 1,920×1,080 at 1× is 2.07 MP / 8.29 MB raw RGBA | Below every ceiling |
| Touch reference, 4 GB, DPR 2 | 1,080×1,080 at 2× is 4.67 MP / 18.66 MB raw RGBA | Below every ceiling |
| Print workload | 2,480×3,508 (A4 at 300 DPI) is 8.70 MP / 34.80 MB raw RGBA | Below the interactive tier and hard ceilings |
| Maximum single page | 64 MP is 256 MB raw RGBA | Hard stop; background/server recommendation, never an interactive target |
| Maximum job | 256 MP is 1.024 GB raw RGBA before incremental release | Hard stop; E2-T3 must keep peak page memory below the total |

The low-tier and touch entries are arithmetic capacity checks, not measured
browser allocation passes; `bench/REFERENCE-SUITE.md` explicitly records those
environments as manual. They therefore justify the starting ceilings without
claiming an automated device pass. Any real-browser failure below a ceiling
lowers the default; it must never be handled by weakening the gate or raising a
device-specific exception silently.

## Boundary evidence

`src/export/__tests__/cost.test.ts` accepts each configured boundary and
rejects boundary-plus-one for all five factors. Editor integration tests prove
the dialog and headless action reject before their rasterizer is invoked.
