# Public configuration and recording protocol

`protocol-v1.schema.json` defines the JSON-RPC envelope and method payloads.
Every frame has `jsonrpc: "2.0"`, `protocolVersion: "1"`, and a string correlation
ID (null only for uncorrelated errors). Frames are LF-terminated and limited to
65,536 bytes before the LF. `stdout` contains protocol frames only.

## Capabilities and compatibility

The handshake still uses `initialize` and bidirectional `capabilities` requests.
The bridge advertises `eventRecording: true` and `configurationResolution: true`.
Pi requires these capabilities before using the recording API. This is an
intentional application API break with unchanged transport framing and error
codes: `run.start`, `assignment.start`, `attempt.finish`, and `run.advance` have
been removed and return method-not-found (`-32601`). Rebuild the bridge and Pi
adapter together. Older bridges lack the capabilities and fail clearly.

Rust records reported facts and resolves configuration. Workflow commands,
artifact contracts, gates, retries, and transitions belong to the adapter. See
[the core architecture](../docs/architecture.md) and
[the Pi architecture](../adapters/pi/docs/architecture.md).

## Methods

| Method | Parameters | Result |
| --- | --- | --- |
| `session.attach` | `sessionId`, `cwd`, `mode` | `attached: true` |
| `session.detach` | Matching `sessionId` | `detached: true` |
| `profile.inspect` | `{}` | Resolved `routing`, or null |
| `configuration.resolve` | Optional `models` catalog | `routing`, `adapterConfig` |
| `event.append` | Nonempty `events` array for one run | Newly inserted `accepted` count, `durability` |
| `run.status` | Optional `runId`, `after` event ID, `limit` | `run`, `timeline`, `nextCursor`, `durability`, `degradedReason` |
| `event.ingest` | Existing session error observation | Legacy acknowledgement only; not durable recording |
| `ping`, `shutdown` | `{}` | `pong: true`, `ok: true` |

An active profile requires a catalog for `configuration.resolve`. Xper checks
provider/model availability and reasoning support without choosing what work
should run. It reloads merged configuration on each query; existing recorded
selections are immutable. `adapterConfig` passes through the existing
`workflow.knowledge` configuration, including values Rust does not understand.
Pi interprets and validates that value. Credentials remain outside this API.

## Events and durable acknowledgement

Each event is `{schemaVersion: 1, eventId, runId, occurredAt, type, data}`.
`occurredAt` is an integer Unix timestamp in milliseconds within JavaScript's
safe range. IDs and `type` are nonempty strings of at most 256 UTF-8 bytes; `data` is an object. Event
names, phase names, roles, and adapter metadata are extensible. The core checks
identity, session ownership, versions, and batch integrity, without enforcing a
workflow sequence or reading artifact files.

A batch is atomic. Exact replay of an event ID is idempotent, with zero newly
inserted events. Reusing an ID with different content, changing a run's session
owner, or appending to a legacy history is invalid (`-32602`). Storage failures
are internal errors (`-32603`). An acknowledgement with `durability: "volatile"`
does not justify deleting a durable adapter outbox. Adapter execution can
continue while recording is pending; the adapter exposes that degraded state.

A single event is limited to 40 KiB of serialized JSON. Pi chunks large opaque
checkpoints into adapter-owned events. `run.status` pages its timeline, with
`limit` from 1 through 1,000 (default 100) and a bounded response. Continue with
`after: nextCursor` until `nextCursor` is null, pinning `runId` from the first
page. Complete outgoing frames, including the cursor and correlation ID, stay
within the transport limit; an oversized configuration response returns
`-32003` instead of an invalid frame. An unknown explicit run returns null. The CLI can inspect complete local
history without the transport frame limit.

## Projections and metrics

The run projection contains `runId`, `sessionId`, `status`, `phase`, `startedAt`,
`lastEventAt`, and `metrics`. Generic observations are `run.started`,
`run.finished` (reported `status` or `outcome`), `run.status`, `phase.entered`,
`attempt.started`, `attempt.finished`, and `model.usage`. Attempt observations
carry `attemptId`; completion carries `outcome`. A `model.usage` observation may
carry `inputTokens`, `outputTokens`, and `costMicros`. Other events remain
available in the timeline. Rust ignores the meaning of `adapter.state` and its
chunked checkpoints.

Formula version 1 records event count, distinct started/finished attempts,
outcome counts (null beyond 64 distinct labels), usage-report count, and reported token/cost totals. Unknown
usage is null, not zero; a missing dimension in a usage report makes that total
unknown. Cost reservations are workflow policy, never observed model cost.
Projection labels over 256 UTF-8 bytes remain intact in the timeline but are
shown as unknown in summaries. Unbound legacy recordings have a null session ID.
These projections do not claim complete provider billing or implement all
future metrics in XP-013.

