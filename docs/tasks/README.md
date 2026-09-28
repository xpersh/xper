# xper implementation roadmap

This directory turns the RFCs into an ordered backlog. Tasks describe planned
work; their existence does not imply that implementation has started.

[RFC 0006](../rfcs/0006-configuration-recording-and-adapter-workflows.md)
defines current ownership: Pi implements the workflow, while Rust resolves
configuration and records reported facts. Earlier task evidence may describe
the original core-owned implementation; it does not override this boundary.
[RFC 0007](../rfcs/0007-explicit-adapter-state-machines.md) defines explicit Pi
state machines, future flow composition, and the read-only visualization boundary.

## First milestone goal

Validate a complete vertical slice:

```text
xper init
    -> pi
    -> Pi adapter <-> xper bridge
    -> /xper <objective>
    -> run started
    -> Discovery assignment
    -> subagent executed
    -> attempt settled
    -> transition to Define
    -> events in SQLite
    -> xper status
```

The workflow will not be expanded, nor a complete metrics TUI built, until
this slice is complete.

## Order and dependencies

| ID | Task | Depends on | Main result |
| --- | --- | --- | --- |
| XP-001 | [Pi integration spike](001-pi-integration-spike.md) | — | Feasibility and limits confirmed |
| XP-002 | [Scaffolding and quality gates](002-workspace-scaffolding.md) | XP-001 | Verifiable Rust/TypeScript workspace |
| XP-003 | [Minimal domain kernel](003-domain-kernel.md) | XP-002 | Pure state machine |
| XP-004 | [Protocol and bridge](004-bridge-protocol.md) | XP-002 | Rust/TypeScript handshake |
| XP-005 | [Minimal Pi adapter](005-pi-adapter.md) | XP-001, XP-004 | Pi session connected to the core |
| XP-006 | [Configuration, init, and doctor](006-init-doctor.md) | XP-002, XP-005 | Preflight and reproducible configuration |
| XP-007 | [SQLite event store](007-event-store.md) | XP-003 | Persisted runs and attempts |
| XP-008 | [First vertical slice](008-vertical-slice.md) | XP-003–XP-007 | End-to-end delegated Discovery |
| XP-009 | [Multimodel routing](009-multimodel-routing.md) | XP-006, XP-008 | Effective profiles and contexts |
| XP-010 | [Discovery to Plan](010-discovery-to-plan.md) | XP-008, XP-009 | First half of the XP workflow |
| XP-011 | [Sequential Implementation and Verify](011-implementation-verify.md) | XP-010 | Implementer, Verifier, sequential increments, then Knowledge feedback |
| XP-012 | [Judgment and closure](012-judgment-day.md) | XP-011.3; later feedback needs XP-011.4 | Judge report, explicit closure, then feedback and debt decisions |
| XP-013 | [Metrics and inspection](013-metrics-inspection.md) | Existing recording and XP-010; acceptance metrics need XP-012.2 | Single-run inspection, safe export, formulas, then comparison |
| XP-014 | [Packaging and compatibility](014-packaging-compatibility.md) | XP-006, XP-010 | One installable target, compatibility, separate ports, then maintenance |
| XP-015 | [Workflow visualization](015-workflow-visualization.md) | XP-010; observed history needs XP-013.2 | One graph, one observed path, then multiple instances |

XP-003 and XP-004 can proceed in parallel after XP-002. XP-006 and XP-007 can
also overlap once their contracts are stable.

XP-011 through XP-015 are task groups with independently reviewable slices.
Their entry dependencies do not authorize implementing every slice together.
Basic inspection, packaging, and definition visualization can start from the
accepted XP-010 baseline without waiting for the complete delivery workflow.

## Milestones

### M0 — Risks resolved

- XP-001

### M1 — Executable foundations

- XP-002 through XP-007

### M2 — Validated vertical slice

- XP-008

### M3 — Sequential workflow and routing

- XP-009 through XP-012
- Concurrency, workspace orchestration, and selective Plan reconciliation are
  future work, not conditions for accepting the first sequential delivery loop.

### M4 — Distributable product

- XP-013 and XP-014
- XP-015 can proceed independently of the remaining delivery phases once its
  definition and observation contract is available.

