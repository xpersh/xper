# XP-001: Pi integration spike results

- Date: 2026-09-22
- Verdict: **Conditional GO** for Pi and primary activation; **NO-GO** for
  using `pi-open-agents` as the durable delegation control plane.
- Disposable code (local, unversioned): `spikes/pi-integration/README.md`

## Tested versions and environments

| Component | Version | Environment | Result |
| --- | --- | --- | --- |
| Pi | `0.85.1` | macOS 26.5.2 arm64, Node `24.18.0` | PASS |
| Pi | `0.85.1` | Linux Debian arm64, Node `24.21.0` | PASS |
| `pi-open-agents` | `0.1.22` | macOS arm64, Pi `0.85.1` | PASS with error/cancellation defects |
| Windows lifecycle | Same Node/Pi probe | No Windows runtime was available | NOT RUN |

Recorded evidence paths:

- `spikes/pi-integration/evidence/macos-arm64-core.json`
- `spikes/pi-integration/evidence/linux-arm64-core.json`
- `spikes/pi-integration/evidence/macos-arm64-open-agents.json`

The probe and raw evidence are local artifacts under the gitignored `spikes/`
directory. They are not included in a clean clone; this report records the
observed results.

The lifecycle probe uses no credentials or network. It registers a deterministic
provider that forces Pi to execute a tool from another extension. The
`pi-open-agents` probe installs the exact version in a temporary
`PI_CODING_AGENT_DIR` without modifying the user's real installation.

Windows remains a required gate for XP-005/XP-014. The implementation avoids
POSIX dependencies (`process.execPath`, `fileURLToPath`, `spawn` with pipes,
and `child.kill()` without an explicit signal), and the same `npm run test:core`
can run on Windows, but it is not considered runtime evidence until executed
there.

## Results

### Extension and child process

Pi `0.85.1` loaded the TypeScript extension over RPC and registered the
`/spike-status` command, two tools, hooks, and a TUI status. On `session_start`,
the extension started a Node child with `stdin/stdout/stderr` and completed
`ready -> ping -> pong`; on `session_shutdown`, it completed
`shutdown -> shutdown_ack -> exit(0)` without using the termination fallback.

The same test passed on macOS and Linux. The process starts on `session_start`,
not in the extension factory, and shutdown is idempotent, as required by Pi's
current lifecycle.

### Visibility of tools from other extensions

For `spike_foreign_tool`, registered by another extension, the observer received
the following with the same `toolCallId`:

1. `tool_execution_start`
2. `tool_call`
3. `tool_execution_update`
4. `tool_result`
5. `tool_execution_end`

This allows observing and correlating any tool without parsing the TUI. Hooks
are global to the extension runtime, not private to the extension that
registered the tool.

### Primary activation

With a `.pi/agents/xper.md` definition using `mode: primary`, startup with
`--agent xper` worked. The first turn persisted a structured `open-agents-state`
entry with `{ name: "xper" }`. `/agent`, `/agents`, `/agent-search`, `set_agent`,
`search_agents`, and `subagent` were also registered according to the visibility
of available agents.

### Actual pi-open-agents contract

The `0.1.22` source re-exports types, discovery helpers, and `runSubagent()`
from its root. However, this does not constitute a consumable contract between
packages installed by Pi:

- The package declares no `exports` map.
- Its four `peerDependencies` accept `"*"`.
- Its version is pre-1.0.
- It was developed against Pi `0.84.4`, although the probe passed on `0.85.1`.
- A sibling extension could not resolve `import("pi-open-agents")`, even with
  the package installed and active in the same Pi instance.

An xper extension could use the direct API only by declaring its own npm
dependency—and therefore loading another copy—or by coupling to an internal
package-store path. Neither option is a stable boundary.

### Delegation, errors, and cancellation

Successful delegation started a child Pi process, produced progress, and
finished with `status: done`, `exitCode: 0`. Start and end were correlated
through Pi's `toolCallId`.

The test revealed two contract defects in `pi-open-agents@0.1.22`:

- A child that exits with `exitCode: 1` produces
  `details: { status: "error", isError: true }`, but the `tool_result` and
  `tool_execution_end` events expose `isError: false`. The plugin returns
  `isError` inside the object instead of throwing; Pi documents that a tool
  must throw to mark its result as an error.
- An RPC cancellation accepted immediately after `tool_execution_start` ends
  as `details: { status: "done", isError: false, exitCode: 0, output: "" }`.
  The runner converts a signal-based exit (`code === null`) to exit code zero,
  leaving no reliable cancellation signal.

Observing `details` can therefore recover known process errors, but cannot
reliably distinguish early cancellation from empty success.

