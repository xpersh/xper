# XP-011: Implementation–Verify loop

- Status: `pending`
- Milestone: M3
- Dependencies: XP-010

## Goal

Implement small increments through Driver/Navigator and obtain independent
evidence before presenting them to Judgment Day.

Follow [RFC 0007](../rfcs/0007-explicit-adapter-state-machines.md): consume the
sealed Plan as a handoff from the completed knowledge instance. Compose delivery
and verification flows per increment under the run; do not extend the knowledge
phase enum or reducer into a single machine for the whole product.

## Scope

- Instantiate Driver and Navigator with separate responsibilities.
- Manage increments, attempts, and configurable role rotation.
- Create isolated workspaces for concurrent work.
- Record tests, commits, local decisions, and integration evidence.
- Run Verify with an agent other than the implementer.
- Return to Implementation, Design, or Define according to the failure's cause.
- Bound rework and escalation to humans.
- Give each flow a versioned definition and instance identity, linked to the
  increment and exact Plan revision; keep cross-flow scheduling in the coordinator.

## Acceptance criteria

- An increment advances only with local tests and evidence for its criteria.
- Verifier does not modify the code it evaluates.
- Two agents do not write to the same workspace simultaneously.
- Cancellation or budget exhaustion leaves recoverable state.
- The reason for every rework loop is structured and measurable.
- Independent increment instances can coexist without sharing mutable flow state.
- Plan changes and feedback across flows reconcile affected work explicitly;
  completion of one instance never implies completion of the whole run.
- Missing, slow, or rejecting Rust never blocks local execution or recovery.

## Out of scope

- Publishing changes or accepting debt automatically.
- Advanced scheduling optimization.
