# RFC 0005: Modular architecture and harness adapters

- Status: accepted as the architectural direction
- Date: 2026-09-22
- Depends on: [RFC 0001](0001-product-and-workflow.md), [RFC 0002](0002-multimodel-configuration.md), [RFC 0003](0003-observability-and-metrics.md), and [RFC 0004](0004-pi-integration.md)

## Summary

xper must retain a CLI and domain independent of the harness that executes
agents. Pi will be the first integration, but OpenCode, Claude Code, Codex,
and other runtimes can be added through adapters without reimplementing the
XP workflow, profiles, gates, artifacts, or metrics.

The architecture will follow ports and adapters. The core will be implemented
in Rust and will not import any harness SDKs or types. Each integration will
live outside the core, may use the technology required by its host, and will
communicate with xper through a local, versioned, neutral protocol.

## Goals

- Keep the CLI usable without Pi or another harness installed.
- Keep Pi-specific names, types, and lifecycle out of the domain.
- Allow adapters written in TypeScript, Rust, or other languages.
- Share workflow, configuration, persistence, and metrics across harnesses.
- Negotiate capabilities instead of assuming every runtime offers the same
  features.
- Test the core without starting models or external interfaces.
- Version the core, protocol, and adapters independently.

## Initial non-goals

- Provide complete feature parity across harnesses from the first version.
- Create a universal abstraction of every function of any agent.
- Hide the selected harness's actual limitations from the user.
- Run remote adapters or distribute the core as a network service.
- Maintain several specific protocols for the same domain concept.

## Architecture

```text
                         +----------------------+
                         |      xper CLI        |
                         | init/doctor/config   |
                         | metrics/inspect      |
                         +----------+-----------+
                                    |
                                    v
+------------------+      +----------------------+      +------------------+
| Pi adapter       |<---->| Adapter protocol     |<---->| xper core        |
| TypeScript       |      | JSON-RPC / JSONL     |      | Rust             |
+------------------+      +----------------------+      +------------------+
| Pi API and hooks |                                    | XP domain        |
| Pi RPC executor  |                                    | application      |
| commands and TUI |                                    | configuration    |
+------------------+                                    | observability    |
                                                        +--------+---------+
+------------------+                                             |
| Future adapter   |                                             v
| OpenCode         |                                    +------------------+
+------------------+                                    | SQLite / files   |
                                                        +------------------+
+------------------+
| Future adapter   |
| Claude Code      |
+------------------+

+------------------+
| Future adapter   |
| Codex            |
+------------------+
```

The core decides what should happen according to the workflow. The adapter
decides how to express that intent in the specific harness.

## Core layers

The [core architecture guide](../architecture.md) makes these boundaries
concrete with a module map, the first vertical slice's use cases, and rules
for extending them.

### Domain

Contains only deterministic concepts and rules:

- Run, phase visit, increment, assignment, and attempt.
- State machine and transitions.
- Gates, policies, budgets, and verdicts.
- Contexts, strategies, model presets, and execution profiles.
- Domain events and artifact contracts.

It performs no I/O, knows nothing about SQLite, and contains no references to
Pi, OpenCode, Claude Code, Codex, npm, TUI, or processes.

### Application

Implements use cases over the domain:

- Start, suspend, resume, and close a run.
- Request and validate a transition.
- Create assignments and attempts.
- Resolve models and fallbacks.
- Ingest normalized harness events.
- Evaluate gates and produce commands for the adapter.

It depends on abstract ports for persistence, clock, identifiers, workspaces,
and agent execution.

### Infrastructure

Implements ports that do not belong to a harness:

- SQLite and migrations.
- Configuration files and scope precedence.
- Artifact repository.
- Monotonic clock and identifiers.
- Worktrees and workspace isolation.
- Metrics export.

### xper interfaces

- Noninteractive CLI and administration commands.
- A standalone Ratatui-based TUI when it adds value outside the harness.
- A bridge process that maintains a protocol conversation with an adapter.

## Harness adapters

An adapter is an anti-corruption layer. It translates the host's native model
into xper's vocabulary and applies core commands in the host.

Common responsibilities:

