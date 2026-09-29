# Pi adapter architecture

The Pi extension owns the executable Knowledge and per-increment workflows. It
decides assignments, gates, feedback, approvals, and budgets; executes agents;
and validates artifacts and checkout evidence. Rust resolves configuration and
stores the facts Pi reports. [RFC 0006](../../../docs/rfcs/0006-configuration-recording-and-adapter-workflows.md)
explains this ownership boundary.
[RFC 0007](../../../docs/rfcs/0007-explicit-adapter-state-machines.md) explains
the explicit state machine and future composition and visualization boundaries.

Rust is never an execution prerequisite. The local workflow becomes available
before bridge startup, and every workflow operation completes independently of
configuration and recording RPCs. A missing, slow, or rejecting recorder
changes telemetry status, not whether Pi can work.

```mermaid
flowchart LR
    Commands[Pi commands and tools] --> Workflow[PiWorkflow]
    Commands --> Action[delegateKnowledge]
    Action --> Workflow
    Action --> Executor[Child Pi execution]
    Action --> Implementation[Implementation runner]
    Implementation --> Git[Git inspection and host-run tests]
    Action --> Writer[Artifact writer]
    Workflow --> Machines[Pure Knowledge and Implementation transitions]
    Machines --> Definition[Versioned definitions and edges]
    Machines --> Policy[Contracts, gates and budgets]
    Workflow --> Evidence[Local artifact evidence]
    Workflow --> Journal[Local checkpoint and outbox]
    Journal -. Background delivery .-> Client[Typed configuration and recording client]
    Session[Session background preparation] --> Client
    Session --> Prepared[Prepared configuration]
    Prepared --> Workflow
    Client --> Bridge[JSONL transport]
    Bridge --> Core[Rust configuration and recording]
```

## Code navigation map

| Responsibility | Module |
| --- | --- |
| Compose dependencies and register the extension | `src/extension.ts` |
| Commands, tools, session hooks, and presentation | `src/pi/` |
| Background configuration preparation and last available snapshot | `src/pi/configuration.ts` |
| Coordinate delegation with injected execution and writing dependencies | `src/actions/delegate-knowledge.ts` |
| Prepare evidence, time and IDs; invoke transitions; commit local state | `src/workflow/controller.ts` |
| Pure Knowledge start, assignment, completion, advancement, and recovery decisions | `src/workflow/knowledge-machine.ts` |
| Pure per-increment Implementation transition and result validation | `src/workflow/implementation.ts` |
| Versioned serializable topology and explicit transition edges | `src/workflow/definition.ts` |
| Runtime state, checkpoint validation, and migration | `src/workflow/state.ts` |
| Phase roles and execution budgets | `src/workflow/policy.ts` |
| Artifact contracts, cross-artifact gates, and plan validation | `src/workflow/contracts.ts` |
| Bounded evidence reads, path confinement, and digests | `src/workflow/evidence.ts` |
| Local checkpoint and pending recording events | `src/workflow/journal.ts` |
| Typed configuration, recording, and inspection operations | `src/bridge/xper-client.ts` |
| Transport, correlation, handshake, envelopes, and errors | `src/bridge/client.ts`, `protocol.ts` |
| Role prompts, child Pi execution, and output writing | `src/knowledge/` |
| Implementer handoff, Git inspection, host-run tests, and result construction | `src/implementation/` |

Actions receive their effects explicitly and remain testable without Pi,
processes, or files. Workflow rules live in the adapter's workflow modules,
not in the bridge client or Rust. The client validates the public boundary;
it does not hide workflow commands behind recording calls.

## Explicit state machine

`PiWorkflow` is the runtime boundary. It loads the local checkpoint, reads and
verifies artifact evidence, supplies IDs and time, and invokes the applicable
pure transition function. Each reducer owns its state changes and decisions and
returns the next state, result, and facts. Local persistence and agent execution
stay outside them; neither reducer nor its guards consult Rust.

