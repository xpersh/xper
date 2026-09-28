# Knowledge workflow: Discovery through Plan

XP-010 implements the five knowledge phases. Each explicit delegation executes
one assignment, saves its output, records the outcome, and asks the core to
evaluate its gate. A ready Execution Plan remains in `plan`. It does not create
worktrees, execute delivery assignments, or issue a final verdict.

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
artifact IDs returned by `assignment.start`, and a tagged `output` object.
A transcript is never an input contract. Discovery retains the original Markdown
format and nonempty-file gate for compatibility; the core does not infer its
semantic completeness from prose.

`assignment.start` returns the role, routed selection, phase, output kind/path,
input artifact references, timeout, and remaining budget. Inputs include the
feedback artifact when revisiting a phase. The adapter reads these files in an
isolated child session and writes the new output without overwriting evidence.
`attempt.finish` validates the path, contract version, kind, and input identities;
`run.advance` evaluates minimum evidence, graph invariants, and cross-artifact
relationships. A structurally valid but inadequate output is retained for
inspection with a blocked gate. Submit a corrected assignment in the same visit.
Malformed JSON or mismatched references cannot register a successful artifact.
Pi records these executions as failed after an explicit core rejection, allowing
a corrected assignment without leaving the old attempt running. Transport or
internal failures propagate because their commit outcome can be unknown.

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

The core revisits an earlier responsible phase, increments its visit number, and
invalidates acceptance of that phase and everything downstream. Earlier evidence
and the feedback artifact form the next assignment's inputs. Feedback identifying
the current phase blocks until corrected. It cannot skip forward. A Design output
with `feasible: false` stays in Design.

Breakdown rejects stories without independent verification, missing value or
examples, unknown criterion references, uncovered criteria, duplicate IDs,
unknown dependencies, self-dependencies, or cycles.

Plan requires exactly one `implementation.driver`, `implementation.navigator`,
and `verify.verifier` per increment. Verification must follow both delivery
assignments, and every assignment of a dependent increment must follow its
prerequisites' verification. Both DAGs have deterministic topological validation.
Unordered assignments cannot share a workspace or an exclusive resource, even
when the current concurrency limit would happen to serialize them. Workspaces
are logical IDs made of ASCII letters, digits, `_`, and `-`; no filesystem paths
or worktrees are allocated by Plan. Pair roles sharing a workspace must have an
explicit order. Future implementation scheduling must honor these edges and the
run concurrency limit.

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
`run.start.policy` can explicitly supply the same policy through the protocol.

Attempt count and elapsed time apply across retries and revisits. Time includes
human waits. Admission checks concurrency and cost before recording dispatch;
replay checks admission again inside the atomic store boundary. The adapter gets
the smaller of its configured timeout and remaining run time. A late successful
completion is durably normalized to `timed_out`, without registering an artifact.
Interrupted attempts keep their charges and count toward limits.

Cost is conservative reservation accounting in micro currency units, **not a
provider billing meter**. Each admitted attempt consumes its configured
reservation, including failures and interruptions. No unused amount is refunded.
The reservation must represent the operator's expected maximum invocation cost;
this slice does not observe token prices or interrupt a provider at a billing
threshold. Plan checks the sum of proposed assignment budgets against remaining
attempt, wall-time, and cost limits, conservatively summing time even for parallel
work. Per-assignment execution enforcement belongs to XP-011.

Human gates require the adapter's `humanApproval` capability. A gate first
persists a request naming its current artifact. Review the file, then explicitly
run `/xper approve <artifactId>`. This sends `run.advance` with
`approvedArtifactId`; the core checks the pending visit, identity, digest, and
all automatic conditions again. A stale approval cannot bypass a corrected
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
when the current role has no route. Legacy Discovery events and Markdown Briefs
still replay; an accepted legacy Brief becomes Define's input. Historical evidence
without a digest retains its original availability-only checks.

## Verification

Application tests use deterministic clocks, IDs, an in-memory transactional
repository, and fake artifact readers. They cover all five gates, every feedback
origin, invalid stories and DAGs, budgets, human approvals, evidence mutation,
legacy history, atomic failure, and timeout normalization. Domain tests exercise
the shared transition and DAG rules. The bridge integration test uses SQLite,
real files, shared JSON fixtures, and fake execution; it reopens during a human
gate and after Plan. No test needs model credentials.

`npm run check` includes Rust/TypeScript checks and `npm run test:contracts`,
which validates the shared fixtures against both JSON Schemas with Ajv.
