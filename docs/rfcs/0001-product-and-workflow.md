# RFC 0001: xper product and workflow

- Status: draft
- Date: 2026-09-22
- Scope: functional and conceptual definition

Workflow ownership is revised by [RFC 0006](0006-configuration-recording-and-adapter-workflows.md).
The phase and role descriptions below describe the Pi workflow; they are not
rules enforced by the Rust service.
[RFC 0007](0007-explicit-adapter-state-machines.md) refines the state-machine
model: knowledge completion hands off a sealed Plan to future per-increment
flows; phase, instance lifecycle, and attempt state remain separate.

## Summary

`xper` is a workflow coordination layer for Pi inspired by Extreme
Programming. Its responsibility is to turn development intent into small,
verifiable, integrable increments through a workflow with explicit contracts,
gates, and feedback.

The user starts a workflow through `/xper` in a Pi session. Its extension
owns commands, agent execution, workflow state, and gates. The independent
Rust service resolves configuration and records reported facts. The executable
knowledge workflow covers Discovery through Plan;
[its contracts and limits](../knowledge-workflow.md) describe the current slice.
The remaining phases below describe the product direction.

## Goals

- Apply XP practices to a multi-agent development process.
- Reduce change size and shorten feedback cycles.
- Make conditions for advancing or returning between phases explicit.
- Avoid using the full conversation context as the process's only state.
- Allow supervised or autonomous execution without losing traceability.
- Produce enough evidence to verify and compare results.

## Initial non-goals

- Replace Pi's runtime, providers, or tools.
- Design a general-purpose project manager.
- Maintain permanent agents for each phase.
- Execute concurrent work in a shared workspace without isolation.
- Evaluate people's productivity.

## XP principles as invariants

- **Test-first:** each increment starts with observable examples or tests.
- **Independent verification:** an Implementer produces the change; a separate
  Verifier checks behavior, regressions, scope, and simplicity.
- **Simple design:** complexity for hypothetical requirements is not accepted.
- **Continuous integration:** changes are integrated frequently.
- **Continuous refactoring:** part of Implementation, not a later phase.
- **Small releases:** seek the smallest acceptable increment.
- **Collective ownership:** no agent permanently owns a part of the code.
- **Short feedback:** a failed gate returns to the cause, not a fixed phase.
- **Sustainable pace:** cost, context, concurrency, attempt, and time limits exist.
- **Human on the loop:** ambiguous, irreversible, or product decisions may
  require human intervention.

## Flow

```text
Intake
   |
   v
Discovery <-> Define <-> Design
                         |
                         v
               Breakdown <-> Plan
                         |
                         v
            +-- Implementation <-> Verify --+
            |         per increment          |
            +---------------------------------+
                         |
                         v
                   Judgment Day
                    /         \
                Rework       Accept
                                |
                                v
                           Learn / Close
```

Phases are specialized views and knowledge gates. They do not represent
departments or a linear process. The coordinator can return to any phase when
new evidence appears.

Examples:

- An ambiguous acceptance criterion returns to `Define`.
- An unforeseen technical limitation returns to `Design`.
- An oversized story returns to `Breakdown`.
- A localized defect returns to `Implementation`.
- A correct but unnecessarily complex solution can return to `Design`.

## Phase contracts

| Phase | Main question | Output | Exit gate |
| --- | --- | --- | --- |
| Intake | What is requested, and what authority do we have? | Normalized request, repository, constraints, and autonomy | The initial scope is identifiable |
| Discovery | What problem are we solving? | Evidence, context, risks, hypotheses, and unknowns | Critical unknowns are resolved or declared |
| Define | What does done mean? | Goal, scope, exclusions, criteria, and examples | The outcome is observable and testable |
| Design | What is the simplest viable solution? | Design, interfaces, alternatives, risks, and decisions | The solution is feasible, understandable, and reversible |
| Breakdown | How do we obtain small increments? | Vertical stories, dependencies, and test cases | Each unit can be implemented and verified independently |
| Plan | Who does what, in what order, and with which limits? | Work DAG, assignments, workspaces, budgets, and integration | There are no ownership conflicts or hidden dependencies |
| Implementation | Can we produce the increment with immediate feedback? | Code, tests, commits, and local decisions | Local tests pass and the change can be integrated |
| Verify | Does it meet the contract without breaking existing behavior? | Independent acceptance, regression, and quality evidence | Every criterion has evidence |
| Judgment Day | Should we actually accept this result? | Verdict and delivery recommendation | `accept`, `accept_with_debt`, `rework`, `reject`, or `human_decision` |
| Learn / Close | What should xper retain for the future? | Retrospective, patterns, debt, and memory | Learning is recorded and the run is closed |

## Roles

