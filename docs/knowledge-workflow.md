# Knowledge workflow: Discovery through Plan

The Pi adapter implements the five knowledge phases introduced in XP-010.
Each explicit delegation executes one assignment, saves its output, evaluates
its gate locally, and reports the outcome to Rust. A ready Execution Plan
completes the knowledge instance; compatibility status still names its phase
`plan`. Subsequent explicit delegations execute the next eligible Implementer
and its dependent Verifier, one increment at a time. Rejection enables a fresh
bounded Implementation instance unless the Verifier identifies ambiguous
criteria or an infeasible design. Those concrete problems reopen Define or
Design and require a revised Plan plus an explicit checkout-resumption decision.
The adapter does not create worktrees, run increments concurrently, close the
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
v2 graph. Declared edges describe forward progress, feedback, and completion,
including the terminal `ready -> define` and `ready -> design`
delivery-feedback edges;
artifact and budget guards determine whether a command may take an edge.
Knowledge phase, approval lifecycle, and each attempt's outcome are separate
state. Models work within assignment contracts without owning the transition
protocol. [RFC 0007](rfcs/0007-explicit-adapter-state-machines.md) defines this
boundary and the future read-only visualization contract.

The completed instance hands off a sealed Plan by artifact identity and digest.
The next eligible assignment starts a separate `pi.implementation` v1 instance
for its increment, with nodes `implement` and `implemented`. This flow freezes
the assignment, accepted inputs, direct dependency evidence, criteria,
verification cases, model, Git base, and limits. It is not an extra Knowledge
phase. Verification and run closure remain separate responsibilities. A completed Implementation hands its
exact artifact, digest, base, and resulting commit to a `pi.verification` v1
instance with nodes `verify`, `verified`, and `rejected`. Histories retain every
Implementation and Verification instance; only their latest positions are
projected per increment. Knowledge state v3 can import immutable artifact
references owned by another flow, so the Verification result that caused a
revisit remains an exact assignment input without changing artifact ownership.

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
or worktrees are allocated by Plan. The delivery loop selects the first pending
Implementer in the Plan's sealed array order whose explicit dependencies have
verified evidence, then its unique dependent Verifier. Independent increments
use the same ordering and run sequentially; no eligible assignment starts
without an explicit delegation.

This narrows Plan's semantic rules within `knowledge-v1`; its structure and
`schemaVersion: 1` remain unchanged. Existing artifacts and history are not
rewritten. Rust can still inspect their recorded facts, but current Pi validation
does not readmit Plans containing extra roles. New Plans are checked for a usable
Implementer handoff before sealing. Historical incompatible Plans remain
inspectable but produce a local replan diagnostic before delivery state is
created. See [XP-011](tasks/011-implementation-verify.md).

## Sequential implementation and verification

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
dependent Verifier until Implementation has completed.

The next explicit delegation requires a clean checkout whose `HEAD` is the
Implementation result's exact commit. Pi starts a fresh Verifier child with only
`read` and `bash`. Its prompt includes all accepted artifacts, the Implementation
result and logs, complete criteria and verification cases, and the full diff;
it forbids edits, repairs, commits, resets, and cleanup. The child proposes strict
JSON with criterion findings, regression/scope/simplicity findings, optional
additional commands, and either `verified` or an evidenced `rejected` verdict.
It does not report test exit statuses.

The host runs every command recorded by Implementation, then the Verifier's
additional commands, removing exact duplicates while preserving first order.
Agent and commands share one deadline. After the child and after each command,
Pi confirms both `HEAD` and the evaluated tree are unchanged. Output logs are
bounded and confined below `.xper/artifacts/`; mutations are preserved for
explicit recovery and are never reset or repaired automatically.

The canonical [verification-v1 artifact](../schemas/verification-v1.schema.json)
binds the review to its assignment, increment, Implementation artifact, original
base, and evaluated commit. It records actual host-observed command exits and
evidence for every criterion plus regressions, requested scope, and simplicity.
A failed host command converts an approving proposal into a rejection. A valid
rejection completes the Verification execution with domain verdict `rejected`.
With no `knowledgeFeedback`, it makes a new explicitly delegated Implementation
instance eligible. That instance starts from the rejected commit and receives
both prior result artifacts; neither prior evidence nor consumed budgets are
replaced. A new result always requires a new Verification instance.

An optional `knowledgeFeedback.reason` instead identifies exactly one upstream
problem: `ambiguous_criteria` reopens Define and `infeasible_design` reopens
Design. Pi accepts no other shape or reason. A host-observed failing command
always clears a proposed Knowledge classification and remains Implementation
rework. For valid Knowledge feedback, Pi first commits the rejected Verification
artifact and `knowledge.feedback_requested` fact. It then imports that exact
artifact reference into Knowledge, invalidates acceptance from the target phase,
creates one visit, and records the declared feedback transition. The handoff is
idempotent by Verification artifact; recovery completes a pending handoff without
running an agent or consulting Rust.

While Knowledge is revisiting, the previous Plan cannot dispatch Implementation
or Verification. Sealing the revised Plan creates an `awaiting_resume`
reconciliation and invalidates every previously verified delivery artifact from
the old Plan. Those artifacts remain historical evidence but satisfy no revised
assignment or dependency. `/xper resume <commit>` accepts a full lowercase
40- or 64-character Git hash only when the dedicated checkout is clean and
`HEAD` is already exactly that commit; it records the decision without changing
Git. Repeating the same Plan/commit is idempotent, while choosing another commit
afterward is rejected. The revised Plan then requires complete new Implementation
and Verification cycles from that base. Global spent budget remains cumulative,
and assignments retaining the same ID and role also retain their historical
attempt consumption.

