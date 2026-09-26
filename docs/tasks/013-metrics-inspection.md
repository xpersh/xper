# XP-013: Metrics, comparison, and inspection

- Status: `pending`
- Milestone: M4
- Dependencies: XP-007 and XP-012

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

## Out of scope

- A web dashboard or remote telemetry service.
- Universal model rankings based on incomparable tasks.
