# XP-007: Event store and minimal SQLite projections

- Status: `done`
- Milestone: M1
- Dependencies: XP-003

## Goal

Persist xper's neutral state and reconstruct runs without relying on the
transcript or native harness IDs.

## Scope

- Create versioned migrations for `events`, `runs`, `phase_visits`,
  `assignments`, and `attempts`.
- Implement idempotent append and transactions per boundary.
- Project the current state of a run.
- Record adapter, version, and capabilities as metadata.
- Recover attempts started without a final event as `interrupted`.
- Define degraded behavior when SQLite is unavailable.

## Acceptance criteria

- Replaying events reconstructs the same domain state.
- Reinserting an `event_id` does not duplicate effects.
- A simulated crash does not produce a falsely successful attempt.
- Prompts, code, and tool arguments are not stored by default.
- The schema contains no Pi-coupled tables.

## Out of scope

- All GUI projections.
- Retention, compaction, or OpenTelemetry.

## Implementation

- `xper-application::events` defines the port, closed event vocabulary, and a
  deterministic projection. Conversion from domain events omits objective text,
  evidence, and free-form reasons to avoid persisting prompts.
- `xper-store-sqlite` stores the log and rebuilds the five tables through a
  versioned migration. `append_boundary` inserts events and updates projections
  in one transaction; a repeated `event_id` with different content is a conflict.
- `open` rebuilds projections and adds `attempt.interrupted` events for
  unfinished attempts. A single writing coordinator per database is assumed.
  `open_or_volatile` uses in-memory SQLite and exposes the reason for degraded
  operation when the persistent database fails.
