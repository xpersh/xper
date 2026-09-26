# Working on the Rust core

Apply these instructions together with the [root AGENTS.md](../AGENTS.md).
Before changing Rust code, read the [core architecture](../docs/architecture.md),
especially its module map and port guarantees.

## Where changes belong

- `xper-domain`: pure entities, invariants, and transitions. Do not add external
  dependencies, I/O, or harness-specific concepts.
- `xper-application/src/use_cases/`: one system operation per module, with
  `execute` and explicit inputs and results. Coordinate ports; do not accept
  JSON, terminal arguments, or concrete SQLite connections.
- `xper-application/src/ports.rs`: application needs and dependency guarantees.
  The clock and IDs are also injected.
- `events.rs`, `read_models/`, and `policies/`: durable facts, replay, and
  evidence policies, respectively. Keep these responsibilities separate from
  use-case coordination.
- `xper-store-sqlite` and `xper-config`: persistence and configuration
  implementations. Preserve atomic workflow boundaries and compatibility with
  persisted data; add migrations where needed.
- `xper-cli`: translate inputs and present results. Commands and the bridge
  invoke use cases; they do not construct events or persist transitions.
  `composition.rs` wires concrete implementations, and `infrastructure/`
  contains local port adapters.
- `xper-protocol`: a neutral transport contract. Keep changes aligned with
  [schemas and consumers](../schemas/README.md). Bridge `stdout` accepts only
  JSONL frames; diagnostics go to `stderr`.

To extend a vertical slice, express the domain rule, coordinate it in a use case,
test it with port doubles, and then connect the CLI or RPC method. Check which
pieces the operation actually needs before creating modules.

The current durable Discovery transition relies on projections and events; it
does not yet rehydrate the domain `Run` entity. Account for this limitation when
extending transitions and avoid duplicating their rules elsewhere.

## Verification

From the root, check the Rust area with:

```bash
npm run boundaries:core
cargo fmt --all -- --check
cargo clippy --workspace --all-targets --all-features -- -D warnings
cargo test --workspace --all-targets
```

During iteration, you can narrow tests with `cargo test -p <crate>`.
Application tests use port doubles and deterministic clocks/IDs; infrastructure
and interface tests verify transactions, recovery, and errors with temporary
resources. A bridge change must also preserve its consumers' tests. The final
aggregate check is `npm run check`.
