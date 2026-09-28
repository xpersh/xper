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
validation rejects Plans containing extra roles. This change does not add
delivery execution.

The stable error catalog remains in
[the Rust protocol crate](../crates/xper-protocol/src/lib.rs) and
[the TypeScript transport](../adapters/pi/src/bridge/protocol.ts).
