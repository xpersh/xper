# XP-011: Implementation–Verify loop

- Status: `pending`
- Milestone: M3
- Dependencies: XP-010

## Goal

Implement small increments through Driver/Navigator and obtain independent
evidence before presenting them to Judgment Day.

## Scope

- Instantiate Driver and Navigator with separate responsibilities.
- Manage increments, attempts, and configurable role rotation.
- Create isolated workspaces for concurrent work.
- Record tests, commits, local decisions, and integration evidence.
- Run Verify with an agent other than the implementer.
- Return to Implementation, Design, or Define according to the failure's cause.
- Bound rework and escalation to humans.

## Acceptance criteria

- An increment advances only with local tests and evidence for its criteria.
- Verifier does not modify the code it evaluates.
- Two agents do not write to the same workspace simultaneously.
- Cancellation or budget exhaustion leaves recoverable state.
- The reason for every rework loop is structured and measurable.

## Out of scope

- Publishing changes or accepting debt automatically.
- Advanced scheduling optimization.