The `pi.knowledge` definition at version 1 declares the five knowledge nodes
and a terminal ready node, with stable IDs and explicit edges. Execution reads
those edges; phase-array order is not a second transition rule. Domain guards
still validate budgets, approvals, and evidence before taking an edge. The JSON
definition describes possible paths, not an executable replacement for those
rules.

State carries a definition reference and workflow instance ID. New runs generate
a separate instance ID; migrated format-1 checkpoints retain the run ID as their
instance ID for historical stability. Its lifecycle is
`active`, `awaiting_approval` with the exact visit and artifact, or `completed`
with the sealed Plan artifact. Phase visits and per-attempt outcomes remain
separate. Compatibility fields such as `human_input` and `ready` are derived for
presentation, not independent mutable state.

Knowledge completion hands off the sealed Plan to a separate
`pi.implementation` definition at version 1. Each instance is keyed by increment
and transitions from `implement` to terminal `implemented` only after host-owned
Git and test checks pass. This composition does not expand the Knowledge phase
enum or imply product acceptance. No Verifier, later-increment scheduler, or run
closure is implemented here.
[XP-015](../../../docs/tasks/015-workflow-visualization.md) tracks a read-only UI
combining the versioned graph with reported positions and history, including
incomplete recording. Rust preserves those facts without running the machine.

## Reported topology and position

New observations include `definitionId`, `definitionVersion`, and `instanceId`
in their event data. The adapter emits the following facts in addition to the
existing phase, attempt, gate, and usage observations:

| Event | Meaning |
| --- | --- |
| `workflow.definition` | The serializable graph in `data.definition`, emitted on the first commit with new facts in a runtime; the same definition may be reported again after reload |
| `workflow.position` | Resulting `nodeId`, phase, visit, lifecycle status, and active attempt IDs after an operation that emits facts; a pending approval also names its artifact |
| `workflow.transition` | A traversed graph edge, with `transitionId`, `from`, `to`, `fromVisitId`, and `toVisitId` |
| `workflow.completed` | Completion of the named workflow instance with its output artifact ID and kind |

A position observation is not necessarily a graph transition: attempt settlement
or a blocked gate can leave the current node unchanged. Read-only status and
idempotent operations without new facts do not emit positions. Completion uses
node `ready` while retaining the final `plan` phase and visit; it does not create
a sixth phase visit. The compatibility `run.status` value `ready` likewise does
not claim final acceptance or run closure.

Local `getRunStatus()` exposes Knowledge in `workflow` and Implementation
positions in the increment-keyed `implementations` map, alongside the derived
compatibility run fields. Rust retains these observations as
opaque data; a future consumer resolves the exact definition reference and edge
IDs. Repeated definition reports are not new workflow versions. Existing history
may lack these facts, and a read-only inspection does not backfill them.

## Workflow activation and delegation

`/xper <objective>` and `/xper start <objective>` start or resume the session's
Pi workflow. Bare `/xper` requests the objective through Pi's interactive UI.
Starting displays the phase and next action without changing the system prompt
or automatically running a model.

`xper_delegate` asks the local workflow for its current assignment, executes
the selected role in a child Pi process, saves its output, and reports the
result locally. It continues to serve all Knowledge roles and, after Plan, the
first eligible `implementation.driver`; no second public delivery tool exists.
Pi validates the artifact and evaluates the owning gate after success.
`/xper advance` reevaluates the gate; `/xper approve <artifactId>` supplies an
explicit user decision for a pending human gate. The delegation tool never
grants human approval.

Discovery retains its Markdown Brief. Define through Plan use versioned JSON
artifacts. Feedback can revisit the responsible phase; accepted evidence is
invalidated from that phase onward. Plan validates an execution DAG and completes
the knowledge instance with sealed evidence for implementation. Before sealing
and again before starting delivery, one shared handoff validator rereads the
accepted Definition, Breakdown, and Plan, checks their digests and current role,
dependency, and routing contract, then selects the first root Implementer in
sealed Plan order. The
[knowledge workflow guide](../../../docs/knowledge-workflow.md) defines these
contracts and limits.

