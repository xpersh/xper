# Knowledge workflow: Discovery through Plan

The Pi adapter implements the five knowledge phases introduced in XP-010.
Each explicit delegation executes one assignment, saves its output, evaluates
its gate locally, and reports the outcome to Rust. A ready Execution Plan
completes the knowledge instance; compatibility status still names its phase
`plan`. It does not create worktrees, execute delivery assignments, close the
overall run, or issue a final verdict.

These are Pi workflow rules, not core recording rules. Rust resolves
configuration and preserves the reported events and opaque Pi checkpoint.
[RFC 0006](rfcs/0006-configuration-recording-and-adapter-workflows.md) explains
the ownership boundary. Moving these rules into Pi preserves its current gates;
it does not make every phase transition unrestricted.

Local start, delegation, advancement, approval, status, and checkpoint recovery
do not wait for Rust. Configuration is prepared separately and events are
delivered in the background. Missing, slow, or rejected telemetry remains visible
without changing workflow outcomes. Local evidence and checkpoint integrity
checks still apply.

## State and composition

The adapter uses an explicit pure state machine and the versioned `pi.knowledge`
graph. Declared edges describe forward progress, feedback, and completion;
artifact and budget guards determine whether a command may take an edge.
Knowledge phase, approval lifecycle, and each attempt's outcome are separate
state. Models work within assignment contracts without owning the transition
protocol. [RFC 0007](rfcs/0007-explicit-adapter-state-machines.md) defines this
boundary and the future read-only visualization contract.

The completed instance hands off a sealed Plan by artifact identity and digest.
Future Implementation and Verification flows will have their own definitions
and per-increment instances under the same run; they can coexist according to
the Plan DAG. They are not extra knowledge phases, and this refactor does not
execute them. Run closure remains a later product responsibility.

## Phase contracts

| Phase | Role | Minimum output | Inputs |
| --- | --- | --- | --- |
| Discovery | `discovery.explorer` | Markdown Discovery Brief: context, evidence, risks, and questions | Existing upstream evidence and feedback on a revisit, otherwise the objective |
| Define | `define.product` | Goal, scope, exclusions, uniquely identified observable criteria with examples | Accepted Discovery Brief |
| Design | `design.designer` | Approach, interfaces, alternatives, risks, and feasibility | Accepted Brief and Definition Contract |
| Breakdown | `breakdown.slicer` | Vertical stories with value, criterion references, verification cases, independence, and dependencies | Accepted Brief, Definition Contract, and Design Decisions |
| Plan | `plan.planner` | Assignment DAG with delivery roles, workspaces, exclusive resources, and per-assignment limits | All four accepted upstream artifacts |

Define through Plan use [knowledge-v1.schema.json](../schemas/knowledge-v1.schema.json).
[Shared synthetic examples](../fixtures/knowledge-v1.json) contain complete output
shapes. Each document has `schemaVersion: 1`, `inputs` containing exactly the
artifact IDs supplied by the adapter's assignment, and a tagged `output` object.
A transcript is never an input contract. Discovery retains the original Markdown
format and nonempty-file gate for compatibility; the adapter does not infer its
semantic completeness from prose.

The local assignment operation returns the role, routed selection, phase,
output kind/path, input artifact references, timeout, and remaining budget. Inputs include the
feedback artifact when revisiting a phase. The adapter reads these files in an
isolated child session and writes the new output without overwriting evidence.
The local completion operation validates the path, contract version, kind, and
input identities; advancement evaluates minimum evidence, graph invariants, and cross-artifact
relationships. A structurally valid but inadequate output is retained for
inspection with a blocked gate. Submit a corrected assignment in the same visit.
Malformed JSON or mismatched references cannot register a successful artifact.
Pi records invalid output as a failed execution, allowing a corrected assignment
without leaving the old attempt running. A recording transport error is different:
it leaves execution outcomes intact and queues the events for retry with the
same identities. It must not execute the agent again to obtain an acknowledgement.

Artifacts remain in `.xper/artifacts/`; the event log contains references,
versions, input identities, and SHA-256 digests, not artifact content. Reads are
bounded to 1 MiB and confined to that directory. Dispatch and gates reject missing
or modified input evidence. Gates also recheck their output digest, so changing a
file cannot reuse a previous approval. Output versions increase within each kind.

## Feedback and graph validation

An output may instead be `feedback` with concrete `evidence` and one of:

| Reason | Responsible phase |
| --- | --- |
| `missing_context` | Discovery |
| `ambiguous_criteria` | Define |
| `infeasible_design` | Design |
| `oversized_story` | Breakdown |

Pi revisits an earlier responsible phase, increments its visit number, and
invalidates acceptance of that phase and everything downstream. Earlier evidence
and the feedback artifact form the next assignment's inputs. Feedback identifying
the current phase blocks until corrected. It cannot skip forward. A Design output
with `feasible: false` stays in Design.