`verified` marks only its increment and does not emit `run.finished` or
automatically schedule another increment. When called again explicitly,
delegation selects the next Plan-eligible Implementer, requires the clean checkout
at the latest verified commit, and includes direct dependency artifacts in its
sealed inputs. Once every increment verifies, the open run is ready for Judgment
Day; the next explicit delegation obtains its recommendation.

Failures, cancellation, and timeout may be retried explicitly within both the
remaining run budget and the assignment's `maxAttempts`, `maxTimeMs`, and
`maxCostMicros`. Recovery marks an unfinished attempt `interrupted`, preserves
the checkout, and requires its `assignmentId` on retry; it never relaunches the
child automatically.

## Judge recommendation

After every increment in the authorized Plan verifies, call `xper_delegate`
explicitly for `judgment_day.judge`. The fresh child receives sealed Knowledge,
all current delivery results, test logs, and a host-read cumulative diff. It has
only the `read` tool and cannot run tests or commands. The host requires the clean
final verified revision and unchanged evidence before and after evaluation.

The versioned `judgment_verdict` contains one finding per criterion, reasons and
criticisms. Each finding cites supplied artifact IDs (bound to recorded digests)
or `git:<baseCommit>..<evaluatedCommit>` for the exact supplied diff. The seven
recommendations are `ACCEPT`, `ACCEPT_WITH_DEBT`, `REWORK_IMPLEMENTATION`,
`REVISIT_DESIGN`, `REDEFINE`, `HUMAN_DECISION`, and `REJECT`. None applies a decision
or closes the run in this slice. Invalid reports fail the attempt; valid reports
remain inspectable and cannot trigger a second evaluation.

Interruption requires explicit retry with the displayed `assignmentId`. The
assignment retains its model, evidence and Git revision, including log digests;
changed or missing inputs block retry. Use the configured Judge route when a
profile is frozen; without a profile, freeze the active Pi model. Actual response
provider/model identities remain separate `model.usage` facts.

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
work. Implementation and Verification each enforce their assignment limits
cumulatively across all instances for that Plan assignment. The global budget
sums Knowledge, Implementation, Verification, and Judgment attempts. Judge uses
only the run limits and configured per-attempt timeout. Each child and its
host-run commands share one deadline.

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
7. With the resulting commit still clean and checked out, delegate again for
   Verifier. If rejected for Implementation, delegate the bounded rework and then
   a fresh review. If it returns to Define or Design, revise and seal the Plan,
   then run `/xper resume <commit>` before delegating fresh delivery.
8. After all increments verify, delegate once for Judge and inspect its unapplied
   recommendation; applying the verdict remains future work.

`/xper status` shows the phase, outcomes, artifact count, pending approval,
ready-plan state, latest Implementation/Verification positions, the Judge report
and evaluated revision, and any
pending reconciliation with its exact resume command. `xper_delegate` reports
the same block and never resumes implicitly. `/xper advance` evaluates the
current gate; unlike the original
Discovery-only slice, a second call in Define now evaluates Define rather than
replaying Discovery's result. Repeated calls on an unchanged accepted Plan return
`ready: true, resumed: true` without new events.

Profiles must include the five Knowledge roles in the table to reach Plan plus
`implementation.driver` and `verify.verifier` for delivery, and
`judgment_day.judge` for Judgment.
Existing Discovery-only profiles remain usable for Discovery; dispatch explains
when the current role has no route. New runs resume from Pi's versioned
checkpoint. Checkpoint envelope format 6 contains Knowledge v3, ordered
per-increment histories of Implementation v1 and Verification v1, the currently
authorized Plan, sequential reconciliation records, and nullable Judgment v1
state with frozen evidence references and report metadata. Each delivery history is
validated against its own historical Plan; only the authorized Plan contributes
to the current frontier, satisfied dependencies, and sequential Git tip. Valid
Knowledge v1/v2 states and envelope formats 1 through 5 migrate in memory without
changing existing run, visit, assignment, attempt, evidence, budget, or outbox
identities. Reading alone does not rewrite the journal; the next local commit
writes format 6. Restoring a checkpoint does not repeat an agent invocation.
Core-owned legacy runs remain
available for historical inspection, but cannot resume under the new architecture
because they lack that checkpoint.

## Verification

Pi workflow tests exercise gates, feedback, evidence, dependency validation,
budgets, approvals, implementation/verification recovery, Knowledge handoff,
conservative reconciliation, explicit resumption, and unavailable recording
using synthetic artifacts and controlled dependencies. Real temporary Git
checkout tests cover commits, ancestry, cleanliness, changed files, host-run
commands, logs, failed exits, review override, command ordering/deduplication,
source mutation, dirty/mismatched resume attempts, and exact selected revisions
without model credentials.
Recording tests independently exercise session ownership, duplicate consistency,
atomic event batches, and generic replay. Integration tests use the real Rust
bridge and SQLite with simulated execution, without model credentials. Recording
failure and checkpoint recovery must preserve the original execution outcome.
An unresolved recorder request must also leave local operations usable; testing
only a prompt error response does not establish that execution is independent.

`npm run check` includes Rust/TypeScript checks and `npm run test:contracts`,
which validates the shared fixtures against both JSON Schemas with Ajv.
