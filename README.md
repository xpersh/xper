# xper

`xper` is a multi-agent development harness based on Extreme Programming
practices. It integrates with Pi as the primary agent and adds a coordination
layer to govern the workflow, assign models by role, and retain local evidence
of quality, time, cost, and rework.

> Status: the first vertical slice is executable. Discovery can be delegated
> from Pi and advance to Define with persisted evidence; the rest of the
> workflow is still under development.

## Goal

Turn development intent into small, verifiable, integrable increments through:

- An XP workflow with explicit feedback and backward transitions.
- Multi-agent roles with defined responsibilities and permissions.
- Reproducible multimodel routing by context, role, and phase.
- Strict separation of personal, corporate, and client identities.
- Local observability to compare runs, models, and strategies.

The main unit of work is a **vertical increment of value** that can be defined,
implemented, verified, and accepted independently, rather than an entire project.

## Design documents

- [xper core architecture and use cases](docs/architecture.md)
- [Pi adapter architecture](adapters/pi/docs/architecture.md)
- [RFC 0001: Product and workflow](docs/rfcs/0001-product-and-workflow.md)
- [RFC 0002: Multimodel configuration and routing](docs/rfcs/0002-multimodel-configuration.md)
- [Execution profiles and model routing](docs/routing.md)
- [RFC 0003: Observability and metrics](docs/rfcs/0003-observability-and-metrics.md)
- [RFC 0004: Pi integration and primary agent](docs/rfcs/0004-pi-integration.md)
- [RFC 0005: Modular architecture and harness adapters](docs/rfcs/0005-modular-architecture.md)

## Implementation path

The technical backlog is organized as a sequence of small, verifiable tasks in
[docs/tasks/README.md](docs/tasks/README.md). The first goal is to validate a
complete vertical slice from Pi through the core to SQLite before implementing
the entire workflow.

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
- Observability must never prevent the workflow from continuing.
- Metrics measure system behavior, not human value or individual productivity.

## Relationship with Pi

Pi remains the runtime and interactive experience. In the first version,
`xper` takes the form of a Pi `primary` agent through
[`pi-open-agents`](https://pi.dev/packages/pi-open-agents), accompanied by its
own extension for workflow, commands, state, observability, and the durable
lifecycle of delegations. The
[XP-001 spike](docs/spikes/001-pi-integration.md) ruled out using the internal
`pi-open-agents` API as the attempt control plane.

Pi is the first adapter, not a domain dependency. The xper core is designed in
Rust and communicates through a versioned protocol with external adapters,
which can use the technology required by each harness. The Pi TypeScript
extension translates its API, hooks, and TUI into that contract without
introducing Pi types or concepts into the XP state machine.

Start Pi with `xper` as the primary agent:

```bash
pi --approve --agent xper
```

In this checkout, prepare the bridge and extension before the first launch:

```bash
npm ci
npm run build --workspace @xper/adapter-pi
cargo build -p xper-cli
pi install -l npm:pi-open-agents@0.1.22
pi --approve --agent xper
```

The `primary` definition lives in `.pi/agents/xper.md`; `.pi/settings.json`
pins `pi-open-agents@0.1.22` for this project. The extension in `.pi/extensions`
uses `target/debug/xper` when available and allows selecting another binary
with `XPER_BRIDGE_COMMAND`. It starts and stops the process with the Pi session.
`/xper start <objective>` starts or resumes a project run. The custom
`xper_delegate` tool runs `discovery.explorer` in a child Pi process and records
a Discovery Brief before requesting the transition to Define. `/xper status`
shows versions, connection, phase, and attempt outcomes; `xper status --json`
queries the projection and timeline from SQLite. A bridge crash leaves the Pi
session usable and is shown as `offline`. The
[XP-008 demo](docs/tasks/008-vertical-slice.md#manual-demo) details this flow.

To retain observations across sessions of prototype `0.0.1`:

```bash
mkdir -p .xper/observations
XPER_PI_OBSERVATIONS_FILE="$PWD/.xper/observations/pi.jsonl" pi --approve --agent xper
```

The Winston logger writes JSONL with size-based rotation: 5 MiB per file and
at most five files (the current file and four previous ones). It records
session start and end, bridge state, `/xper` invocations (without arguments),
`subagent` signals, and correlation between the custom tool and the Attempt;
it does not store tasks, prompts, or outputs.
Session counters remain available when no file is configured.
`reported done` only reflects what `pi-open-agents` reported: the
[spike](docs/spikes/001-pi-integration.md) demonstrated that early cancellation
can look like success. The decision to use it for work outside xper's control
and the criteria for revisiting that decision are in
[RFC 0004](docs/rfcs/0004-pi-integration.md).

You can also activate it within a session with `/agent xper`. The `xper` CLI
configures, validates, diagnoses, and exports information; it does not replace
interactive Pi execution with an `xper run` command.

`xper doctor` inspects Pi, `pi-open-agents`, the adapter, the primary agent,
conflicts, and configuration without modifying files or packages. `--json`
returns checks with stable IDs and exits with a nonzero code if any fail:

```bash
xper doctor
xper doctor --json
```

Installation checks accept Pi `0.85.1` through `0.87.1`, both inclusive,
using numeric version comparison. Only plain stable `major.minor.patch`
versions are accepted; prerelease and build suffixes are rejected.
`pi-open-agents` remains pinned to `0.1.22`. The same Pi version check applies
to `xper init` preflight.

`xper init` prepares the current project; `xper init --global` prepares the user
scope. It creates configuration and the `primary` definition only after
preflight passes. It requests confirmation to create or repair the agent;
scripts can authorize this with `--yes`. Repairs save the previous definition
as `xper.md.bak`. Valid existing files are preserved, and repeating `init` is
idempotent. If a dependency is missing, the command explains how to install it
and does not install packages automatically:

```bash
pi install npm:pi-open-agents
```

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
- [pi-open-agents](https://pi.dev/packages/pi-open-agents)

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

The layout matches RFC 0005, so no additional ADR is needed. Future crates
(`xper-workspaces`, `xper-observability`, and `xper-tui`) will be added when a
task needs real behavior in those layers.

`scripts/check-core-boundaries.mjs` validates crate architecture: the domain
cannot have dependencies or use I/O APIs, the application depends only on the
domain, and infrastructure and the CLI point inward. Each adapter maintains
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

The minimal adapter adds `session.attach`, `session.detach`, and `event.ingest`
for tool or compaction errors. The bridge validates the session and acknowledges
these messages; persistence and workflow decisions belong to later tasks.
