# XP-010: Workflow from Discovery to Plan

- Status: `done`
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


## Ownership revision

[RFC 0006](../rfcs/0006-configuration-recording-and-adapter-workflows.md)
moves this task's workflow rules into the Pi adapter. The phase contracts,
feedback, gates, approvals, and plan validation remain Pi behavior. Rust now
resolves configuration and records adapter-reported facts without deciding
transitions or validating knowledge artifacts. Current organization and
recovery limitations are documented in the
[Pi architecture](../../adapters/pi/docs/architecture.md).

The original validation below records the first delivery. Its references to
domain/application workflow tests describe that delivery's ownership, not the
current Rust structure. The refactored workflow is verified in the adapter;
the Rust tests cover generic recording and configuration.

## Original implementation and evidence

- [Knowledge workflow guide](../knowledge-workflow.md) specifies phase inputs,
  outputs, feedback, approval configuration, compatibility, and budget semantics.
- Domain rules cover knowledge transitions, deterministic DAG validation,
  workspace/resource conflicts, and budget admission. Durable transitions and
  replay share the same transition policy.
- Application tests use fake persistence, artifacts, clock, and IDs for all five
  phases. They cover ambiguous criteria returning to Define, infeasible designs
  returning to Design, non-independent stories, dependency cycles and missing
  edges, workspace conflicts, changed evidence, deadlines, budgets, and atomicity.
- JSON artifact schemas and shared fixtures define the handoff contract.
  SHA-256 seals and frozen input IDs prevent changed evidence from reusing gates
  or human approvals. Artifact contents stay outside the event log.
- Pi's public bridge integration uses fake execution to reach a ready Plan,
  reopens SQLite during human approval and after Plan, and preserves all five
  artifacts and outcomes. No model credentials are used.
- Cost limits use conservative per-attempt reservations, not provider billing
  telemetry. Plan validates proposed delivery budgets; XP-011 owns dispatching
  and enforcing those delivery assignments.

- `npm run check` passed: rustfmt, Biome, Clippy, core and adapter boundaries,
  strict TypeScript, all Rust tests, JSON Schema contract checks, and 65
  TypeScript tests. The SQLite test also rebuilds the final projection and
  confirms accepted artifacts, frozen inputs, charges, and human approval.
- `git diff --check` and local documentation-link checks passed.
- Live model execution was not used; the acceptance flow runs with deterministic
  fake execution through the real bridge and SQLite.
