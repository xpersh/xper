# Knowledge workflow: Discovery through Plan

The Pi adapter implements the five knowledge phases introduced in XP-010.
Each explicit delegation executes one assignment, saves its output, evaluates
its gate locally, and reports the outcome to Rust. A ready Execution Plan
completes the knowledge instance; compatibility status still names its phase
`plan`. The next explicit delegation may execute only the first eligible
Implementer assignment in that Plan. It does not create worktrees, run the
Verifier or later increments, close the overall run, or issue a final verdict.

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
The first eligible root assignment starts a separate `pi.implementation` v1
instance for its increment, with nodes `implement` and `implemented`. This flow
freezes the assignment, accepted inputs, criteria, verification cases, model,
Git base, and limits. It is not an extra Knowledge phase. Verification and run
closure remain later product responsibilities.

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
or worktrees are allocated by Plan. XP-011.1 selects only the first root
Implementer in the Plan's sealed array order; later scheduling must honor the
remaining edges and the run concurrency limit.

This narrows Plan's semantic rules within `knowledge-v1`; its structure and
`schemaVersion: 1` remain unchanged. Existing artifacts and history are not
rewritten. Rust can still inspect their recorded facts, but current Pi validation
does not readmit Plans containing extra roles. New Plans are checked for a usable
Implementer handoff before sealing. Historical incompatible Plans remain
inspectable but produce a local replan diagnostic before delivery state is
created. See [XP-011](tasks/011-implementation-verify.md).

## First implementation assignment

After Plan is ready, call the same `xper_delegate` tool again. The checkout must
be the run's Git root and initially clean. With an active profile, Pi uses the
first frozen `implementation.driver` selection; otherwise it freezes the active
Pi model. The child receives every accepted artifact plus the selected story's
complete criteria and verification cases, and may use `read`, `bash`, `edit`,
and `write`. It must change only that increment, run useful tests, create a local
commit, leave the checkout clean, and never push.

The child returns strict JSON containing test commands and criterion evidence.
Pi treats these as proposals, not proof: it requires a new commit descended from
the recorded base, obtains the changed paths from Git, executes every declared
command serially under the same attempt deadline, writes bounded stdout/stderr
logs below `.xper/artifacts/`, and verifies that tests did not change tracked
files or HEAD. Pi never commits, pushes, resets, or cleans the checkout.

The resulting [implementation-v1 artifact](../schemas/implementation-v1.schema.json)
records the assignment and increment IDs, base and resulting Git hashes, changed
files, commands, observed exit codes, confined log references, and exact
criterion coverage. Nonzero test exits produce a failed attempt while retaining
that observed result as evidence. Only all-zero exits complete the implementation
instance. The run remains open; another explicit delegation cannot start the
Verifier in this slice.

Failures, cancellation, and timeout may be retried explicitly within both the
remaining run budget and the assignment's `maxAttempts`, `maxTimeMs`, and
`maxCostMicros`. Recovery marks an unfinished attempt `interrupted`, preserves
the checkout, and requires its `assignmentId` on retry; it never relaunches the
child automatically.

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
work. The Implementer additionally enforces its own cumulative assignment limits;
the child and host-run commands share one deadline.

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
6. Ensure the dedicated checkout is clean, then ask Pi to use `xper_delegate`
   once more for the first Implementer.

`/xper status` shows the phase, outcomes, artifact count, pending approval,
ready-plan state, and any Implementation instance position. `/xper advance`
evaluates the current gate; unlike the original
Discovery-only slice, a second call in Define now evaluates Define rather than
replaying Discovery's result. Repeated calls on an unchanged accepted Plan return
`ready: true, resumed: true` without new events.

Profiles must include the five Knowledge roles in the table to reach Plan and
`implementation.driver` to execute the first increment.
Existing Discovery-only profiles remain usable for Discovery; dispatch explains
when the current role has no route. New runs resume from Pi's versioned
checkpoint. Checkpoint envelope format 3 retains the unchanged Knowledge v2
state and a map of per-increment Implementation v1 instances. Valid Knowledge
format-1 and format-2 checkpoints migrate in memory without changing existing
run, visit, assignment, attempt, evidence, or outbox identities; format 3 is
written on the next local commit. Restoring a checkpoint does not repeat an
agent invocation. Core-owned legacy runs remain
available for historical inspection, but cannot resume under the new architecture
because they lack that checkpoint.

## Verification

Pi workflow tests exercise gates, feedback, evidence, dependency validation,
budgets, approvals, implementation recovery, and unavailable recording using
synthetic artifacts and controlled dependencies. Real temporary Git checkout
tests cover commits, ancestry, cleanliness, changed files, host-run commands,
logs, failed exits, and source mutation without model credentials.
Recording tests independently exercise session ownership, duplicate consistency,
atomic event batches, and generic replay. Integration tests use the real Rust
bridge and SQLite with simulated execution, without model credentials. Recording
failure and checkpoint recovery must preserve the original execution outcome.
An unresolved recorder request must also leave local operations usable; testing
only a prompt error response does not establish that execution is independent.

`npm run check` includes Rust/TypeScript checks and `npm run test:contracts`,
which validates the shared fixtures against both JSON Schemas with Ajv.
