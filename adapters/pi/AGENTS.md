# Working on the Pi adapter

Apply these instructions together with the [root AGENTS.md](../../AGENTS.md).
First read the [adapter architecture](docs/architecture.md), including its
diagram. These rules also guide changes to the checkout's `.pi/` integration.

## Where changes belong

- `src/extension.ts` composes dependencies and registers the extension.
- `src/pi/` translates Pi commands, tools, and hooks, presents results, and
  manages the session and observations.
- `src/actions/` coordinates an integration action with injected dependencies.
  It does not import Pi APIs, processes, files, or concrete bridge
  implementations. Test the action with doubles before connecting its entry point.
- `src/workflow/` owns phases, assignments, attempts, gates, feedback,
  approvals, artifact contracts, dependency checks, and execution budgets.
  `knowledge-machine.ts` owns pure transitions; `controller.ts` prepares local
  evidence and effects, invokes the reducer, and commits its result.
  `definition.ts` owns the serializable topology used by execution; `state.ts`
  owns checkpoint validation and migration.
- `src/bridge/xper-client.ts` provides typed configuration, recording, and
  inspection operations and validates their responses. Keep public core RPC
  calls in this boundary; workflow decisions are local adapter operations.
- `src/bridge/client.ts` handles transport, correlation, and the handshake;
  `src/bridge/protocol.ts` handles contract envelopes and errors.
- `src/knowledge/` implements Pi execution, role prompts, model selection, and
  artifact writing for Discovery through Plan. Keep these effects
  outside the action that coordinates them.

The adapter decides gates and transitions and reports the resulting facts to
the core. Do not import crate internals or delegate these decisions to Rust.
The core stores adapter checkpoints as opaque data; their schema, validation,
and recovery belong here. A generic Pi observation does not replace an
attempt's explicit result.

Preserve the distinction between success, failure, cancellation, and timeout.
Publish an artifact path only after saving it, and do not overwrite existing
evidence. Keep stable event IDs when retrying recording after transport failure;
never rerun an agent merely because its event acknowledgement was lost. A
recording failure must not turn successful execution into failed execution.
Report pending or volatile recording honestly and retain recoverable events.

No workflow operation may await Rust, including the first session/run, status,
or recovery. Construct local workflow state before background bridge setup.
Prepare configuration separately; a new run freezes the latest available
prepared snapshot or Pi defaults, with degraded preparation visible. A late
configuration response must not alter an active run. Restore from the local
checkpoint without first querying the recorder; preserve local integrity checks.

Deliver outbox events through a background worker. Slow calls, unavailable
recording, or rejected events must not hold the workflow's serialization queue.
Retain failed deliveries; isolate permanent rejections so other telemetry can
continue. Tests must exercise unresolved RPC promises as well as explicit
errors, proving operations complete before Rust responds.

## State machines and future flows

Follow [RFC 0007](../../docs/rfcs/0007-explicit-adapter-state-machines.md).
Keep transitions deterministic: supply identities, time, configuration, and
validated evidence explicitly. Do not read files, run agents, call Rust, or
mutate the input state from the transition function. The controller must not become a
second owner of transition rules.

Use declared graph edges for transitions; array order is not workflow policy.
Keep definition identity/version separate from checkpoint format and instance,
visit, assignment, and attempt identities. A new workflow has its own node
vocabulary and state; do not add its phases to the knowledge union. Completing
knowledge hands off the sealed Plan and does not close the overall run.

A future UI consumes versioned definitions and reported positions/history. It
never runs gates or drives execution; missing or delayed facts stay visibly
incomplete. Do not add UI, scheduler, or future workflow stubs to this slice.
When changing state or topology, update migration, reducer, and definition
consistency tests alongside the behavior.

## Verification

From the root:

```bash
npm run boundaries --workspace @xper/adapter-pi
npm run typecheck --workspace @xper/adapter-pi
npm run test --workspace @xper/adapter-pi
```

The test command builds the package. Action and client tests use doubles;
artifact tests use temporary directories. Integration tests require the checkout
and Rust toolchain, start the bridge, and simulate the Pi process without model
credentials. Preserve this separation when adding tests.

Do not edit `dist/`. For manual integration checks, follow the
[README](../../README.md#relationship-with-pi); a demo does not replace tests.
Before delivering code changes, also run `npm run check`.
