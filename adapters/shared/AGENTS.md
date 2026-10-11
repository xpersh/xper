# Working on shared adapter behavior

Apply these instructions with the [root AGENTS.md](../../AGENTS.md).
Read the [shared architecture](docs/architecture.md),
[RFC 0006](../../docs/rfcs/0006-configuration-recording-and-adapter-workflows.md),
and [RFC 0007](../../docs/rfcs/0007-explicit-adapter-state-machines.md).

## Ownership and package boundary

This private TypeScript workspace owns reusable workflow behavior, not a harness
integration. It may depend on the public Rust protocol contract, never Rust
internals, a concrete adapter, or a harness SDK. Keep adapter commands, dialogs,
sessions, catalogs, credentials, native tool mapping, and agent invocation in
their adapters. Pi is the first consumer; do not add OpenCode stubs.

Expose pure types, definitions, contracts, roles, and capabilities from the package
root. Effects and runtime APIs use the `/workflow`, `/actions`, `/execution`,
`/bridge`, and `/configuration` entries. Consumers must use these declared exports;
never make an internal source path a second interface. Keep root imports pure so
inspection can consume roles without loading execution or recording.

`XperWorkflow` receives explicit `adapterId` and dependencies. Use that identity
for metadata and local storage rather than hardcoding Pi. It is independent of
the `xper.*` or historical `pi.*` definition family. Roles describe `read`,
`command`, and `modify` capabilities; concrete tools belong to each adapter.
Accept cost provenance from the adapter without assuming a provider bill.

## Responsibility map

- `src/workflow/knowledge/`, `implementation/`, `verification/`, and `judgment/`
  own each flow's pure state, definitions, contracts, checkpoint decoder, and
  transitions. Each receives evidence, IDs, time, and configuration explicitly.
- `src/workflow/graph.ts` owns vocabulary-neutral topology. Use declared edges,
  not phase-array indices or another hidden sequence.
- `src/workflow/delivery/` owns pure cross-flow frontier, budgets, dependencies,
  feedback, Plan authorization, and run closure. Flow completion is not closure.
- `src/workflow/checkpoint/` validates and migrates the composed envelope. Preserve
  exact Plan, artifact, digest, revision, instance, and history references.
- `src/workflow/runtime/` prepares evidence and events through explicit effect
  ports. It must not repeat transition rules or receive the whole controller.
- `src/workflow/controller.ts` owns the serialization queue and one checkpoint
  commit path. It invokes rules and effects rather than implementing a second
  state machine.
- `src/actions/` coordinates injected workflow/execution/writing dependencies
  without concrete processes, files, or bridge implementations.
- `src/execution/` owns artifacts, Git inspection, host test commands, proposal
  parsing and canonical results. Host evidence is distinct from model claims;
  executors must not import workflow decisions.
- `src/bridge/` owns protocol validation, typed RPCs, handshake and transport.
  `src/configuration.ts` owns prepared snapshots and adapter-scoped cache.

Pure flow modules cannot read files or ambient process state, invoke agents,
consult time/randomness/timers, mutate input state, or call Rust. Cross-flow
runtime dependencies belong in delivery; flows may import other flows' contract
types, not their state or decisions. Do not introduce a generic engine, global
container, command bus, dependency cycle, or empty future-facing module.

## Execution and compatibility guarantees

Rust availability must never delay local workflow work, including first start,
status, approval, and recovery. Configuration preparation and telemetry delivery
run separately. Freeze the latest prepared configuration or visible defaults per
run; late resolution cannot mutate it. Recovery loads local state without first
querying Rust. Test unresolved promises as well as explicit recorder errors.

Retain stable IDs and pending observations until persistent acknowledgement.
Keep permanent rejections separate so later delivery continues. Recording errors
must not change execution outcomes or cause another agent invocation. Preserve
success, failure, cancellation, timeout, and interrupted outcomes separately.
Save artifacts before publishing paths and never overwrite immutable evidence.

New runs use `xper.knowledge@2`, `xper.implementation@1` (or `@2` for authorized
rework), `xper.verification@1`, and `xper.judgment@1`. Recovered `pi.*` runs keep
that family for all later instances. Resolve exact supported ID/version pairs;
reject unknown or mixed references. Build facts from each state's definition and
preserve pending historical facts unchanged. Keep envelope format 9 unless its
structure actually changes; historical migrations stay within `pi.*`.

## Verification

From the repository root:

```bash
npm run boundaries --workspace @xper/adapter-shared
npm run typecheck --workspace @xper/adapter-shared
npm run test --workspace @xper/adapter-shared
```

Keep pure tests deterministic and behavior suites under `src/__tests__/*.test.ts`.
Use synthetic artifacts and temporary workspaces, never local `.xper/` state or
model credentials. Cover both definition families, migrations, pending events,
feedback, rework, approvals, closure, and offline recovery. A non-Pi synthetic
consumer verifies adapter identity and storage isolation without a harness SDK.

Architecture checks belong to this package and protect pure/runtime/effect
separation and forbidden dependencies. Update the guide and tests for deliberate
boundary changes; do not add I/O exceptions to ease an extraction. Run relevant
consumer checks when public exports change, then `npm run check`. Generated
`dist/` is build output and must not be edited directly.
