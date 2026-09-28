# RFC 0003: Observability and metrics

- Status: draft
- Date: 2026-09-22
- Depends on: [RFC 0001](0001-product-and-workflow.md) and [RFC 0002](0002-multimodel-configuration.md)

[RFC 0006](0006-configuration-recording-and-adapter-workflows.md) accepts the
passive recording boundary: adapters own workflow meaning; Rust records and
projects their reported facts. The hierarchy, richer event catalog, formulas,
and UI below remain design targets except where the
[core guide](../architecture.md) describes implemented behavior. The actual
event envelope and negotiated capabilities are in the [public protocol](../../schemas/README.md).

## Summary

`Xper Observability` is the local subsystem that records workflow, agent,
model, tool, gate, and human-intervention activity. Its data supports run
inspection, rework detection, and profile or experiment comparisons without
relying on a transcript.

SQLite is the proposed local storage. The design is event-sourced: an
append-only log holds the source of truth, and projections serve the CLI and
a future GUI.

## Goals

- Measure time, cost, tokens, attempts, rework, and outcomes.
- Reconstruct a run's timeline.
- Compare models and execution profiles.
- Separate xper activity from Pi's internal activity.
- Preserve privacy and isolation between contexts.
- Avoid affecting execution when metrics capture fails.

## Non-goals

- Store prompts, responses, or code by default.
- Measure human productivity.
- Assign a universal score to incomparable tasks.
- Turn correlational metrics into causal conclusions.
- Require an external telemetry platform.

## Execution hierarchy

```text
Xper Run
└── Phase Visit
    └── Assignment
        └── Attempt / Agent Invocation
            ├── Pi Agent Cycles
            ├── LLM Requests
            └── Tool Executions
```

### Definitions

- **Run:** a complete development session managed by xper.
- **Phase visit:** an entry into a phase, including revisits.
- **Assignment:** a logical unit assigned to a role.
- **Attempt:** a specific agent invocation to resolve an assignment.
- **Pi agent cycle:** an internal Pi execution, including retries or continuations.
- **LLM request:** a specific call to a provider.
- **Tool execution:** a tool invocation with a start and end.

An attempt starts when the coordinator instantiates the assignment and creates
the agent. It ends when the agent settles, fails, is cancelled, times out, or
is replaced.

Pi can emit `agent_end` before a retry, automatic compaction, or continuation.
xper therefore uses `agent_settled` as the invocation's final boundary and
retains `agent_start`, `agent_end`, and retry events as internal detail.

References:

