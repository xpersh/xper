# XP-010: Workflow from Discovery to Plan

- Status: `pending`
- Milestone: M3
- Dependencies: XP-008 and XP-009

## Goal

Extend the vertical slice with the knowledge phases preceding implementation
without turning them into a rigid pipeline.

## Scope

- Discovery, Define, Design, Breakdown, and Plan.
- Input/output contracts and minimum artifacts per phase.
- Revisits to the phase where uncertainty originated.
- Automatic gates and configurable requests for human input.
- Construction of an assignment and increment DAG.
- Attempt, time, cost, and concurrency budgets.

## Acceptance criteria

- Each phase can be tested with fake adapters.
- Ambiguous criteria return to Define, and an infeasible design returns to Design.
- Breakdown rejects stories that cannot be verified independently.
- Plan detects dependencies and workspace conflicts.
- Artifacts, rather than the transcript, form the contract between phases.

## Out of scope

- Writing code, integrating worktrees, or issuing the final verdict.