- Identify the session and attach it to a run.
- Declare capabilities and versions during the handshake.
- Activate or represent the primary agent when the host allows it.
- Inject ephemeral phase context.
- Create, track, cancel, and continue agents.
- Select models and reasoning levels.
- Apply supported tools, permissions, and limits.
- Forward turn, tool, error, and usage events.
- Show status, warnings, and requests for human input in the native UI.

The adapter does not evaluate gates or decide transitions. If the host requires
local logic to block a call, it applies a decision previously obtained from
the core and records the result.

## Capability negotiation

Harnesses do not offer the same primitives. On connection, each adapter sends
a manifest such as:

```json
{
  "adapter": "pi",
  "adapterVersion": "0.1.0",
  "protocolVersion": "1",
  "capabilities": {
    "primaryAgent": false,
    "subagents": true,
    "parallelSubagents": false,
    "modelSelection": true,
    "thinkingLevel": true,
    "toolFiltering": true,
    "permissionRules": true,
    "lifecycleEvents": true,
    "usageEvents": true,
    "nativeUi": true,
    "humanApproval": true
  }
}
```

This is an illustrative capability catalog. The current Pi adapter advertises
`primaryAgent: false`: `/xper` activates workflow state without selecting a
primary agent or replacing the system prompt. See the adapter guide for its
implemented capabilities.

The core validates these capabilities against the active workflow and profile:

- A missing required capability produces `FAIL` before the run.
- A missing optional capability produces `WARN` and explicit degradation.
- No limitation is hidden behind silently approximate behavior.

`xper doctor` uses the same manifest to explain what each adapter can execute.

## Adapter protocol

The boundary between core and adapter will be language-independent. The first
proposed option is bidirectional JSON-RPC over `stdio`, with JSONL messages
for streaming, diagnostics, and testing. The final transport selection will
be validated with a prototype before version 1 is frozen.

The protocol must cover at least:

```text
initialize / capabilities
session.attach / session.detach
run.start / run.resume / run.status
context.get
transition.request
assignment.create
attempt.start / attempt.cancel / attempt.result
event.ingest
profile.resolve
ui.notify / approval.request
shutdown
```

Communication is peer-to-peer: the adapter sends events and requests to the
core, and the core sends commands to the adapter. Messages include
`protocolVersion`, correlation, run, assignment, and attempt where applicable.

### Compatibility

- The protocol uses explicit versions.
- New fields are optional whenever possible.
- Incompatibility is detected during the handshake.
- Errors use stable codes and structured data.
- Types are published as JSON Schema to generate or validate clients in
  multiple languages.
- Each harness's native extensions can evolve without changing the domain.

## Initial process topology

For Pi, the initial proposal is:

```text
Pi
└── xper TypeScript extension
    └── starts `xper bridge --stdio`
        └── Rust core + SQLite
```

The extension keeps the child process alive for the session's lifetime. If Pi
or the extension restarts, a new bridge reconstructs state from SQLite and
artifacts. This topology avoids FFI, native Node addons, and a global daemon
in the first prototype.

If several harnesses later need to coordinate the same run simultaneously,
an `xper serve` mode with a local socket can be added. That mode is outside
the initial scope.

## Proposed repository structure

```text
xper/
├── Cargo.toml
├── crates/
│   ├── xper-domain/          # entities, states, gates, and events
│   ├── xper-application/     # use cases and ports
│   ├── xper-protocol/        # envelopes, RPC, and schemas
│   ├── xper-config/          # scopes, profiles, and validation
│   ├── xper-store-sqlite/    # persistence and migrations
│   ├── xper-workspaces/      # worktrees and isolation
│   ├── xper-observability/   # collector, projections, and metrics
│   ├── xper-cli/             # xper binary
│   └── xper-tui/             # standalone Ratatui views
├── adapters/
│   ├── pi/                   # TypeScript package/extension
│   ├── opencode/             # future
│   ├── claude-code/          # future
│   └── codex/                # future
├── schemas/                  # versioned protocol JSON Schema
├── fixtures/                 # neutral traces for contract tests
└── docs/
    └── rfcs/
```

Future adapter directories indicate reserved boundaries, not modules to create
empty in the first commit.

## Dependency rules

```text
domain <- application <- infrastructure/interfaces
                    ^
                    |
             protocol/adapters
```

Required rules:

1. `xper-domain` does not depend on other xper crates or I/O libraries.
2. `xper-application` depends on the domain and defines ports; it does not
   import implementations.