- [Pi extension events](https://pi.dev/docs/latest/extensions)
- [Pi RPC events](https://pi.dev/docs/latest/rpc)
- [Pi telemetry schema](https://github.com/earendil-works/pi/blob/main/packages/agent/docs/telemetry-schema.md)

## Event sources

### Adapter workflow events

```text
run.started
run.suspended
run.resumed
run.completed
run.failed

phase.entered
phase.exited
phase.revisited

assignment.created
assignment.completed

attempt.started
attempt.settled
attempt.failed
attempt.aborted
attempt.timed_out

gate.evaluated
gate.passed
gate.failed

model.resolved
model.fallback_applied
model.switched

human.wait_started
human.wait_ended
human.intervention

artifact.created
increment.accepted
```

### Events adapted from Pi

- Agent and turn lifecycle.
- Tool start, update, and end.
- Provider-reported usage and cost.
- Retries, errors, and compactions.
- Model or reasoning-level changes.
- Message and queue state when relevant.

The Pi adapter emits workflow meaning and runtime detail. It creates an
attempt locally and reports its start and explicit result to Rust. The child
process is correlated with its assignment, phase, model, and effective
profile. Generic Pi tool observations do not settle attempts or pass gates.
Rust records the decisions; it does not make them. The database does not depend
on an agent-manager package's internal format.

## Common envelope

Each event uses a versioned envelope:

```yaml
event_id: 0199...
event_type: attempt.started
schema_version: 1
timestamp_utc: 2026-09-22T12:00:00.000Z
monotonic_time_ms: 184423

run_id: run-123
phase_visit_id: phase-456
assignment_id: assignment-789
attempt_id: attempt-abc

agent_role: implementation.driver
context: company
execution_profile: work

trace_id: trace-123
span_id: span-789
parent_span_id: span-456

payload: {}
```

UTC timestamps allow persisted activity to be ordered. A monotonic clock is
used to calculate durations without being affected by system-clock changes.

The `trace_id` / `span_id` relationship represents concurrency, the critical
path, and parent-child relationships.

## Pipeline

```text
Coordinator events ----+
                       |
Pi session events -----+---> Event Collector ---> SQLite
                       |                         +-- raw events
Pi telemetry ----------+                         +-- projections
                                                 +-- aggregates
```

The integration records generic Pi tool observations and xper execution
correlation. The
[direct activation revision](0004-pi-integration.md#direct-workflow-activation-revision-2026-09-27)
retires the earlier plugin-specific telemetry. Runtime observations remain
separate from the adapter-reported execution events stored by the core.

The Event Collector is passive. Observability errors are isolated and do not
change the workflow outcome. Persistence supports batching and idempotent
retries. A start without an end is incomplete evidence; the adapter owns any
execution recovery and reports its outcome. A collector must not create a
failure or advance a phase merely because its connection closed.

## Conceptual data model

| Table | Contents |
| --- | --- |
| `events` | Append-only source of all events |
| `runs` | Development session state and summary |
| `run_active_periods` | Active, paused, and human-wait intervals |
| `phase_visits` | Entries, exits, and revisits per phase |
| `assignments` | Logical work assigned to roles |
| `attempts` | Physical agent invocations |
| `agent_cycles` | Internal Pi executions and retries |
| `model_requests` | Provider, model, tokens, cost, and latency |
| `tool_executions` | Tool, duration, outcome, and normalized error |
| `gate_results` | Evaluations and acceptance or rejection reasons |
| `profile_snapshots` | Effective, immutable run configuration |
| `metric_snapshots` | Precomputed aggregates for queries and the GUI |

SQLite must use versioned migrations. Journal mode and write strategy will
be decided during implementation; the goal is concurrent GUI reads without
blocking capture.

## Configuration snapshots

Each attempt records the exact resolution:

```yaml
role: implementation.driver
model_preset: local-coder
provider: ollama
model: qwen-coder
thinking: medium
context: personal
strategy: balanced
```

Aliases can change later, but historical runs must remain explainable and
reproducible.

## Time and effort

There is no single valid duration:

| Metric | Definition |
| --- | --- |
| Wall-clock duration | Elapsed time between run start and end |
| Active duration | Wall-clock duration excluding pauses and human waits |
| Agent time | Sum of all agent durations |
| Critical-path duration | The chain of work that determines total time |
| Provider time | Time spent waiting for model responses |
| Tool time | Time consumed by tools and checks |
| Human wait time | Time blocked waiting for a decision |
| Coordination overhead | Routing, handoffs, gates, and integration |

With two agents working for ten minutes in parallel:

```text
Wall-clock duration = 10 minutes
Agent time          = 20 minutes
```

Both figures are correct and must not be conflated.

## Metrics

### Flow

- Time to the first accepted increment.
- Total time to acceptance.
- Time per phase and visit.
- Number of revisits.
- Critical-path duration.
- Time blocked waiting for the user.

### Agents

- Invocations per role.
- Attempts per assignment.
- First-attempt success rate.
- Mean duration and percentiles by role, preset, and model.
- Aborts, timeouts, and failures.
- Replacements, fallbacks, and model changes.
- Ratio of initial work to rework.

### Models

- Input, output, cache, and reasoning tokens when available.
- Cost per attempt, phase, increment, and run.
- Time to first token.
- Total provider latency.
- Tool calls per model.
- Acceptance rate by model and role.
- Cost per accepted increment.

### Quality

- Passed and failed gates.
- Acceptance criteria met.
- Regressions detected.
- Rework requested by Verify or Judgment Day.
- Final verdict.
- Required human interventions.

### Headline metrics

1. `time_to_accepted_increment`
2. `cost_per_accepted_increment`
3. `first_pass_acceptance_rate`
4. `rework_ratio`

Initial definitions:

```text
first_pass_acceptance_rate =
  assignments accepted on the first attempt
  / accepted assignments

attempt_rework_ratio =
  attempts after the first
  / total attempts

cost_per_accepted_increment =
  total attributable cost
  / accepted increments
```

Formulas are part of the versioned schema. Changing a definition creates a
new metric version rather than silently reinterpreting history.

## Future GUI

Planned views:

- Gantt-style timeline of phases, agents, models, and tools.
- Assignment, attempt, and acceptance funnel.
- Execution-profile comparison.
- Cost and duration by model and role.
- Rework heatmap across phases.
- First-pass acceptance rate over time.
- Distribution of failures, retries, and timeouts.
- The run's critical path.
- Controlled-experiment comparisons.

Example scorecard:

```text
                         Profile A   Profile B
Time to acceptance        42 min      29 min
Attempts                   8           5
First-pass success         50%         80%
Rework loops               3           1
Cost                       $1.90       $3.10
Judgment Day               ACCEPT      ACCEPT
```

## Comparisons and experiments

The GUI distinguishes:

- **Historical trend:** a project's actual evolution.
- **Comparable experiment:** the same snapshot, task, criteria, tools, and
  limits, with a different profile or model.
- **Non-equivalent runs:** executions that should not be compared directly.

In a controlled experiment, each candidate works in a workspace created from
the same snapshot. Context, input artifacts, tools, limits, and Judge are fixed.

Objective metrics—tests, gates, regressions, time, and cost—take precedence
over Judge's subjective score.

## Privacy and contexts

Stored by default:

- Provider and model identifiers.
- Role, phase, state, and outcome.
- Durations, tokens, and costs.
- Tool name.
- Normalized errors.
- Verdicts and artifact references.

Not stored by default:

- Full prompts or responses.
- Full code or diffs.
- Tool arguments and results.
- Shell output.
- File contents.
- Headers, tokens, or API keys.

Each context uses isolated storage. Comparison across `company`, `personal`,
or client contexts requires an explicit action. Content capture is opt-in and
must include redaction, retention, and deletion.

## Reliability

- Observability cannot stop or modify a run.
- Persistence failures produce a warning and a recoverable diagnostic.
- An attempt without a final event is incomplete; the adapter may explicitly
  report interruption after recovery. Rust does not infer a workflow outcome.
- Events are idempotent by `event_id`.
- The database includes a schema version and migrations.
- Versions of xper, Pi, the workflow, and the configuration snapshot are recorded.
- Agent processes send events to the central collector; they do not coordinate
  arbitrary writes directly to SQLite.

## Open decisions

- Final cross-platform database locations.
- A database per context, per project, or both through partitioning.
- Event-log retention and compaction policy.
- Recovery strategy when SQLite is unavailable.
- Stable taxonomy of errors and tool outcomes.
- Optional export to OpenTelemetry or other backends.
- Complexity metrics for comparing similar tasks without creating bad incentives.
