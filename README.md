# xper

`xper` is a multi-agent development harness based on Extreme Programming
practices. Its Pi extension owns the workflow and agent execution. The Rust
service resolves configuration and model profiles, records reported events,
and makes the execution history available for inspection and metrics.

> Status: Discovery, Define, Design, Breakdown, and Plan are executable from
> Pi with artifact contracts, feedback, gates, and persisted evidence.
> Implementation, verification, and final judgment are still under development.
> Basic event and usage summaries are available; full metric comparison and a
> dashboard remain future work.

## Goal

Turn development intent into small, verifiable, integrable increments through:

- An XP workflow with explicit feedback and backward transitions.
- Multi-agent roles with defined responsibilities and permissions.
- Reproducible multimodel routing by context, role, and phase.
- Explicit configuration contexts and provider selection policies.
- Local observability to compare runs, models, and strategies.

The main unit of work is a **vertical increment of value** that can be defined,
implemented, verified, and accepted independently, rather than an entire project.

## Design documents

- [xper core architecture and use cases](docs/architecture.md)
- [Pi adapter architecture](adapters/pi/docs/architecture.md)
- [RFC 0006: Configuration, recording, and adapter-owned workflows](docs/rfcs/0006-configuration-recording-and-adapter-workflows.md)
- [RFC 0007: Explicit adapter state machines](docs/rfcs/0007-explicit-adapter-state-machines.md)
- [RFC 0001: Product and workflow](docs/rfcs/0001-product-and-workflow.md)
- [RFC 0002: Multimodel configuration and routing](docs/rfcs/0002-multimodel-configuration.md)
- [Knowledge workflow and phase contracts](docs/knowledge-workflow.md)
- [Execution profiles and model routing](docs/routing.md)
- [RFC 0003: Observability and metrics](docs/rfcs/0003-observability-and-metrics.md)
- [RFC 0004: Pi integration and workflow activation](docs/rfcs/0004-pi-integration.md)
- [RFC 0005: Modular architecture and harness adapters](docs/rfcs/0005-modular-architecture.md)

## Implementation path

The technical backlog is organized as a sequence of small, verifiable tasks in
[docs/tasks/README.md](docs/tasks/README.md). The implemented vertical slice
covers Pi's knowledge workflow through Plan, with configuration and recording
provided by the Rust service.

## Short definition

> xper is an observable, multi-agent, multimodel XP harness that coordinates
> software increments, routes each role to the appropriate model, and records
> local evidence to reproducibly measure time, cost, rework, quality, and
> performance.

## Principles

- Phases are knowledge gates, not silos or a waterfall.
- The coordinator governs the process; it does not act as a lead developer.
- Agents communicate through artifacts and structured contracts.
- Verify runs continuously alongside Implementation.
- A failure returns to its originating phase, not always to Implementation.
- Model routing is deterministic and auditable by default.
- Context policy prevents selection of a provider outside its allowlist;
  Pi controls credential selection for each provider.
- Rust availability and telemetry delivery must never delay or prevent Pi's
  workflow from continuing.
- Metrics measure system behavior, not human value or individual productivity.

## Relationship with Pi

Pi provides the runtime, interactive session, models, credentials, and tools.
The xper extension owns its commands, workflow integration, observations, and
knowledge-phase execution. It does not require an external agent-manager package.

Pi is the first adapter, not a Rust dependency. Through a versioned protocol it
requests resolved configuration and reports events to the Rust service. Pi
owns phases, gates, retries, approvals, artifact validation, and budgets. Rust
checks recording integrity and serves the history; it does not decide which
step may run next. A future adapter can use a different workflow with the
same configuration and recording service.

Pi expresses the knowledge workflow as a pure typed state machine, with a
versioned graph shared by execution and future inspection. Its runtime performs
artifact and process effects outside the transition function. The knowledge
instance completes with a sealed Plan; future Implementation and Verification
flows will compose per increment under the same run. Their execution and a
read-only graph UI remain backlog work.

Pi creates its local workflow immediately. Bridge connection, configuration
preparation, and event delivery run in the background. Starting, delegating,
advancing, approving, inspecting local status, and resuming a local checkpoint
do not wait for Rust, even when it is missing, slow, or rejects an event.
New runs use the latest prepared configuration or Pi's defaults and display
degraded preparation when needed; that choice stays frozen for the run.