## Iteration rules for XP-011 onward

The accepted implementation baseline is Knowledge through Plan, with pure Pi
transitions and passive Rust configuration/recording. Unaccepted experimental
code and passing tests from a discarded iteration are not completed backlog work.
The RFCs describe product direction; they do not expand a selected slice's scope.

### Select one result

- Implement one numbered slice per iteration, such as XP-011.1. A request naming
  only the group starts its next unfinished slice unless it explicitly requests
  a broader scope. Update that slice's status and the group's next-slice pointer.
- Before coding, record in the selected slice one concrete before/after example,
  the existing modules to reuse, and the intended verification. Keep this brief;
  do not create a second implementation-plan document or a framework roadmap.
- Each slice must produce usable behavior, not empty modules, generic interfaces,
  or a migration layer for a future feature. Later slices keep their own criteria.
- Finish at `review` with the actual diff and evidence. Do not continue into the
  next slice just because its implementation now looks convenient.

### Keep the change reviewable

- Target one behavior with a small coherent diff. More than roughly 500 added
  production lines or 1,000 added handwritten lines in total (including tests
  and documentation) is a scope alarm: split the behavior into smaller accepted
  slices before continuing. These are review thresholds, not quality scores.
- Do not hide volume by compressing code, removing necessary tests/docs, moving
  logic to generated files, or dividing one large change into unreviewable commits.
- If meeting a criterion needs a new scheduler, workspace manager, persistence
  scheme, public execution tool, UI stack, or cross-platform abstraction, first
  demonstrate why an existing component cannot serve this slice. Separate that
  capability from the current iteration instead of quietly adding it.
- Subagents may investigate or verify the selected slice; do not assign them
  future slices and combine the outputs into one delivery. One owner reviews
  total scope and the final diff, not only whether individual modules pass tests.

### Preserve the agreed architecture

- The main Pi agent decides when to call `xper_delegate`; the coordinator selects
  an eligible assignment. Internal flow boundaries do not imply new public tools.
- Keep flow-specific pure decisions, but reuse existing execution, checkpoint,
  artifact, budget, and recording mechanisms. Extract only proven duplication;
  do not replace them with a generic workflow engine.
- Delivery uses one Implementer followed by one independent Verifier, with no
  Navigator or pair rotation. Concurrency, fan-out/fan-in, and richer reconciliation
  remain future work in the deferred sections.
- Rust remains configuration and telemetry. No recording response, inspection
  query, metric, or visualization may become an execution or recovery guard.

### Verify the result, not the amount of code

- Cover observable behavior and regressions using existing synthetic fixtures
  and test helpers. Add targeted recovery and unavailable-recorder coverage for
  new execution paths; do not duplicate the full existing matrix for every role.
- Follow repository checks: `npm run check` for code/build changes; local links,
  paths, commands, and `git diff --check` for documentation-only changes.
- Report the delivered example, code/test/doc diff size, new public surface or
  dependencies, verification evidence, and exclusions that remain deferred.
- A green suite alone is not acceptance. Review whether the behavior belongs
  in this slice, whether existing mechanisms were reused, and whether the result
  is understandable without reviewing several new subsystems at once.

## Rules for executing a task

A task is `ready` when:

- Its dependencies have been accepted.
- It contains no unresolved product decision.
- It has an observable completion criterion.
- It can be completed without introducing a second, parallel architecture.

A task is `done` when:

- It meets all its acceptance criteria.
- Its tests were written alongside the behavior.
- Changed contracts, schemas, and decisions are documented.
- It introduces no harness dependencies into `xper-domain` or `xper-application`.
- Errors have actionable diagnostics.
- It does not store credentials, prompts, or user code by default.

## States

Each task starts as `pending` and can move through:

```text
pending -> ready -> in_progress -> review -> done
                    \-> blocked
```

Update the task file's status when work begins. Do not mark it `done` merely
because scaffolding or a manual demo exists.

For XP-011 onward, track the selected slice independently. Mark its group `done`
only when all listed execution slices are accepted; items explicitly listed as
deferred remain future backlog and are not silently implemented to close a group.
