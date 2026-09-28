# xper implementation roadmap

This directory turns the RFCs into an ordered backlog. Tasks describe planned
work; their existence does not imply that implementation has started.

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
| XP-011 | [Implementation and Verify](011-implementation-verify.md) | XP-010 | Delivery and verification loop |
| XP-012 | [Judgment Day and closure](012-judgment-day.md) | XP-011 | Verdict, rework, and learning |
| XP-013 | [Metrics and inspection](013-metrics-inspection.md) | XP-007, XP-012 | Run comparison through CLI/TUI |
| XP-014 | [Packaging and compatibility](014-packaging-compatibility.md) | XP-006, XP-012, XP-013 | Cross-platform distribution |

XP-003 and XP-004 can proceed in parallel after XP-002. XP-006 and XP-007 can
also overlap once their contracts are stable.

## Milestones

### M0 — Risks resolved

- XP-001

### M1 — Executable foundations

- XP-002 through XP-007

### M2 — Validated vertical slice

- XP-008

### M3 — Complete workflow and routing

- XP-009 through XP-012

### M4 — Distributable product

- XP-013 and XP-014

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
