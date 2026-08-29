# Canvas release reference suite

**Version:** `1.0.0`  
**Owner:** Canvas technical lead and QA  
**Executable manifest:** `bench/reference-suite.ts`

This is the versioned environment and document matrix for PLAN-0039 E0-T2.
Benchmark reports print the suite version and fixture IDs; a performance result
without both is not release evidence.

## Environments

| ID | Purpose | Hardware | OS | Browsers | Execution |
| --- | --- | --- | --- | --- | --- |
| `canvas-headless-core-wsl2-v1` | Core resolver gate | Intel Core i5-10300H, 8 logical cores, 23.5 GB | Linux x64 / WSL2 | None | Automated |
| `canvas-desktop-primary-v1` | Primary desktop product workflow | 4 physical cores, 16 GB, integrated GPU, DPR 1/2 | Windows 11 24H2 | Playwright 1.61.0 Chromium, Firefox, WebKit | Automated |
| `canvas-desktop-low-tier-v1` | Resource-constrained desktop behavior | 2 physical cores, 8 GB, integrated GPU, DPR 1 | Windows 11 24H2 | Chromium and Firefox | Manual |
| `canvas-touch-primary-v1` | Touch/pointer behavior | 10.9-inch iPad 10th-generation class, 4 GB, DPR 2 | iPadOS 18 | Mobile Safari 18 | Manual |

The Playwright matrix is pinned by the workspace lockfile. Updating the
Playwright version, an OS baseline, hardware class, or viewport requires a
suite version bump and new baselines.

## Representative documents

The executable builders in `bench/fixtures/reference-documents.ts` cover mixed
100, 1,000, and 5,000-node documents plus 1,000-node text-, image-, and
component-heavy documents. The current resolver harness additionally names its
exact 1,000-node mixed, 100-text-key, and three-level Hug-chain fixtures.

Fixture IDs include `v1`, use fixed IDs and timestamps, and build identical IR
for identical inputs. A fixture content change requires a new fixture version;
never silently rewrite an existing performance independent variable.

## Evidence rule

Every performance report must include:

- `canvas-reference-suite@<version>`;
- every fixture ID measured;
- the matched environment ID or the explicit non-reference reason;
- sample and warm-up counts; and
- median and p95 values.

Low-tier desktop and touch runs remain manual until dedicated physical-device
automation exists. Their absence cannot be represented as an automated pass.