Legacy SQLite event tables are retained unchanged and exposed as `legacy.*`
observations with the original payload. They are inspectable without replaying
old workflow rules. Pi cannot resume an old run that lacks its own checkpoint;
start a new Pi session/run while retaining that history.

## Adapter artifact contracts

[knowledge-v1.schema.json](knowledge-v1.schema.json) documents Pi's versioned
Define-through-Plan artifacts; Discovery is Markdown. It is an adapter contract,
not a Rust protocol dependency. Pi validates its semantic rules. Shared schema
checks exercise the synthetic examples without requiring a model.

Plan requires one `implementation.driver` and one dependent `verify.verifier`
per increment. This is a semantic restriction within `knowledge-v1`; the artifact
structure and `schemaVersion: 1` are unchanged. Existing artifacts and recorded
history are not rewritten. Rust preserves them for inspection, while current Pi
validation rejects Plans containing extra roles.

[implementation-v1.schema.json](implementation-v1.schema.json) defines the
host-observed result of one Implementer assignment. It binds the assignment and
increment to the recorded Git base and resulting commit, changed repository
paths, at least one locally rerun command with its real exit code and confined
log reference, and evidence for every selected criterion. The child proposes
commands and criterion evidence; it cannot supply a trusted pass flag. This is
an adapter artifact contract and does not add a Rust protocol method. The additive
optional `revalidationOf` field identifies the applied Judge report authorizing
an unchanged revision. Its presence requires empty `changedFiles`; Pi additionally
requires equal commits, the matching frozen rework authorization, fresh host tests
and criterion evidence. Without it, the descendant-change contract is unchanged.
Older v1 artifacts remain valid; consumers supporting revalidation must understand
this additive variant.

[verification-v1.schema.json](verification-v1.schema.json) defines the
host-constructed review of one exact Implementation artifact and commit. It
records the accumulated base, actual host-run command exits and confined logs,
evidence for every criterion, and separate regression, requested-scope, and
simplicity findings. `rejected` requires a nonempty cause and evidence;
`verified` permits no failed finding, failed command, or rejection object. The
Verifier proposes findings and extra commands, while Pi constructs and validates
the canonical artifact. A rejection may add `knowledgeFeedback: null` or one
reason: `ambiguous_criteria` for Define or `infeasible_design` for Design. The
field is optional so historical v1 artifacts remain valid. Host-observed command
failure removes any proposed Knowledge classification and remains Implementation
rework.

The stable error catalog remains in
[the Rust protocol crate](../crates/xper-protocol/src/lib.rs) and
[the TypeScript transport](../adapters/pi/src/bridge/protocol.ts).

[judgment-v1.schema.json](judgment-v1.schema.json) defines the read-only Judge's
recommendation for a completely verified Plan. Host-owned evaluation metadata
binds artifact IDs/digests, log digests, covered criteria/increments and exact
base/evaluated commits. Every criterion and criticism cites supplied artifact IDs
or the exact `git:<base>..<evaluated>` diff reference; Pi checks reference membership
and criterion coverage beyond JSON Schema. All seven RFC 0001 verdicts are
recommendations only. Their presence does not mean acceptance, feedback or closure.
The checkpoint stores references and report metadata, not the artifact contents.
Rust continues to record opaque adapter facts without a new RPC or artifact parser.

Pi applies supported verdicts only through `/xper approve <reportId> <commit>`.
`judgment.applied` carries `reportId`, `planArtifactId`, `evaluatedCommit`, `verdict`
and covered `incrementIds`. ACCEPT also emits one `increment.accepted` per covered
increment with those identity references and its `incrementId`,
`implementationArtifactId` and `verificationArtifactId`. `run.finished` reports
`status: "accepted" | "rejected"`, the report/Plan/commit references, and
`summaryArtifactId`/`summaryPath`. The Markdown `run_summary` is registered as an
artifact; its content stays local. These are extensible event data under protocol
v1, not new RPCs or Rust workflow rules. Reapplying an identical decision emits
no new facts. Later checkout changes do not rewrite the historical closure.

REWORK_IMPLEMENTATION, REVISIT_DESIGN and REDEFINE emit `judgment.applied` with
`status: "reopened"`, target `phase`, exact report digest, covered increments and
application time. Delivery approvals are invalidated with the Judge as cause;
Knowledge feedback retains its existing transition events. These decisions do
not emit `increment.accepted` or `run.finished`. Existing verification-sourced
reconciliation events retain `verificationArtifactId`; Judge-sourced events use
`judgmentArtifactId` and covered `incrementIds`. Reports remain `judgment-v1`;
checkpoint format 8 is opaque adapter data. Rust needs no new parser or policy.
