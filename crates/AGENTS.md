# Working on the Rust core

Apply these instructions together with the [root AGENTS.md](../AGENTS.md).
Before changing Rust code, read the [core architecture](../docs/architecture.md),
especially its module map and port guarantees.

## Where changes belong

- `xper-domain`: pure, generic recording primitives. Do not add external
  dependencies, I/O, phase lists, gate rules, or harness-specific concepts.
- `xper-application/src/use_cases/`: one system operation per module, with
  `execute` and explicit inputs and results. Coordinate ports; do not accept
  RPC envelopes, terminal arguments, or concrete SQLite connections. An event's
  JSON data is an opaque application value, not a workflow command.
- `xper-application/src/ports.rs`: application needs and dependency guarantees.
  The clock and IDs are also injected.
- `events.rs` and `read_models/`: reported facts and rebuildable generic
  projections. Accept extensible phase names and event kinds; do not validate
  a workflow's allowed transitions, artifacts, or budget admission.
- `xper-store-sqlite` and `xper-config`: persistence and configuration
  implementations. Preserve atomic recording batches and compatibility with
  persisted data; add migrations where needed.
- `xper-cli`: translate inputs and present results. Commands and the bridge
  invoke use cases; they do not invent workflow events or outcomes.
  `composition.rs` wires concrete implementations, and `infrastructure/`
  contains local port adapters.
- `xper-protocol`: a neutral transport contract. Keep changes aligned with
  [schemas and consumers](../schemas/README.md). Bridge `stdout` accepts only
  JSONL frames; diagnostics go to `stderr`.

Recording validates envelope version, identity, session ownership, and duplicate
consistency. Repeated identical events are safe; conflicting identities are
errors. Rebuilding a projection must not make execution decisions or fabricate
completion after a crash. Missing tokens, cost, or outcomes remain unknown.
An append acknowledgement is evidence of recording, never permission for an
adapter to continue. Recording and configuration APIs may fail independently;
their callers must not make Rust availability a prerequisite for local execution.

Configuration resolves model selections and passes adapter configuration
through. It does not select the next role or interpret the adapter's workflow
policy. Artifact provenance, gate checks, and execution budgets belong to the
adapter. See the [boundary decision](../docs/rfcs/0006-configuration-recording-and-adapter-workflows.md).

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
