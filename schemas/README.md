# Protocol schemas

This directory is the public, versioned JSON Schema boundary shared by the
Rust protocol crate and external harness adapters. `protocol-v1.schema.json`
defines the JSON-RPC envelope and the initial method payloads. Every
message has `jsonrpc: "2.0"`, `protocolVersion: "1"`, and a string correlation
ID (null only when an error cannot be correlated). One JSON value is sent per
LF-terminated line, with at most 65,536 bytes before the LF.

The bridge responds to `initialize`, requests adapter `capabilities`, and then
accepts `capabilities`, `ping`, `session.attach`, `session.detach`,
`event.ingest` (error observations), `profile.inspect`, `run.start`, `run.status`,
`assignment.start`, `attempt.finish`, `run.advance`, and `shutdown`.
Each Pi session keeps its own run. By default, `assignment.start` creates a
new assignment and attempt for the current knowledge phase;
its optional `assignmentId` retries an interrupted assignment.
`profile.inspect` returns the effective profile routing or null. For a configured
profile, `run.start` includes the adapter's available model catalog and the core
freezes the resolved routes in the run event. `assignment.start` returns a
neutral `selection` (or null for legacy runs). The adapter translates it to Pi
flags. A failed or timed-out attempt settles its assignment without an
automatic retry or model change.
`attempt.finish` records one of four terminal outcomes and may register a
phase artifact path. A late success is normalized to `timed_out`; consumers use
the returned outcome. `run.advance` waits for the current phase's assignments,
checks artifact contracts and SHA-256 digests, and advances, revisits an earlier
knowledge phase, requests human input, or marks Plan ready. Unknown methods receive
`-32601`; incompatible versions receive `-32001`. The stable code catalog is
in [`crates/xper-protocol/src/lib.rs`](../crates/xper-protocol/src/lib.rs) and
[`adapters/pi/src/bridge/protocol.ts`](../adapters/pi/src/bridge/protocol.ts).


## Knowledge contracts (XP-010)

Protocol version 1 and the existing error codes remain unchanged. New
`assignment.start` result fields are additive: `phase`, `artifactKind`,
`artifactPath`, `inputArtifacts`, `timeoutMs`, and `budget`. The schema keeps them
optional so old Discovery fixtures remain valid. The Pi client validates them
when present and preserves legacy Discovery responses.

`run.start.policy` optionally supplies the neutral knowledge policy; otherwise
the bridge uses merged `workflow.knowledge` configuration. The policy is frozen
with the run. `run.advance` accepts optional `approvedArtifactId` for a pending
human gate and returns optional `ready`, `resumed`, and `humanArtifactId` fields.
Automatic gate failures are successful RPC responses with `advanced: false` and
an actionable reason; malformed contracts and stale approvals retain the existing
invalid-params code. Repeating advancement in Define evaluates Define's gate;
repeating an accepted Plan returns its ready state. Older consumers must not
assume that every successful assignment has the Discovery role.

[knowledge-v1.schema.json](knowledge-v1.schema.json) describes the versioned JSON
files for Define through Plan. Discovery remains Markdown. See the
[workflow guide](../docs/knowledge-workflow.md) for semantic invariants beyond
JSON Schema, budgets, approval rules, and compatibility with persisted runs.
`npm run test:contracts` validates shared messages and artifact examples against
these schemas; Rust and TypeScript also consume the same fixtures.
