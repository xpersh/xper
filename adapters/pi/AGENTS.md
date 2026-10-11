# Working on the Pi adapter

Apply these instructions with the [root AGENTS.md](../../AGENTS.md).
Read the [Pi architecture](docs/architecture.md) and, for shared behavior, the
[shared instructions](../shared/AGENTS.md) and [architecture](../shared/docs/architecture.md).
These rules also cover the checkout's `.pi/` integration.

## Where changes belong

- `src/extension.ts` composes dependencies and registers the extension.
- `src/pi/` translates Pi commands, tools, hooks, dialogs, session lifecycle,
  observations, and presentation. `workflow.ts` preserves `PiWorkflow` as a facade
  supplying `adapterId: "pi"`; it does not own a second workflow implementation.
- `src/pi/configuration.ts` owns Pi preparation/presentation around the shared
  prepared-configuration cache. Pi owns obtaining its catalog and native models.
- `src/execution/` owns the child Pi process, credentials/model translation, and
  mapping shared `read`, `command`, and `modify` capabilities to native tools.
- `src/inspection/` exposes pure shared role descriptions and cached native Pi
  model search to the configuration screen. Follow [its contract](docs/inspection.md).
  Keep it independent of workflow execution, effect runners, and recording.
- Reusable rules, contracts, actions, evidence, Git/test runners, prompts,
  checkpoint/recovery, outbox, and protocol client belong in `adapters/shared`.
  Do not duplicate them here or move workflow decisions into Rust.

Use declared `@xper/adapter-shared` exports, including its `/workflow`, `/actions`,
`/execution`, `/bridge`, and `/configuration` entries. Do not import production
internals from shared's source or generated tree. Test-only synthetic builders
may be reused by tests, but are not a public consumer interface. Preserve Pi's
existing public exports and extension/inspection entry points.

Construct the local workflow before background bridge setup. No workflow
operation, including first start, status, recovery, or approval, may await Rust.
Prepare configuration separately and freeze the latest snapshot or visible Pi
defaults at run start. Keep catalog calls and remote inspection outside that
awaited path. Reconnection must not replace local state or interrupt execution.
Slow or rejecting recording cannot change the attempt's outcome or cause a retry.

Preserve `.xper/pi` journals and prepared cache and `.xper/artifacts` evidence.
New runs use the `xper.*` workflow family; shared preserves `pi.*` on recovery.
Do not rewrite historical identities or pending events in this facade.

Pi gathers explicit human input and displays decisions; shared validates and
applies them. Keep dialogs outside the workflow serialization queue. Cancellation
or missing UI must retain pending approval. The delegation tool cannot grant
human approval or implicitly authorize revised-Plan resumption.

## Verification

Run from the repository root:

```bash
npm run boundaries --workspace @xper/adapter-pi
npm run typecheck --workspace @xper/adapter-pi
npm run test --workspace @xper/adapter-pi
```

Build and typecheck prepare shared first. Tests cover Pi-specific integration with
simulated child execution, controlled effects, and isolated temporary resources;
no model credentials are required. Keep pure workflow and host-runner tests with
shared. Test missing, rejecting, and never-resolving recording at integration
boundaries without changing local outcomes. Preserve native tool restrictions,
legacy public imports, and extension/inspection loading from a clean build.

Keep behavior suites under `src/__tests__/*.test.ts`; shared test harnesses contain
synthetic data. The build removes stale generated suites. Pi's boundary checker
protects adapter integration and public imports; shared checks its own internal
architecture. Do not relax a rule merely to make an extraction pass.

Do not edit `dist/`. For manual integration checks follow the
[README](../../README.md#relationship-with-pi); a demo does not replace tests.
Run `npm run check` before delivering code changes.