The Implementer runs with `read`, `bash`, `edit`, and `write` in the run's
existing dedicated checkout. It must create a local commit and return strict
JSON with commands and criterion evidence. The implementation runner treats
that response only as a proposal: it checks a clean tree, a distinct descendant
of the recorded base, obtains changed files from Git, reruns every command
serially under the shared deadline, stores bounded output logs, and checks the
tree and HEAD again. It creates the canonical `implementation_result`; it never
commits, pushes, resets, or cleans. Nonzero exits remain failed-attempt evidence.
Completion stops before Verifier and leaves the run open.

Success, failure, cancellation, timeout, and interruption remain distinct.
Output paths are published only after writing, and existing evidence is never
overwritten. A late success may become `timed_out` under Pi's execution policy.
Recording transport failure does not change that policy's result.

## Configuration and recording boundary

`XperClient` provides configuration resolution, profile inspection, event
append, and run-status queries. `BridgeClient` owns framing and handshake.
The recording connection requires the `eventRecording` and
`configurationResolution` capabilities; local workflow operation does not
depend on obtaining that connection. The previous core workflow mutation
methods are removed.

Session preparation obtains the model catalog and resolves configuration in
the background. The last available snapshot is cached locally in
`.xper/pi/configuration.json`; status distinguishes defaults, cached, and
resolved configuration and exposes preparation errors. Rust enforces configured provider allowlists and
model/thinking compatibility during resolution. A new run takes the latest
available prepared configuration or Pi defaults immediately, exposes degraded
preparation, and freezes the route and workflow policy in its checkpoint.
A response arriving later does not alter the active run. When a prepared route
is present, Pi selects the current role from it. The existing
`workflow.knowledge` settings pass through Rust; Pi validates budgets and human
gates. An unavailable prepared profile must not be presented as applied when
the run actually started with defaults.

Reconnecting replaces the recording connection without replacing the local
controller or marking a running attempt interrupted. Session changes and
shutdown stop local delivery; bridge shutdown proceeds in the background.

Pi uses its normal credentials and model configuration. Context allowlists do
not distinguish accounts exposed under the same provider identifier.
Initialization and installation diagnostics remain in the Rust CLI; the
extension does not duplicate `xper init` or `xper doctor`.

Events report decisions already made by Pi. Rust checks envelope integrity,
session ownership, and duplicate consistency. It accepts arbitrary phase names
and does not validate Pi's transitions, artifacts, approvals, or budgets.
Generic status and usage summaries are projections of these observations.
Workflow-specific metrics need explicit facts from the adapter.

Completed assistant messages also produce `model.usage` observations with the
actual response provider/model when available. Input and output counts remain
separate from `cacheReadTokens` and `cacheWriteTokens`; cached-token counts are
event metadata, not part of the current aggregate. Pi's computed cost is
labelled `costSource: "pi_estimate"`, so it cannot be confused with a verified
provider bill or a workflow budget reservation. Missing usage remains unknown.

## Checkpoints, pending events, and recovery

The journal stores a checkpoint and outbox atomically at
`.xper/pi/<sha256(sessionId)>.json`. Event IDs remain stable across retries.
Workflow operations update local state and schedule delivery; they never await
the delivery worker, a recorder query, or bridge startup. Pending events are
released only after a persistent core acknowledgement.
Volatile acknowledgements and transport errors retain pending records and
surface degraded recording. Permanent rejections are retained separately and
surfaced; they cannot hold up subsequent events or workflow operations.
A local write failure retains state in memory and
allows the workflow to continue, but survival after process exit is then
unverified.