In this checkout, build the extension and the optional Rust recording service:

```bash
npm ci
npm run build --workspace @xper/adapter-pi
cargo build -p xper-cli
pi
```

The Rust binary enables central recording and configuration preparation. Pi's
local workflow remains usable when that binary is unavailable.

Start a workflow in the Pi session:

```text
/xper Explore the current state of this project
```

Bare `/xper` asks for the objective in an interactive session. The explicit
`/xper start <objective>` form also works. `/xper status` shows versions,
connection, phase, and attempt outcomes; `/xper advance` asks the Pi workflow to
evaluate the current gate. Starting a run displays its phase and next action;
it does not automatically call a model or execute every phase. No `/agent xper`
activation is needed.

The extension in `.pi/extensions` uses `target/debug/xper` when available and
allows selecting another binary with `XPER_BRIDGE_COMMAND`. It starts and
stops the bridge with the Pi session. Starting a workflow creates or resumes
the run associated with that session. The custom `xper_delegate` tool executes
the current knowledge role in a child Pi process,
saves its artifact, and evaluates the gate in the adapter. Discovery keeps its
Markdown Brief; later phases use structured JSON contracts. Feedback returns to
the responsible phase, configured human gates use `/xper approve <artifactId>`,
and Plan completes the knowledge instance with a validated execution DAG. This
does not close the run or execute the planned delivery work. The
[knowledge workflow guide](docs/knowledge-workflow.md) covers contracts and
budgets. `xper status --json` queries the projection
and timeline from SQLite. This shared history can lag the live Pi workflow.
The adapter records a local checkpoint, queues events for background delivery,
and shows pending or rejected telemetry without changing execution outcomes.
Only a persistent acknowledgement confirms durable shared history. Old
core-owned runs remain inspectable, but lack the Pi checkpoint needed to
resume under this architecture. See the
[boundary decision](docs/rfcs/0006-configuration-recording-and-adapter-workflows.md).

To retain local observations across sessions:

```bash
mkdir -p .xper/observations
XPER_PI_OBSERVATIONS_FILE="$PWD/.xper/observations/pi.jsonl" pi
```

The Winston logger writes JSONL with size-based rotation: 5 MiB per file and
at most five files (the current file and four previous ones). It records
session start and end, bridge state, `/xper` invocations without arguments,
generic tool lifecycle, and correlation between `xper_delegate` and the
Attempt. It does not store tasks, prompts, or outputs. Tool counters are
observations; workflow outcomes come from the Pi workflow's explicit execution
and persisted evidence.
These generic tool observations are separate from the workflow and model-usage
events delivered to Rust; enabling this logger does not persist every Pi tool
event in the central recording database.

The `xper` CLI configures, diagnoses, and queries recorded information;
interactive workflow execution stays inside Pi.

`xper doctor` inspects Pi, Pi settings, the adapter, and configuration without
modifying files or packages. `--json` returns checks with stable IDs and exits
with a nonzero code if any fail:

```bash
xper doctor
xper doctor --json
```

Installation checks accept Pi `0.85.1` through `0.87.1`, both inclusive,
using numeric version comparison. Only plain stable `major.minor.patch`
versions are accepted; prerelease and build suffixes are rejected. The same
Pi version check applies to `xper init` preflight.

`xper init` prepares configuration in the current project; `xper init --global`
prepares the user scope. It writes only after preflight passes, preserves valid
existing configuration, and is idempotent. It does not install agent packages,
create a primary-agent definition, or change user-managed Pi packages and
settings. If Pi or the adapter is missing, diagnostics explain how to prepare
it.

Configuration is merged by key in this order: defaults, global
(`${XDG_CONFIG_HOME:-~/.config}/xper/config.yaml`), project
(`.xper/config.yaml`), and local (`.xper/config.local.yaml`). Arrays and scalars
from higher-precedence scopes replace lower values. Local configuration is
added to `.gitignore` during `init`. Credential keys are rejected; use Pi's
store or environment variables. The reader supports indented YAML maps and
lists, scalars, and JSON; it rejects advanced YAML features such as anchors
and tags.

References:

