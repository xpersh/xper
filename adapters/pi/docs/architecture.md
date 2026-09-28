# Pi adapter architecture

The Pi extension owns the executable knowledge workflow. It decides phases,
assignments, gates, feedback, approvals, and budgets; executes agents; and
validates their artifacts. Rust resolves configuration and stores the facts Pi
reports. [RFC 0006](../../../docs/rfcs/0006-configuration-recording-and-adapter-workflows.md)
explains this ownership boundary.

```mermaid
flowchart LR
    Commands[Pi commands and tools] --> Workflow[PiWorkflow]
    Commands --> Action[delegateKnowledge]
    Action --> Workflow
    Action --> Executor[Child Pi execution]
    Action --> Writer[Artifact writer]
    Workflow --> Policy[Contracts, gates and budgets]
    Workflow --> Journal[Local checkpoint and outbox]
    Workflow --> Client[Typed configuration and recording client]
    Client --> Bridge[JSONL transport]
    Bridge --> Core[Rust configuration and recording]
```

## Code navigation map

| Responsibility | Module |
| --- | --- |
| Compose dependencies and register the extension | `src/extension.ts` |
| Commands, tools, session hooks, and presentation | `src/pi/` |
| Coordinate delegation with injected execution and writing dependencies | `src/actions/delegate-knowledge.ts` |
| Own start, assignment, completion, advancement, and recovery decisions | `src/workflow/controller.ts` |
| Phase roles and execution budgets | `src/workflow/policy.ts` |
| Artifact contracts, cross-artifact gates, and plan validation | `src/workflow/contracts.ts` |
| Bounded evidence reads, path confinement, and digests | `src/workflow/evidence.ts` |
| Local checkpoint and pending recording events | `src/workflow/journal.ts` |
| Typed configuration, recording, and inspection operations | `src/bridge/xper-client.ts` |
| Transport, correlation, handshake, envelopes, and errors | `src/bridge/client.ts`, `protocol.ts` |
| Role prompts, child Pi execution, and output writing | `src/knowledge/` |

Actions receive their effects explicitly and remain testable without Pi,
processes, or files. Workflow rules live in the adapter's workflow modules,
not in the bridge client or Rust. The client validates the public boundary;
it does not hide workflow commands behind recording calls.

## Workflow activation and delegation

`/xper <objective>` and `/xper start <objective>` start or resume the session's
Pi workflow. Bare `/xper` requests the objective through Pi's interactive UI.
Starting displays the phase and next action without changing the system prompt
or automatically running a model.

`xper_delegate` asks the local workflow for its current assignment, executes
the selected role in a child Pi process, saves its output, and reports the
result locally. Pi validates the artifact and evaluates the gate after success.
`/xper advance` reevaluates the gate; `/xper approve <artifactId>` supplies an
explicit user decision for a pending human gate. The delegation tool never
grants human approval.

Discovery retains its Markdown Brief. Define through Plan use versioned JSON
artifacts. Feedback can revisit the responsible phase; accepted evidence is
invalidated from that phase onward. Plan validates an execution DAG and stops
ready for implementation. The [knowledge workflow guide](../../../docs/knowledge-workflow.md)
defines these contracts and limits.

Success, failure, cancellation, timeout, and interruption remain distinct.
Output paths are published only after writing, and existing evidence is never
overwritten. A late success may become `timed_out` under Pi's execution policy.
Recording transport failure does not change that policy's result.

## Configuration and recording boundary

`XperClient` provides configuration resolution, profile inspection, event
append, and run-status queries. `BridgeClient` owns framing and handshake.
The extension requires the `eventRecording` and `configurationResolution`
capabilities. The previous core workflow mutation methods are removed.

At run start, Pi obtains its model catalog and requests resolved configuration.
Rust enforces configured provider allowlists and model/thinking compatibility.
Pi freezes the route and workflow policy in its checkpoint and selects the
current role from that snapshot. The existing `workflow.knowledge` settings
are passed through by Rust; Pi validates budgets and human gates.

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
Pending events are released only after a persistent core acknowledgement.
Volatile acknowledgements and transport errors retain pending records and
surface degraded recording. A local write failure retains state in memory and
allows the workflow to continue, but survival after process exit is then
unverified.

A checkpoint is metadata-only adapter state. It excludes prompts and artifact
contents; those artifacts remain files. Small checkpoints use `adapter.state`.
Larger checkpoints use `adapter.state.chunk` events containing a checkpoint ID,
chunk index, total count, and content. Rust stores these as opaque events.
Only Pi assembles and validates the checkpoint schema.

The client paginates status reads and batches recording writes to respect the
bridge frame limit. Recovery chooses the latest valid Pi checkpoint revision
from the journal and recorded history. Pending events can be resent safely
without duplicating the event log or executing an agent again.

Pi marks unfinished attempts interrupted when recovering its own workflow;
this means their execution outcome is unknown. The core never manufactures
that outcome merely by reopening SQLite. An explicit retry of an interrupted
assignment reuses its frozen model selection and input identities.

Legacy core-owned runs lack a Pi checkpoint. They remain inspectable through
`xper status`, but do not resume in this workflow; start a new Pi session.
This migration does not delete or reinterpret their original logs.

## Extending the adapter

1. Add workflow rules to the module that owns their policy.
2. Keep file/process/Pi effects separate from actions that coordinate them.
3. Report explicit facts with stable IDs; do not infer outcomes from generic
   tool observations.
4. Add core operations only for configuration, recording, or inspection needs.
5. Update checkpoint compatibility and recovery tests when its schema changes.

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
adapter. It also protects injected action dependencies. These are static
conventions, not a complete TypeScript analysis.

Workflow and action tests use controlled dependencies and synthetic artifacts.
Recording integration uses the real Rust bridge and SQLite with simulated
execution, requiring the checkout and toolchain but no model credentials.
Tests must cover interrupted execution, checkpoint recovery, and recording
failure without changing the reported execution outcome. Run `npm run check`
before delivering code changes.
