# RFC 0004: Pi integration and workflow activation

- Status: accepted, revised for direct workflow activation on 2026-09-27
- Date: 2026-09-22
- Depends on: [RFC 0001](0001-product-and-workflow.md), [RFC 0002](0002-multimodel-configuration.md), and [RFC 0003](0003-observability-and-metrics.md)
- Related to: [RFC 0005](0005-modular-architecture.md)
- Current implementation: [Pi adapter architecture](../../adapters/pi/docs/architecture.md)

## Summary

xper runs inside Pi through its own extension. `/xper` starts the workflow,
and `xper_delegate` executes Discovery through a child Pi process. The Rust
core owns workflow state, gates, routing, and evidence. No external
agent-manager package is required.

The [direct activation revision](#direct-workflow-activation-revision-2026-09-27)
supersedes the original dependency on `pi-open-agents`. The prototype and
compatibility decisions below remain as historical evidence; they do not
require installing that package in the current integration.

The xper CLI remains responsible for initialization, configuration,
diagnostics, queries, and export. Pi owns the interactive session.

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
changing the accepted Pi or pinned `pi-open-agents` versions. The prototype's
tested combination was Pi `0.85.1` + `pi-open-agents 0.1.22`; the Windows probe
is still pending.

## Revision for XP-008 (2026-09-26)

The first vertical slice enables the bridge's `subagents` capability. The
custom `xper_delegate` tool creates a `discovery.explorer` assignment and a
durable Attempt, resolves the role in the adapter, and executes a child Pi
process over RPC. Its explicit outcome (`succeeded`, `failed`, `cancelled`, or
`timed_out`) determines the Attempt's state. The `pi-open-agents` `subagent`
tool remains available for exploration outside the workflow's control, and
its signals cannot pass the Discovery gate. Commands, artifacts, gates, and
events for this revision are described in [XP-008](../tasks/008-vertical-slice.md).

## Pi compatibility revision (2026-09-27)

Installation checks now accept stable Pi versions from `0.85.1` through
`0.87.1`, inclusive, for both `doctor` and `init`. Comparison uses numeric
major, minor, and patch components; malformed versions, prereleases, and build
suffixes are rejected. `pi-open-agents` remains pinned to `0.1.22`.

On macOS, Pi `0.87.1` passed the isolated, credential-free XP-001 core probe
for extension registration, tool hooks, UI status over RPC, child-process
communication, and graceful shutdown. The adapter also parsed the real Pi
model catalog in an isolated offline environment. The workspace checks passed.
This evidence does not cover every intermediate release, Windows, or a new
end-to-end run with `pi-open-agents` and real models.

## Direct workflow activation revision (2026-09-27)

The adapter now starts the workflow directly from `/xper`. It no longer
requires `pi-open-agents` to discover or activate a primary agent. This
supersedes the package requirement, primary-agent Markdown contract, generic
`subagent` telemetry, and installation policy in the earlier decisions.

The existing executor already owns the durable Discovery lifecycle. Replacing
one mandatory agent manager with another would not simplify that path, and
the assessed subagent packages do not provide the removed primary-agent activation
interface. This revision keeps the existing execution dependency in
`delegateDiscovery`; it introduces no executor registry or backend selection.

## Current interaction

Prepare the checkout's extension and bridge as described in the
[README](../../README.md#relationship-with-pi), then start `pi` and enter:

```text
/xper Explore the current state of this project
```

Bare `/xper` asks for an objective interactively. `/xper start <objective>`
remains an explicit form, and `/xper status` and `/xper advance` retain their
existing responsibilities. The command starts or resumes the session's run;
the extension displays its phase and next action. It does not switch the
session's primary agent or system prompt, call a model automatically, or
execute subsequent phases on its own. Its manifest advertises
`primaryAgent: false` and retains `subagents: true` for its own executor.

```text
Pi session
└── xper extension
    ├── /xper: start or resume, inspect, request advancement
    ├── xper bridge --stdio: Rust use cases, gates, and persistence
    └── xper_delegate: Discovery assignment and durable Attempt
        └── child Pi RPC process: discovery.explorer
```

Only Discovery through Define is implemented. Further specialist roles and
workflow phases remain in the backlog.

## Responsibilities

### Pi

- Provide the session, TUI, providers, models, credentials, and base tools.
- Execute agent cycles and expose runtime events.
- Maintain the interactive experience and conversation persistence.

### xper Pi adapter

- Register `/xper`, `xper_delegate`, hooks, and status presentation.
- Translate Pi sessions, models, and events into the public xper protocol.
- Execute Discovery in a child Pi process, with explicit errors,
  cancellation, timeout, and correlation to the core's Attempt.
- Save the Brief before returning its path and reporting success.
- Record xper observations and forward generic Pi errors without treating
  another extension's tool events as workflow outcomes.

### xper core

- Govern the implemented workflow and transitions.
- Resolve and freeze configured model routing for a run.
- Create assignments and attempts and record their outcomes.
- Evaluate the Discovery gate from persisted evidence.
- Retain artifacts' references, events, projections, and recovery state.

A conversation or child session can disappear without invalidating artifacts,
events, and states already persisted by xper. The architecture and current
limitations are detailed in the [adapter guide](../../adapters/pi/docs/architecture.md)
and [core guide](../architecture.md).

## Initialization and migration

`xper init` prepares configuration in the project; `xper init --global`
prepares configuration in the user scope. They perform preflight before
writing, preserve valid existing configuration, and do not launch a workflow.
They no longer create or repair `.pi/agents/xper.md`, pin an agent-manager
package, inspect competing managers, or modify Pi settings. The legacy `--yes` flag remains accepted for script compatibility
but does not change this configuration-only operation.

The checkout removes its own `pi-open-agents` package declaration and primary
agent definition. Existing user-managed global or project packages and agent
files are left in place. They can be managed through Pi independently; xper
neither requires nor automatically uninstalls them. Current launch instructions
use `pi` followed by `/xper`.

## Doctor and compatibility

`xper doctor` remains read-only. It checks the Pi executable and supported
version range, Pi settings validity, xper adapter availability, and effective
configuration. The
accepted stable Pi range remains `0.85.1` through `0.87.1`, inclusive.

The `PI_MISSING`, `PI_VERSION`, `PI_SETTINGS`, `ADAPTER`, and `CONFIG`
diagnostics retain their meanings where applicable. Package,
agent-definition, and manager-conflict diagnostics are retired because those
resources no longer determine xper readiness. The JSON report retains its
`schemaVersion`, `checks`, and per-check fields; consumers must allow the set
of checks to reflect the requirements being inspected.

Human-readable failures include observed evidence and a corrective action.
The CLI exits unsuccessfully when required checks fail. Installation checks
do not certify live model execution on every accepted Pi release.

## Observability

`XPER_PI_OBSERVATIONS_FILE` enables local JSONL observations with size-based
rotation. Session lifecycle, bridge status, command names, and xper Attempt
correlation remain observable without logging tasks, prompts, or outputs.
Plugin-specific `subagent` counters and tested-package labels are replaced
with generic Pi tool observations: started, completed, failed, in flight, and
unpaired results. These observations do not determine success; workflow
status comes from xper's recorded run and execution outcomes.
Generic Pi tool and compaction errors still pass through the adapter's hooks.

## Consequences

The normal workflow needs Pi and the xper adapter, with no additional
agent-manager installation. xper owns workflow activation through its command,
while the existing child-process
executor preserves Discovery's lifecycle and isolation boundary.

Maintaining the Pi extension and RPC executor remains xper's responsibility.
A child process is not a filesystem sandbox, and this revision does not add
worktree isolation or phases beyond Define. Integration tests must preserve
success, failure, cancellation, timeout, recovery, and session isolation, and
cover startup without an external primary-agent package.

## Alternatives and future work

The original [XP-001 spike](../spikes/001-pi-integration.md) records why the
internal `pi-open-agents` runner was unsuitable for durable attempts. An
external executor can be evaluated if it meets a concrete need, but is not a
prerequisite for this revision. Such an integration belongs behind the
existing injected execution dependency and must preserve xper's outcome,
routing, and recovery semantics.

Combined packaging, validation across operating systems, and later workflow
phases remain separate tasks. This revision does not implement a generic
agent catalog or interchangeable execution backends.
