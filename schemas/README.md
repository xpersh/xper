# Protocol schemas

This directory is the public, versioned JSON Schema boundary shared by the
Rust protocol crate and external harness adapters. `protocol-v1.schema.json`
defines the JSON-RPC envelope and the initial method payloads. Every
message has `jsonrpc: "2.0"`, `protocolVersion: "1"`, and a string correlation
ID (null only when an error cannot be correlated). One JSON value is sent per
LF-terminated line, with at most 65,536 bytes before the LF.

The bridge responds to `initialize`, requests adapter `capabilities`, and then
accepts `capabilities`, `ping`, `session.attach`, `session.detach`,
`event.ingest` (error observations), `run.start`, `run.status`,
`assignment.start`, `attempt.finish`, `run.advance`, and `shutdown`.
Each Pi session keeps its own run. By default, `assignment.start` creates a
new `discovery.explorer` assignment and attempt;
its optional `assignmentId` retries an interrupted assignment.
`attempt.finish` records one of four terminal outcomes and may register a
Discovery Brief path. `run.advance` waits for all Discovery assignments to
finish and evaluates persisted evidence before
entering Define. Unknown methods receive
`-32601`; incompatible versions receive `-32001`. The stable code catalog is
in `crates/xper-protocol/src/lib.rs` and `adapters/pi/src/protocol.ts`.