Breakdown rejects stories without independent verification, missing value or
examples, unknown criterion references, uncovered criteria, duplicate IDs,
unknown dependencies, self-dependencies, or cycles.

Plan requires exactly one Implementer (`implementation.driver`) and one Verifier
(`verify.verifier`) per increment. Verification must follow implementation,
and every assignment of a dependent increment must follow its
prerequisites' verification. Both DAGs have deterministic topological validation.
Unordered assignments cannot share a workspace or an exclusive resource, even
when the current concurrency limit would happen to serialize them. Workspaces
are logical IDs made of ASCII letters, digits, `_`, and `-`; no filesystem paths
or worktrees are allocated by Plan. Future implementation scheduling must honor
these edges and the run concurrency limit.

This narrows Plan's semantic rules within `knowledge-v1`; its structure and
`schemaVersion: 1` remain unchanged. Existing artifacts and history are not
rewritten. Rust can still inspect their recorded facts, but current Pi validation
does not readmit Plans containing extra roles. Delivery execution remains future
work in [XP-011](tasks/011-implementation-verify.md).

## Limits and human gates

Configure the normal global, project, or local configuration scopes:

```yaml
workflow:
  knowledge:
    maxAttempts: 32
    maxTimeMs: 3600000
    attemptTimeMs: 120000
    maxConcurrency: 4
    maxCostMicros: 1000000
    attemptCostMicros: 10000
    humanGates:
      - define
      - plan
```

The defaults are 32 attempts, one hour of wall time, two minutes per attempt,
four concurrent attempts, no cost ceiling, and automatic gates. A configured
cost ceiling requires a positive per-attempt reservation. All values are frozen
at run start, including when the session resumes after a configuration change.
Rust returns this configuration without interpreting the workflow policy; Pi
prepares and validates it in the background. A run freezes the latest available
prepared policy, or the defaults above if none is ready, in its checkpoint.
That choice is visible and cannot be changed by a later configuration response.
There is no core
`run.start.policy` command under the new boundary.

Attempt count and elapsed time apply across retries and revisits. Time includes
human waits. Admission checks concurrency and cost before recording dispatch;
the adapter applies those checks before executing work. The timeout is the
smaller of its configured limit and remaining run time. A late successful
completion is normalized by Pi to `timed_out`, without registering an artifact.
Interrupted attempts keep their charges and count toward limits.

Cost is conservative reservation accounting in micro currency units, **not a
provider billing meter**. Each admitted attempt consumes its configured
reservation, including failures and interruptions. No unused amount is refunded.
The reservation must represent the operator's expected maximum invocation cost;
this slice does not observe token prices or interrupt a provider at a billing
threshold. Plan checks the sum of proposed assignment budgets against remaining
attempt, wall-time, and cost limits, conservatively summing time even for parallel
work. Per-assignment execution enforcement belongs to XP-011.

Human gates are owned by Pi. A gate first records a request naming its current
artifact. Review the file, then explicitly run `/xper approve <artifactId>`.
The adapter checks the pending visit, identity, digest, and all automatic
conditions again. A stale approval cannot bypass a corrected
artifact or a revisit. The delegation tool never grants approval automatically.

## Running the workflow in Pi

After the normal checkout build:

1. Run `/xper <objective>`.
2. Ask Pi to use `xper_delegate` for the current phase.
3. Inspect a blocked gate's reason and produce a corrected output or feedback.
4. Approve a configured human gate using the displayed artifact ID.
5. Repeat until the response says `execution plan ready`.

`/xper status` shows the phase, outcomes, artifact count, pending approval, and
ready-plan state. `/xper advance` evaluates the current gate; unlike the original
Discovery-only slice, a second call in Define now evaluates Define rather than
replaying Discovery's result. Repeated calls on an unchanged accepted Plan return
`ready: true, resumed: true` without new events.

Profiles must include the five roles in the table to execute the entire flow.
Existing Discovery-only profiles remain usable for Discovery; dispatch explains
when the current role has no route. New runs resume from Pi's versioned
checkpoint. Checkpoint format 2 gives the instance an explicit definition
reference and lifecycle; valid format-1 checkpoints migrate locally without
changing existing run, visit, assignment, attempt, or event identities. Restoring
a checkpoint does not repeat an agent invocation. Core-owned legacy runs remain
available for historical inspection, but cannot resume under the new architecture
because they lack that checkpoint.

## Verification

Pi workflow tests exercise gates, feedback, evidence, dependency validation,
budgets, and approvals using synthetic artifacts and controlled dependencies.
Recording tests independently exercise session ownership, duplicate consistency,
atomic event batches, and generic replay. Integration tests use the real Rust
bridge and SQLite with simulated execution, without model credentials. Recording
failure and checkpoint recovery must preserve the original execution outcome.
An unresolved recorder request must also leave local operations usable; testing
only a prompt error response does not establish that execution is independent.

`npm run check` includes Rust/TypeScript checks and `npm run test:contracts`,
which validates the shared fixtures against both JSON Schemas with Ajv.
