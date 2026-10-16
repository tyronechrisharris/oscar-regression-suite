# Report interpretation

A run directory is one evidence bundle: functional-results.csv contains behavioral
oracle rows; performance.csv contains timestamped resources; summary.csv contains
all/category/scenario/action and performance aggregates; errors.csv contains
runtime diagnostics; summary.md is the operator narrative; run.json is
traceability metadata; evidence contains screenshots/recovery state; downloads
contains validated PDFs and alarm exports.

## Classification

- PASS: evaluated checks are correct and no error-severity runtime issue exists
- FAIL-product: evidence shows OSCAR violated the oracle
- FAIL-environment: a target, identity, stream, dependency, or metric source failed
- FAIL-harness: selector, fixture, correlation, or reporter logic was wrong

Warnings alone do not fail. Error-severity records, empty runs, incorrect checks,
missing requested container samples, OOM kills, and restart increases fail.

## Correctness

Use summary.csv group all for overall accuracy, category:... for subsystems,
scenario:... for workflows, and action:<scenario>/<action> for exact outcomes
such as tamper resolution. Skipped rows are excluded from accuracy and must not be
reported as passing.

When `OPERATIONAL_VIEW_WORKFLOW=required`, any skipped operational-view action,
fixture parse/count/membership mismatch, scoped navigation leak, or nonempty
fail-closed result prevents PASS. Confirm the evidence includes all seven exact
fixture-derived view memberships plus malformed-key, unassigned-valid-key, and
duplicate-parameter rejection.
`run.json` must identify the workflow mode, resolved fixture path, fixture
SHA-256, and expected per-key lane counts.

## Performance

Docker CPU may exceed 100% because 100% represents one logical CPU. Compare the
same allocation and use phase to associate spikes with workflows. CPU/memory
peaks are observational until a project baseline/budget exists. Missing requested
samples, OOMs, and restart increases are gating.

## Evidence standard

A defect report includes the failing functional row, relevant errors, evidence
path, build labels, and cleanup result. Review bundles for event, lane, vehicle,
and credential-sensitive data before sharing.
