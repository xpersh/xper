# XP-013: Metrics, comparison, and inspection

- Status: `pending`
- Milestone: M4
- Dependencies: XP-007 and XP-012

The [recording boundary](../rfcs/0006-configuration-recording-and-adapter-workflows.md)
provides generic status, timelines, event/attempt counts, and aggregates of
reported model usage. These foundations do not complete this task's comparison,
export, semantic formulas, or richer inspection work. Metrics are a core
responsibility; their inputs come from adapter-reported facts.
[XP-015](015-workflow-visualization.md) separately tracks rendering versioned
workflow topology and reported positions; it does not require these metrics
features to be complete.

## Goal

Turn persisted events into useful information for understanding and comparing
runs without exposing sensitive content.

## Scope

- Implement the headline metrics from RFC 0003.
- Add `xper status`, `xper metrics`, and structured export.
- Show timeline, attempts, failures, rework, costs, and the critical path.
- Distinguish wall-clock duration, active duration, and agent time.
- Compare only runs marked as equivalent.
- Create an initial Ratatui view if it materially improves inspection.

## Acceptance criteria

- Formulas are versioned and tested with fixtures.
- Parallel execution does not inflate wall-clock duration.
- Missing cost or token information is represented as unknown, not zero.
- Output excludes prompts, code, secrets, and tool content by default.
- Failure to project metrics does not alter the run's outcome.
- Semantic metrics use explicit adapter-reported acceptance, rework, and
  dependency facts; Rust does not infer a gate or phase policy.
- Pending or incomplete recording is visible; budget reservations are never
  presented as observed provider cost.

## Out of scope

- A web dashboard or remote telemetry service.
- Universal model rankings based on incomparable tasks.
