# RFC 0004: Pi integration and primary agent

- Status: accepted for the first prototype
- Date: 2026-09-22
- Depends on: [RFC 0001](0001-product-and-workflow.md), [RFC 0002](0002-multimodel-configuration.md), and [RFC 0003](0003-observability-and-metrics.md)
- Related to: [RFC 0005](0005-modular-architecture.md)
- Current implementation: [Pi adapter architecture](../../adapters/pi/docs/architecture.md)

## Summary

xper will run inside Pi as the session's primary agent. The first prototype
will use [`pi-open-agents`](https://pi.dev/packages/pi-open-agents) as the
primary-agent and subagent layer. xper will add the XP state machine,
cross-phase contracts, multimodel routing, artifacts, and observability.

> **XP-001 result:** the spike recommended using `pi-open-agents` for discovery
> and primary activation, and building a custom executor for durable delegations.
> The explicit `0.0.1` decision below also accepts trying its `subagent` tool,
> retaining the limitations discovered in the
> [spike report](../spikes/001-pi-integration.md).

This decision replaces the initial idea of an `xper run` process controlling
Pi from outside. The xper CLI is reserved for initialization, configuration,
diagnostics, queries, and export.

## Decision for prototype 0.0.1 (2026-09-24)

`pi-open-agents@0.1.22` is retained for primary-agent discovery and activation.
In `0.0.1`, its `subagent` tool will also be allowed as a provisional executor
to learn from real sessions before replacing or retaining it. The xper
extension will not import its internal API.

This decision accepts two defects observed in XP-001: a child failure can
arrive with `event.isError: false`, and early cancellation can look like a
successful completion. Therefore, `status: done` is recorded as a **reported
result**, not verified success. These events are insufficient to pass a gate,
close a durable attempt, or infer cancellation. The custom executor proposed
by the spike is deferred until usage evidence is available; the core remains
independent of the plugin.

The adapter counts starts, reported completions, reported errors, discrepancies
between `isError` and `details.isError`, completions without a start, and open
operations per session. `/xper status` shows these counters. When
`XPER_PI_OBSERVATIONS_FILE` is set, Winston writes local JSONL with size-based
rotation (5 MiB per file, five files total). It includes timestamps, correlation
IDs, reported state, exit code, and signal when available. It also records
session activation and `/xper` invocations without saving arguments. It does
not record the subagent's task, prompt, or output. The file is optional;
counters work without it. If writing fails, the extension warns and retains
those counters in memory.
The `testedOpenAgentsVersion` field identifies the probe version; it does not
certify the installed version. That effective check belongs to `doctor`.

In that prototype, the manifest declared `subagents: false`: no protocol
operation yet allowed xper to create and control an attempt. The Pi tool was
observed but was not a durable xper capability.

The decision will be reviewed before using delegations for automatic
transitions, when new discrepancies or unpaired completions appear, and before
changing the pinned Pi or `pi-open-agents` versions. The tested combination
remains Pi `0.85.1` + `pi-open-agents 0.1.22`; the Windows probe is still pending.

## Revision for XP-008 (2026-09-26)

The first vertical slice enables the bridge's `subagents` capability. The
custom `xper_delegate` tool creates a `discovery.explorer` assignment and a
durable Attempt, resolves the role in the adapter, and executes a child Pi
process over RPC. Its explicit outcome (`succeeded`, `failed`, `cancelled`, or
`timed_out`) determines the Attempt's state. The `pi-open-agents` `subagent`
tool remains available for exploration outside the workflow's control, and
its signals cannot pass the Discovery gate. Commands, artifacts, gates, and
events for this revision are described in [XP-008](../tasks/008-vertical-slice.md).

## Decision

The primary experience will be:

```text
user
   |
   v
Pi session with xper as the primary agent
   |
   +-- xper extension: workflow, gates, state, and metrics
   |
   +-- pi-open-agents: discovery, definitions, and primary agent
   |
   +-- pi-open-agents subagent: provisional execution in 0.0.1
   +-- xper executor: Discovery with durable attempts and explicit cancellation
           |
           +-- discovery / define / design / plan
           +-- driver / navigator / verifier
           +-- judgment-day
```

After initializing the project, start the session with:

```bash
pi --agent xper
```

In an existing session, activate it with:

```text
/agent xper
```

The xper coordinator is therefore Pi's primary agent. Specialized agents are
ephemeral subagents instantiated when a phase or assignment requires them.

## Responsibilities

### Pi

- Provide the session, TUI, providers, models, credentials, and base tools.
- Execute agent cycles and expose runtime events.
- Maintain the interactive experience and conversation persistence.

### pi-open-agents

- Discover global and project definitions.
- Activate `xper` as a `primary` agent.
- Apply each agent's model, reasoning level, prompt, tools, and permissions.
- Provide subagent discovery and definition format.
- Execute the `subagent` tool provisionally and observably in `0.0.1`.
- Provide interactive selection and permission compatibility for uses outside
  xper's workflow control.

### xper Pi adapter

- Register commands, tools, hooks, and TUI elements in Pi.
- Translate Pi sessions, models, subagents, and events into the xper protocol.
- Apply commands issued by the core in Pi.
- Integrate with `pi-open-agents` without exposing its API to the domain.
- Detect the active runtime's capabilities and limitations.
- Register and execute its own structured delegation when durable attempts
  are needed, with explicit correlation, errors, and cancellation.

### xper core

- Govern the XP workflow and its transitions.
- Build the minimum context for each assignment.
- Resolve execution profiles and model presets.
- Evaluate gates, manage rework, and request human decisions.
- Version artifacts and retain durable state.
- Maintain the harness-independent observability model.

`pi-open-agents` is not the workflow's source of truth. A conversation or child
session can disappear without invalidating artifacts, events, and states
already persisted by xper.

## Agent definitions

Definitions will initially follow the Markdown format compatible with
`pi-open-agents`. The primary agent can exist at:

```text
~/.pi/agent/agents/xper.md   # global installation
.pi/agents/xper.md           # project installation
```

Conceptual schema:

```yaml
---
name: xper
description: Development coordinator based on Extreme Programming
mode: primary
systemPrompt: replace
permission:
  "*": deny
  read: allow
  grep: allow
  find: allow
  ls: allow
  subagent: allow
allowedAgents:
  - discovery
  - define
  - design
  - breakdown
  - planner
  - driver
  - navigator
  - verifier
  - judgment-day
---
```

Model identifiers and reasoning level are not fixed in the product template.
They are resolved from the active execution profile and context, and the
instantiated definition can include them when needed. The permissions above
are also illustrative: the coordinator will follow least privilege and
delegate code modification to the corresponding roles.

## Initialization

`xper init` prepares xper in the current project. `xper init --global` installs
reusable resources in the user scope. Neither command starts a development
session.

Initialization preflight must check, in this order:

1. The `pi` executable exists and responds.
2. The Pi version is compatible with xper.
3. `pi-open-agents` is installed in the effective scope.
4. Its version is within xper's tested range.
5. No incompatible agent manager is loaded at the same time.
6. The `xper` definition is discoverable as a `primary` agent.
7. Required subagents exist and their permissions are valid.
8. Referenced providers and models are available.
9. The project is trusted when it uses local Pi resources.
10. Configuration and data paths have appropriate permissions.

If `pi-open-agents` is missing, initialization must explain that it is required
for the first version and show:

```bash
pi install npm:pi-open-agents
```

In an interactive terminal, xper can offer to run the installation after
explicit confirmation. Noninteractive execution must exit with a nonzero code
and structured output identifying the missing dependency. It must not install
packages silently.

## Doctor

`xper doctor` runs the same preflight without modifying the system and adds
operational diagnostics:

| Check | Failure | Proposed action |
| --- | --- | --- |
| Pi not found | `FAIL` | Install Pi and repeat the diagnostic |
| Incompatible Pi | `FAIL` | Install a supported version |
| Missing `pi-open-agents` | `FAIL` | `pi install npm:pi-open-agents` |
| Incompatible extension | `FAIL` | Install the version recommended by xper |
| Conflicting agent managers | `FAIL` | Disable the indicated package |
| Missing `xper` agent | `FAIL` | Repair through `xper init` |
| Missing optional subagent | `WARN` | Create it or disable the capability |
| Unavailable model or credential | `FAIL` or `WARN` | Depends on whether a valid fallback exists |
| Unwritable SQLite | `WARN` | Fix permissions; the workflow can continue without metrics |

Human-readable output must include the cause, observed evidence, and a concrete
action. `--json` output must use stable identifiers so CI or a future GUI can
consume it.

Conceptual example:

```text
PASS  pi                 0.x.y
PASS  pi-open-agents     0.1.22
PASS  primary-agent      xper
PASS  execution-profile  work
WARN  metrics-store      could not open; using degraded mode
```

The version shown is illustrative. The compatibility matrix will be part of
each xper release. Since `pi-open-agents` is still pre-1.0, xper will not assume
compatibility across minor versions without running its integration suite.

## Decoupling

xper will access Pi through an external TypeScript adapter and a versioned
protocol. The core will not import Pi or `pi-open-agents` types. The minimum
adapter contract must cover:

- Primary-agent discovery and activation.
- Subagent enumeration and validation.
- Attempt creation, tracking, cancellation, and continuation.
- Model and reasoning-level selection.
- Tool and permission application.
- Correlation of child sessions with assignments.
- Receipt of lifecycle and usage events.

This allows trying `pi-open-agents` first and replacing it or supporting another
backend later without changing the state machine or metrics schema.

The same boundary will allow adapters for other harnesses in their natural
technologies. The overall architecture and dependency rules are defined in
[RFC 0005](0005-modular-architecture.md).

## Consequences

### Benefits

- The experience matches OpenCode's primary-agent concept.
- xper retains Pi's TUI, sessions, and providers.
- Discovery, primary-agent selection, and definition format do not need to be
  built from scratch. The durable delegation lifecycle is the responsibility
  of xper's adapter.
- Definitions can be partially shared with OpenCode.
- The first prototype focuses on XP workflow and observability.

### Risks

- `pi-open-agents` is young and still uses pre-1.0 versions.
- Its API or format can change.
- Other agent managers may register conflicting commands or tools.
- Subagent execution does not itself replace worktree or sandbox isolation.

Initial mitigations are pinning a tested version, validating installation with
`doctor`, maintaining integration tests, and encapsulating the dependency
behind the adapter.

## Alternatives considered

- **pi-landstrip:** greater adoption and process isolation, but adds a sandbox
  and native binaries that substantially increase initial scope.
- **pi-mode-switch:** simple for model, tool, and skill profiles, but does not
  solve subagent orchestration on its own.
- **Direct integration with Pi's SDK/RPC:** offers maximum control, but would
  require rebuilding from the start an experience Pi already provides.
- **External control plane with `xper run`:** rejected for the primary
  experience because it duplicates Pi's lifecycle and conflicts with the intent
  for xper to be the session's primary agent.

## Open decisions

- Exact supported version range for Pi and `pi-open-agents`.
- Package-detection mechanism for global and project scopes.
- Final names and syntax of `/xper` commands within Pi.
- Policy for updating, repairing, or disabling conflicting dependencies.
- Whether to add sandboxing through `pi-landstrip` or another solution later.
