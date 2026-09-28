# RFC 0007: Explicit adapter state machines

- Status: accepted
- Date: 2026-09-28
- Builds on: [RFC 0006](0006-configuration-recording-and-adapter-workflows.md)
- Scope: Pi knowledge workflow, composition boundaries, and future inspection

## Decision

Represent Pi's knowledge workflow as a small typed state machine with a pure
transition function. Keep its runtime, artifact reads, model execution, and
local persistence outside that function. Use the same versioned, serializable
workflow definition for permitted graph transitions and future visualization.

This makes existing decisions explicit; it does not change the phase contracts,
authorize automatic delegation, or implement delivery, verification, or a UI.
The machine constrains protocol steps and evidence. Models retain responsibility
for their reasoning within an assignment's contract.

A local reducer is sufficient for the current workflow. Do not build a generic
statechart engine, plugin registry, or command bus. A statechart library can be
reconsidered when actual hierarchical or parallel coordination justifies it.

## Decision and effect boundary

The reducer receives state, a typed command, and explicit validated evidence,
identities, configuration, and time. It returns the next state, a result, and
facts describing the decision. Invalid commands return an explicit error;
they do not silently create a transition. The reducer performs no I/O, reads
no clock, generates no random identifiers, and calls neither Pi nor Rust.

The runtime obtains and checks evidence, invokes the reducer, commits local
state and its outbox, and coordinates execution effects. Agent execution is
never replayed merely because telemetry delivery failed. There must be one
owner of transitions: the controller must not retain a parallel collection of
state mutations after extraction.

Rust remains a passive configuration and recording service. Its availability,
acknowledgement, projections, or errors cannot be a transition guard. Local
workflow operations never await it. The outbox delivers observations in the
background according to RFC 0006.

## Definitions, state, and identity

The graph definition is data: stable node and edge IDs, explicit source and
target nodes, transition meaning, and labels. Execution uses those edges;
array order is not a hidden transition rule. Guards and artifact semantics
remain typed Pi code. A graph edge describes a possible transition, not proof
that the current evidence satisfies its gate.

| Identity or version | Meaning |
| --- | --- |
| Definition ID and version | Which workflow and graph semantics an instance uses |
| Definition format version | How the serializable graph is represented |
| Checkpoint format version | How Pi validates and restores persisted runtime state |
| Run ID | Correlation for the overall development objective |
| Workflow instance ID | One execution of a particular definition within that run |
| Visit ID | One knowledge phase entry, including revisits; completion retains the final phase visit |
| Assignment and attempt IDs | Logical work and one concrete invocation of that work |
| Artifact ID, version, and digest | The exact evidence consumed or produced |

New runs assign distinct run and instance IDs. Migrating a format-1 checkpoint
uses its existing run ID as the instance ID for historical stability; this does
not make the two concepts interchangeable. Updating checkpoint
representation does not create a new workflow definition, and a second instance
of the same definition does not require a new definition version. A run freezes
its definition reference as well as its prepared configuration. A semantic
graph change requires an explicit definition version and compatibility decision;
a historical run must not silently acquire the latest graph.

Keep the knowledge phase separate from execution lifecycle and per-attempt
outcomes. Waiting for an approval is not a new knowledge phase. Each attempt
has its own identity and outcome, so future concurrent attempts do not require
an enum for every combination of running and completed agents.

## Composition after Plan

The implemented definition covers Discovery, Define, Design, Breakdown, and
Plan. Completion means that this knowledge instance has a validated, sealed
Execution Plan. It does not mean that the development objective has been
implemented, independently verified, accepted, or closed.

Future coordination consumes that Plan by artifact identity and digest. It can
create separate Implementation and Verification instances for each increment,
linked to the same run, increment, and plan revision. Multiple increment
instances may coexist when the Plan's dependencies, workspace ownership, and
budgets permit it. Each flow owns its node vocabulary, transitions, checkpoint,
and evidence contracts. Do not append every future node to a global `Phase`
union or expand the knowledge reducer into the whole product's state machine.

The coordinator will own cross-flow scheduling and handoff; individual flows
own their internal transitions. Verification feedback may request implementation
rework or a knowledge revisit. That request must identify its cause and affected
evidence; it does not directly mutate another flow's state. A changed Plan must
be reconciled with existing increment work before further dispatch. Final
acceptance and run closure remain [XP-012](../tasks/012-judgment-day.md).

### Delivery staging revision — 2026-09-28

[XP-011](../tasks/011-implementation-verify.md) implements this boundary in
separately reviewed slices: one Implementer, independent Verifier, subsequent
increments, and then Knowledge feedback. Use one supplied checkout and no
Navigator or pair rotation. Keep delegation through `xper_delegate`; the main
Pi agent still decides when to invoke it. Separate flow definitions do not require separate
public tools or duplicate execution, persistence, and telemetry runtimes.

Concurrent instances, managed workspace isolation, and selective
Plan reconciliation remain future capabilities. Do not implement them merely to
make the first flow extensible. Initial reconciliation conservatively invalidates
old approvals and requires an explicit continuation decision; it does not need a
general engine for preserving work across changed DAGs. These scope limits refine
delivery order without removing the identity, evidence, or ownership boundaries.

## Future visualization boundary

A future read-only view combines the exact versioned definition with reported
instance positions, transitions, visits, attempts, and evidence references.
The topology comes from declared edges; observed history highlights what
actually happened. The view must not derive allowed transitions from phase
array order, observed event order, or a hardcoded Discovery-to-Plan diagram.

The UI does not run the reducer, evaluate gates, infer approval, or command an
agent. Rust stores definitions and instance observations as opaque adapter data;
it need not understand their node names or edges. The presentation layer may
understand their versioned shape without making the recorder a workflow engine.

Shared history can lag local Pi execution. Show last reported position and
recording completeness honestly; a missing definition, unsupported version,
legacy history, or missing events must produce an explicit incomplete view.
Never draw an invented transition or substitute a newer graph to fill a gap.
The implementation reports `workflow.definition`, `workflow.position`, traversed
`workflow.transition` edges, and `workflow.completed`, with definition and
instance references. A definition can be reported again after runtime reload.
Position changes and graph transitions are distinct: settling an attempt does
not necessarily leave its node. Completion reports node `ready` and keeps the
final Plan visit. The [Pi guide](../../adapters/pi/docs/architecture.md#reported-topology-and-position)
describes the event fields and compatibility status.

Graph delivery and inspection are not execution prerequisites. No dashboard or
renderer is implemented by this refactor; [XP-015](../tasks/015-workflow-visualization.md)
tracks the follow-on work.

## Recovery and verification

The implemented knowledge definition is `pi.knowledge` at version 1. Its
checkpoint format is independently versioned: format 2 migrates valid format-1
state in memory while preserving existing identities and pending facts. A read
alone does not rewrite the checkpoint format; the next commit with new facts
persists the new format. Background delivery may still save the existing journal
while retaining its old state and the original pending event identities.

Restore local checkpoints with an explicit format validator and migration path.
Do not rerun effects during restoration. An unfinished invocation has an unknown
execution outcome and becomes interrupted; an explicit retry preserves its
assignment inputs and frozen selection while creating a new attempt.

Test the reducer independently with fixed identifiers, time, and evidence.
Cover valid and invalid transitions, feedback, approvals, completion, and
independent attempt settlement. Check definition topology and stable references
alongside execution behavior so a diagram cannot drift into a second workflow.
Recovery tests must cover supported migrations and reject unknown definitions
or damaged state without inventing progress. Runtime tests retain the guarantee
that missing, rejecting, and never-resolving Rust cannot delay local execution.