Checkpoint envelope format 3 contains the unchanged Knowledge v2 state and an
increment-keyed map of Implementation v1 instances. Pi migrates valid Knowledge
format-1 and format-2 checkpoints in memory, preserving identities, evidence,
and pending events. Reading alone does not rewrite the checkpoint; the next
local commit with facts writes format 3. Unknown definitions or inconsistent
instance identities are rejected rather than guessed. This envelope change does
not change either workflow definition version.

A checkpoint is metadata-only adapter state. It excludes prompts and artifact
contents; those artifacts remain files. Small checkpoints use `adapter.state`.
Larger checkpoints use `adapter.state.chunk` events containing a checkpoint ID,
chunk index, total count, and content. Rust stores these as opaque events.
Only Pi assembles and validates the checkpoint schema.

The client paginates inspection reads and batches recording writes to respect
the bridge frame limit. Workflow recovery loads the local checkpoint, without
consulting Rust first. Recorded checkpoints remain available for inspection;
the controller does not automatically fetch them as a prerequisite for starting
or resuming. A missing local checkpoint does not trigger remote recovery on the
execution path. Pending events can be resent safely without duplicating the
event log or executing an agent again.

`/xper status` reads local workflow state and shows delivery/preparation health.
`xper status` queries the shared Rust record, which can lag while events are
pending or rejected. Neither the first local status request nor a delegation
waits for an unresolved recording RPC. An unreadable or invalid local checkpoint
is still an integrity error; the adapter preserves it rather than guessing how
to resume.

Pi marks unfinished attempts interrupted when recovering its own workflow;
this means their execution outcome is unknown. The core never manufactures
that outcome merely by reopening SQLite. Implementation recovery preserves the
checkout and requires the matching assignment ID before retry, reusing the
frozen model, Plan, inputs, Git base, and cumulative budgets. Recovery never
launches a child automatically.

Legacy core-owned runs lack a Pi checkpoint. They remain inspectable through
`xper status`, but do not resume as a local Pi workflow. A new local run does
not require a successful legacy-history query. This migration does not delete
or reinterpret the original logs.

## Extending the adapter

1. Add knowledge transition rules to the pure reducer and update its definition
   when topology changes; keep the controller responsible for local effects.
2. Keep file/process/Pi effects separate from actions that coordinate them.
3. Report explicit facts with stable IDs; do not infer outcomes from generic
   tool observations.
4. Add core operations only for configuration, recording, or inspection needs.
5. Update checkpoint compatibility and recovery tests when its schema changes.
6. Give a new flow its own definition and state, and compose instances through
   explicit evidence handoffs. Keep UI rendering outside execution decisions.

A future decision about more autonomous agents belongs here. It does not
require adding a phase state machine to Rust.

## Verification

From the repository root:

```bash
npm run boundaries --workspace @xper/adapter-pi
npm run typecheck --workspace @xper/adapter-pi
npm run test --workspace @xper/adapter-pi
```

[check-boundaries.mjs](../scripts/check-boundaries.mjs) checks access to the
core through the typed public protocol and keeps workflow rules inside the
adapter. It blocks direct recorder/configuration calls from workflow modules
outside the journal and forbids awaiting telemetry delivery in actions and
command/tool entry points. It also protects injected action dependencies and
keeps workflow modules independent of the bridge process. Pure definition,
state, and reducer modules cannot import concrete I/O or use ambient time,
randomness, timers, or process state. The controller cannot navigate by phase
array index. These are static
conventions, not a complete TypeScript analysis; unresolved-promise tests check
the execution guarantee dynamically.

Pure reducer tests supply fixed time, IDs, and evidence; definition tests check
stable references and declared paths. Migration tests preserve existing IDs and
pending recording while rejecting incompatible state. Workflow and action tests
use controlled dependencies and synthetic artifacts.
Recording integration uses the real Rust bridge and SQLite with simulated
execution, requiring the checkout and toolchain but no model credentials.
Tests must cover interrupted execution, local checkpoint integrity, delayed
configuration, and missing/rejecting/never-resolving recording without delaying
workflow operations or changing their outcomes. Run `npm run check`
before delivering code changes.
