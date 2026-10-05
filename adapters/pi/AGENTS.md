# Working on the Pi adapter

Apply these instructions together with the [root AGENTS.md](../../AGENTS.md).
First read the [adapter architecture](docs/architecture.md), including its
diagram. These rules also guide changes to the checkout's `.pi/` integration.

## Where changes belong

- `src/extension.ts` composes dependencies and registers the extension.
- `src/inspection/` exposes adapter-owned role descriptions and cached native Pi
  model search to the configuration screen. Follow [its contract](docs/inspection.md).
  Keep it independent of workflow execution, recording, and credential handling.
- `src/pi/` translates Pi commands, tools, and hooks, presents results, and
  manages the session and observations.
- `src/actions/` coordinates an integration action with injected dependencies.
  It does not import Pi APIs, processes, files, or concrete bridge
  implementations. Test the action with doubles before connecting its entry point.
- `src/workflow/` owns phases, assignments, attempts, gates, feedback,
  approvals, artifact contracts, dependency checks, and execution budgets.
  `knowledge/`, `implementation/`, `verification/`, and `judgment/` own their pure typed
  transitions, state, artifact contracts, checkpoint decoders, and definitions.
  `graph.ts` owns vocabulary-neutral topology operations. `checkpoint/` validates
  and migrates the composed envelope. `delivery/` owns pure coordination across
  flows: frontier, dependencies, cumulative budgets, feedback and Plan authorization.
  `runtime/` prepares evidence with explicit effect ports and constructs recorded
  events; it does not own state or repeat transition rules. `controller.ts` invokes
  those operations and commits results through one serialized checkpoint owner.
  New pure modules inherit the directory-based boundary rules; never add an I/O
  exception merely to make an extraction pass.
- `src/bridge/xper-client.ts` provides typed configuration, recording, and
  inspection operations and validates their responses. Keep public core RPC
  calls in this boundary; workflow decisions are local adapter operations.
- `src/bridge/client.ts` handles transport, correlation, and the handshake;
  `src/bridge/protocol.ts` handles contract envelopes and errors.
- `src/execution/` owns the child Pi process, role prompts, model selection,
  artifact writing, Git inspection and host-run commands. Keep Implementer and
  Verifier proposal parsing and runners separate: agent proposals, host evidence,
  and workflow decisions have different owners. `actions/execution.ts` defines
  the discriminated request; each delivery role requires its own handoff fields. Judge consumes frozen
  run-wide evidence through reading tools only; its report does not apply a verdict.

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

Keep behavior suites flat under `src/__tests__/*.test.ts`; shared harnesses contain
synthetic builders and doubles. The build removes stale generated suites before
compiling. Architecture tests check TypeScript import and re-export edges,
including type-only edges in cycle detection. Pure modules cannot import effects;
flows may reference another flow's contract types but not its state or decisions.
Runtime effects arrive through ports, and execution reports evidence without
importing workflow decisions. File size is a review signal, not a hard limit.

Do not edit `dist/`. For manual integration checks, follow the
[README](../../README.md#relationship-with-pi); a demo does not replace tests.
Before delivering code changes, also run `npm run check`.
