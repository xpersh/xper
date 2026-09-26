# XP-003: Minimal domain kernel

- Status: `done`
- Milestone: M1
- Dependencies: XP-002

## Goal

Implement the pure core needed to represent a run and demonstrate deterministic
transitions without depending on any harness.

## Scope

- Types for Run, Phase Visit, Assignment, Attempt, Gate, and Artifact Reference.
- Explicit states and outcomes, including cancellation and timeout.
- Minimal `Intake -> Discovery -> Define` transitions.
- Rejection of invalid transitions with stable errors.
- Domain events produced by each accepted change.
- Injectable clock and identifiers for deterministic tests.

## Acceptance criteria

- Tests cover valid and invalid paths, revisits, and idempotency.
- The same input produces the same state and events.
- No type contains Pi-specific IDs, events, or models.
- There is no filesystem, network, process, or database access.

## Out of scope

- The complete workflow.
- Persistence and protocol serialization.
- Real agent execution.

## Result

- A neutral domain model for runs, phase visits, assignments, attempts, gates,
  and versioned artifact references.
- Explicit terminal outcomes for success, failure, cancellation, and timeout.
- Deterministic `Intake -> Discovery -> Define` transitions and a
  `Define -> Discovery` revisit, with required gates and stable error codes.
- Identified events for every accepted change and request-level idempotency:
  replay returns the same receipt without consuming additional clock values or IDs.
- Injectable clock and identifiers, with no external dependencies or filesystem,
  network, process, or database access.
- Acceptance tests for valid paths, rejection without side effects, revisits,
  idempotency conflicts, and exact state/event reproduction.
