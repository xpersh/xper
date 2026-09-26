# XP-004: Protocol v1 and stdio bridge

- Status: `done`
- Milestone: M1
- Dependencies: XP-002 and XP-001 results

## Goal

Validate the cross-language boundary with a real handshake between a
TypeScript client and the Rust `xper bridge --stdio` process.

## Scope

- Define envelopes, correlation IDs, errors, and version negotiation.
- Define `initialize`, `capabilities`, `ping`, and `shutdown`.
- Implement JSONL framing and bidirectional JSON-RPC.
- Reserve stdout exclusively for the protocol and stderr for logs.
- Publish the messages' JSON Schema.
- Handle shutdown, timeout, invalid messages, and incompatible versions.

## Acceptance criteria

- TypeScript starts the bridge and completes a handshake.
- Both client and server can initiate requests.
- Contract tests use the same fixtures in Rust and TypeScript.
- An unknown or oversized message fails in a controlled way.
- Restarting the bridge requires no resident state to complete the handshake.

## Out of scope

- Full agent events.
- Local sockets, a global daemon, or network communication.

## Result

- `xper bridge --stdio` implements bidirectional JSON-RPC 2.0 over JSONL. The
  handshake exchanges `initialize` and `capabilities` requests in both
  directions; `ping` and `shutdown` are also available.
- The v1 envelope, error codes, 64 KiB limit, and method contracts are
  published in [JSON Schema](../../schemas/protocol-v1.schema.json).
- The TypeScript client starts the process, correlates responses, and handles
  timeout, shutdown, and invalid messages. `stdout` is reserved for frames;
  diagnostics go to `stderr`.
- Rust and TypeScript tests consume the same
  [fixtures](../../fixtures/protocol-v1.json). The process test covers the
  handshake, unknown requests, invalid or oversized frames, shutdown, and
  subsequent startup without resident state.