- [Pi](https://pi.dev/)
- [Pi SDK](https://pi.dev/docs/latest/sdk)
- [Extensions and events](https://pi.dev/docs/latest/extensions)
- [Custom models](https://pi.dev/docs/latest/models)

## Development

The repository requires Rust `1.97.0`, Node.js `24`, and npm `11`. The Rust
toolchain is pinned in `rust-toolchain.toml`, and JavaScript dependencies are
locked in `package-lock.json`.

A clean installation runs all checks as follows:

```bash
npm ci
npm run check
```

The gates can also run separately:

```bash
npm run format:check  # rustfmt + Biome
npm run lint          # Clippy + Biome + dependency boundaries
npm run typecheck     # strict TypeScript
npm test              # Rust + TypeScript tests
```

`npm run format` formats Rust and TypeScript/JavaScript/JSON. The same set of
gates runs in CI.

### Development with agents

Start with [AGENTS.md](AGENTS.md): it explains what to read before editing,
how to choose a module, and what to verify before delivery. Area-specific
rules live alongside their code: [Rust core](crates/AGENTS.md) and
[Pi adapter](adapters/pi/AGENTS.md). If the harness does not load instructions
from subdirectories, read the relevant area's instructions explicitly.

The architecture guides explain the decisions; `AGENTS.md` files turn them
into working instructions, and boundary checks detect some violations in CI.
These are static checks, so each change still needs a responsibility review.
The [PR template](.github/pull_request_template.md) asks for that justification
and validation evidence.

The `.pi/` configuration runs the product and serves a different purpose from
these instructions for developing xper.

## Initial layout

XP-002 creates only the modules needed for M1:

```text
crates/
├── xper-domain/         # pure domain
├── xper-application/    # use cases and ports
├── xper-protocol/       # neutral public contract
├── xper-config/         # configuration infrastructure
├── xper-store-sqlite/   # persistence infrastructure
└── xper-cli/            # xper binary
adapters/
└── pi/                  # adapter TypeScript package
schemas/                 # public JSON Schema boundary
fixtures/                # neutral messages for contract tests
```

The layout retains the ports and adapters structure; RFC 0006 defines the
current responsibilities. Add another crate only when concrete behavior needs
a separate module boundary.

`scripts/check-core-boundaries.mjs` validates crate architecture: the domain
cannot have dependencies or use I/O APIs, application dependencies point
inward, and infrastructure implements the core ports. Each adapter maintains
its own checks: Pi's live in `adapters/pi/scripts/check-boundaries.mjs` and
protect both its internal structure and access to the core exclusively through
the public protocol.

`npm run boundaries` runs checks for the core and all registered workspaces.
They can run separately with `npm run boundaries:core` and
`npm run boundaries --workspace @xper/adapter-pi`.

Each adapter maintains its architecture guide in its own package. Adapters
registered as workspaces also define a `boundaries` script: the aggregate
command runs it automatically and fails if it is missing. This lets their
documentation and rules evolve without changing those of the core or other
adapters.

## Bridge v1

Start the bridge with `xper bridge --stdio` (or
`cargo run -p xper-cli -- bridge --stdio` during development). It uses one
JSON-RPC 2.0 frame per line, up to 64 KiB per message. `stdout` carries only
frames; diagnostics go to `stderr`. The public contract is in
[schemas/protocol-v1.schema.json](schemas/protocol-v1.schema.json), with shared
test messages in [fixtures/protocol-v1.json](fixtures/protocol-v1.json).

The TypeScript client exports `connectBridge` from `@xper/adapter-pi`. It sends
`initialize` with the adapter name, version, and capabilities; the bridge asks
the client for `capabilities`, and the client queries the bridge's capabilities.
After the handshake, both peers can initiate requests. `ping` checks the
connection, and `shutdown` responds before terminating the process. Each new
process negotiates from scratch, with no resident protocol state.

`session.attach` and `session.detach` bind the recording conversation to the
adapter session. The `eventRecording` and `configurationResolution`
capabilities identify the new service boundary. `configuration.resolve` returns
routing and opaque adapter configuration; `event.append` records events with
stable IDs; `run.status` returns a paginated timeline and generic projection.
The old workflow mutation methods are removed and return method-not-found.
`event.ingest` remains a compatibility acknowledgement for generic Pi errors;
it is not the durable recording API. See the [public protocol](schemas/README.md).