3. Infrastructure, CLI, TUI, and bridge dependencies point inward.
4. Adapters depend on the public protocol, never on core internals.
5. No core crate imports Pi, OpenCode, Claude Code, or Codex packages.
6. Native IDs are stored as namespaced metadata, not domain keys.
7. Persisted events use xper vocabulary; native payloads are optional and do
   not participate in primary projections.
8. Every harness-specific feature is protected by a capability.

These rules will be checked in CI through dependency structure and contract tests.

## Neutral configuration

Shared configuration contains no Pi-specific structures:

```yaml
harness:
  adapter: pi

profile: work

workflow:
  implementation:
    max_attempts: 3
  judgment_day:
    independent_model: true
```

Native options, when needed, belong under an explicit adapter namespace.
The current Pi integration starts workflows through `/xper` and has no
required external agent-manager package or primary-agent configuration.
[RFC 0004's direct activation revision](0004-pi-integration.md#direct-workflow-activation-revision-2026-09-27)
supersedes the original `require_pi_open_agents` proposal.

A profile can declare capability requirements, but not harness SDK commands
or types.

## Persistence and observability

The SQLite schema remains neutral. It can record:

- `adapter_kind` and `adapter_version`.
- External session or agent identifiers as metadata.
- The run's effective capabilities.
- Normalized events and, optionally, references to native traces.

There will be no tables such as `pi_sessions` in the main model. If an adapter
needs its own data, it uses namespaced metadata or a schema extension that is
not required to reconstruct the run.

This allows comparing the same workflow across harnesses, subject to the
cautions defined in RFC 0003.

## Testing

The test strategy is divided into:

- **Domain:** pure tests of states, gates, policies, and routing.
- **Application:** fake ports and a deterministic clock.
- **Protocol:** schemas, compatibility, and golden messages.
- **Contract tests:** a shared suite that every adapter must pass.
- **Adapter tests:** harness-specific lifecycle and errors.
- **End-to-end:** a small number of real sessions for each supported combination.

Protocol fixtures contain no prompts, credentials, or user code.

## Initial technology stack

| Area | Technology | Rationale |
| --- | --- | --- |
| Core and CLI | Rust | Cross-platform binary, strong types, and resource control |
| CLI | `clap` or equivalent | Declarative, testable interface |
| Async/process | `tokio` or equivalent | Bridge, streaming, and agent processes |
| Serialization | `serde` | JSON contracts and configuration |
| Configuration | YAML deserialized into xper types | Readability and centralized validation |
| Persistence | SQLite | Local, portable, and suitable for metrics queries |
| Standalone TUI | Ratatui | Inspection and metrics outside the harness |
| Pi adapter | TypeScript | Required by Pi's extension API |
| Cross-language contract | JSON-RPC/JSONL + JSON Schema | Portability and contract tests |

Specific libraries other than Rust, TypeScript, SQLite, and Ratatui remain
implementation choices. They will be validated with spikes before being
committed to as long-term dependencies.

## Security

- The adapter does not send credentials to the core unless a future contract
  explicitly requires it; references and capabilities are preferred.
- The local protocol validates each message's size, version, and shape.
- The core treats harness events and metadata as untrusted input.
- Destructive commands remain subject to policies and approvals.
- Each adapter documents its actual permission and isolation boundary.
- `doctor` reports both functional capabilities and security degradation.

## Consequences

### Benefits

- The CLI and workflow survive changes in Pi.
- Adding a harness does not duplicate domain, metrics, or configuration.
- Each integration uses its ecosystem's natural technology.
- Adapters can be published and versioned separately.
- Core tests are fast and do not depend on AI providers.

### Costs

- An additional protocol and cross-version compatibility must be maintained.
- Pi integration requires TypeScript as well as Rust.
- There are more processes and diagnostic points than in a monolithic extension.
- Some capabilities will have no exact equivalent across harnesses.
- Contract tests become a critical part of the product.

## Open decisions

- Validate bidirectional JSON-RPC over `stdio` with the Pi extension.
- Choose the specific SQLite and configuration crates.
- Define the first version of the capability catalog.
- Decide which commands belong in the CLI and which in the harness's native UI.
- Establish combined packaging for the Rust binary and TypeScript adapter.
- Determine when adding `xper serve` is worthwhile.