## Capability matrix

| Capability | Status | Evidence or limitation |
| --- | --- | --- |
| Register commands | Available | `/spike-status` appears in `get_commands` |
| Register tools | Available | Own and external tools executed |
| Session/agent/tool hooks | Available | Probe JSONL events |
| Minimal TUI status/element | Available | `setStatus` also visible over RPC |
| Child process over `stdio` | Available | PASS on macOS and Linux; Windows pending |
| Observe another extension's tool | Available | Five events with one `toolCallId` |
| Activate `xper` as primary | Available | `--agent xper` + `open-agents-state` |
| Delegate to a child Pi process | Available | Actual success with structured output |
| Import the active installation as a library | Missing | `Cannot find module 'pi-open-agents'` |
| Invoke another extension's tool from `ExtensionAPI` | Missing | No public `executeTool` method |
| Reliable error in the Pi envelope | Defective | `details.isError=true`, hook `isError=false` |
| Reliable cancellation | Defective | Cancellation observed as empty success |
| Domain correlation ID | Missing | Only Pi-generated `toolCallId` exists |
| Versioned compatibility | Missing | pre-1.0, peers `*`, no published matrix |

## Package, version, and scope detection

The reproducible path is:

1. Resolve the user directory through `PI_CODING_AGENT_DIR` or Pi's default.
2. Read user `settings.json` and project `.pi/settings.json` to identify
   declared sources and pins.
3. Run `pi list --approve` in a trusted project to obtain effective `User` and
   `Project` resources and their resolved paths. Without `--approve`, Pi may
   hide the project scope.
4. Read `package.json` at the resolved path; its `name` and `version` provide
   evidence of the actual installed version.

`pi list` has no JSON output in the tested version. XP-006 must not treat its
text as a stable contract: prefer settings plus the resolved manifest and
encapsulate any `pi list` parsing behind a versioned detector.

## Integration decision

### GO

- Keep Pi as the interactive runtime and load xper as an extension.
- Pin `pi-open-agents@0.1.22` exactly for primary-agent discovery, definition,
  and activation during the first prototype.
- Use public Pi hooks for observation; never parse TUI text.

### NO-GO

- Do not import `runSubagent()` from the active `pi-open-agents` installation.
- Do not use the `0.1.22` `subagent` tool as the source of truth for workflow
  outcomes, errors, or cancellation.
- Do not expose Pi or `pi-open-agents` types outside the adapter.

### Concrete alternative

The xper adapter must register its own tool, such as `xper_delegate`, with a
structured contract including `attemptId`, agent, task, cwd, model, and session
policy. Its executor must be owned by xper, start Pi through JSON/RPC, reserve
stdout for the protocol, propagate `AbortSignal`, distinguish `exitCode` from
`signal`, and emit mutually exclusive terminal states
`succeeded | failed | cancelled`.

`pi-open-agents` can continue to provide `/agent`, discovery, and the definition
format, but it does not control the durable attempt lifecycle.

## Transferred risks

### XP-004

- Define cancellation as an explicit terminal state rather than inferring it
  from the exit code.
- Separate `exitCode`, `signal`, timeout, and protocol errors.
- Keep stdout exclusively for JSONL and stderr for diagnostics, and apply
  backpressure/LF framing.
- Make shutdown idempotent and tolerant of races between shutdown, cancellation,
  and child crashes.

### XP-005

- Start the bridge on `session_start` and close it on `session_shutdown`;
  never start resources in the factory.
- Register a custom `xper_delegate` and correlate through `attemptId` plus
  Pi's `toolCallId`.
- Do not trust `event.isError` for `pi-open-agents@0.1.22` tools.
- Run the Windows probe before accepting the cross-platform adapter.
- Detect command/tool collisions and keep UI optional in modes without a TUI.

### XP-006

- Pin the initial compatible combination to Pi `0.85.1` +
  `pi-open-agents 0.1.22`; any change requires rerunning these probes.
- Distinguish user/project scope and respect project trust during diagnostics.
- Verify the effective version from the resolved manifest, not just the string
  declared in settings.
- Detect duplicate installations, old managers, and packages present in both scopes.
- Keep `doctor` non-destructive and do not install/update packages without
  confirmation.

## Primary references

- [Pi extensions](https://pi.dev/docs/latest/extensions)
- [Pi RPC](https://pi.dev/docs/latest/rpc)
- [Pi JSON events](https://pi.dev/docs/latest/json)
- [pi-open-agents 0.1.22](https://pi.dev/packages/pi-open-agents)
- [pi-open-agents source](https://github.com/andrea-tomassi/pi-open-agents)