Roles are responsibility profiles. They become ephemeral agents when the
coordinator needs them.

### Coordinator

- Maintains the state machine.
- Prepares the minimum context for each agent.
- Assigns roles, models, permissions, and workspaces.
- Evaluates input and output contracts.
- Detects blockers, dependencies, and conflicts.
- Decides which phase to return to after a failure.
- Requests human decisions when appropriate.
- Records events, artifacts, and evidence.

The Coordinator governs the process but does not replace other roles or make
domain decisions based solely on its own preference.

### Specialized roles

| Role | Responsibility |
| --- | --- |
| Explorer | Investigate the domain, repository, and uncertainties |
| Product / Customer proxy | Turn intent into observable behavior |
| Designer | Propose the minimum design and record decisions |
| Story slicer / Planner | Create vertical increments and the execution plan |
| Implementer | Implement the change with tests and criterion evidence |
| Verifier | Independently check behavior, regressions, scope, and simplicity without fixing the evaluated code |
| Judge | Issue the final verdict from a clean context |

Judge should receive the intent, criteria, diff, decisions, and evidence but
does not need to inherit the entire conversation. This reduces confirmation bias.

Delivery uses Implementer -> Verifier, with explicit delegation for each role.
The Plan contract uses `implementation.driver` and `verify.verifier` for these
roles. Their execution remains future work in
[XP-011](../tasks/011-implementation-verify.md).

## Domain concepts

| Concept | Description |
| --- | --- |
| Run | A complete xper execution for an objective |
| Phase | A workflow state |
| Phase visit | A specific entry into a phase, including revisits |
| Increment | A vertical unit of delivery |
| Assignment | Logical work assigned to a role |
| Attempt | A specific agent invocation for an assignment |
| Artifact | Versioned output of a phase |
| Evidence | Verifiable proof supporting a claim |
| Decision | A choice, alternatives, and justification |
| Gate | Conditions for advancing |
| Verdict | The result of an evaluation |
| Feedback | An explicit transition to an earlier phase |
| Policy | Limits on autonomy, security, cost, and quality |

## Minimum artifacts

Each run maintains a traceable record:

1. Discovery Brief.
2. Definition Contract.
3. Design Decisions.
4. Story Map.
5. Execution Plan.
6. Increment Records.
7. Verification Report.
8. Judgment Verdict.
9. Retrospective.

Agents communicate primarily through these artifacts and structured events.
Full transcripts are not the contract between phases.

## Judgment Day

`Judgment Day` is an adversarial acceptance evaluation. It must answer:

- Does it solve the defined problem?
- Is there evidence for every acceptance criterion?
- Was any unrequested behavior introduced?
- Is the solution more complex than necessary?
- Are important decisions justified?
- Is it safe to integrate or publish?
- What debt is being accepted deliberately?

Verdicts:

- `ACCEPT`
- `ACCEPT_WITH_DEBT`
- `REWORK_IMPLEMENTATION`
- `REVISIT_DESIGN`
- `REDEFINE`
- `HUMAN_DECISION`
- `REJECT`

## Conceptual architecture

- Pi provides the runtime and TUI for the parent session and child agents.
- The user starts the workflow with `/xper` within the Pi session.
- Pi is the first supported harness, not a dependency of the xper domain.
- The Pi adapter executes Discovery through a child Pi RPC process without
  an external agent-manager package.
- A TypeScript extension acts as the Pi adapter: commands, tools, hooks,
  dynamic context, and TUI integration.
- The Pi adapter implements the workflow and gates; the independent core
  resolves configuration and records execution facts for inspection and metrics.
- Each subagent has its own session; xper adds workspace isolation when the
  plan allows concurrent work.
- Durable state belongs to xper, not to a transcript.
- Concurrent changes happen in worktrees or other isolated environments.
- The coordinator integrates results according to the DAG defined in Plan.

The adapter communicates with the core through the public protocol. Its
execution dependencies are explicit, and recording does not decide the next
workflow action. Workflow checkpoints are opaque to the core.

Normal execution starts with `pi` followed by `/xper <objective>`. Bare `/xper`
asks for an objective interactively. This starts or resumes the run without
switching primary agents or automatically executing subsequent phases.
`xper run` is not part of the planned interface.
The full decision is documented in [RFC 0004](0004-pi-integration.md).
The current separation of core, protocol, and adapters is documented in
[RFC 0006](0006-configuration-recording-and-adapter-workflows.md).

## Open decisions

- Default human gates for supervised and autonomous modes.
- Exact integration and conflict-resolution policy.
- Artifact format and versioning.
- Initial context, cost, time, and attempt budgets.
- Strategy for identifying the smallest vertical increment.
- Requirements for any future external execution library.
