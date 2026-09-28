# XP-005: Minimal Pi adapter

- Status: `done`
- Milestone: M1
- Dependencies: XP-001 and XP-004

## Goal

Connect a real Pi session to the bridge without introducing workflow rules
into the TypeScript extension.

## Scope

- Load the xper extension in a normal Pi session.
- Start and supervise `xper bridge --stdio` during the session.
- Implement the handshake and Pi capability manifest.
- Register `/xper status` and a minimal, unobtrusive indicator.
- Forward session startup, shutdown, and basic errors.
- Close the bridge when the extension unloads or Pi exits.
- Show an actionable error if the binary is missing or incompatible.

## Acceptance criteria

- A normal `pi` session starts with the adapter connected.
- `/xper status` shows versions, adapter, and bridge state.
- A bridge crash does not block or corrupt the Pi session.
- Restarting or reloading the extension does not accumulate orphan processes.
- The extension contains no phase or gate decisions.

## Out of scope

- Delegating subagents.
- Persisting runs.
- Building the complete xper UI.

## Result

- `.pi/extensions/xper.ts` loads the adapter without an external
  primary-agent package. `/xper` starts the workflow directly; the
  [2026-09-27 revision](../rfcs/0004-pi-integration.md#direct-workflow-activation-revision-2026-09-27)
  removes the original primary definition and package requirement.
- The extension starts the bridge on `session_start`, negotiates capabilities,
  and sends `session.attach`; on `session_shutdown` it sends `session.detach`
  and waits for process exit. `/xper status` shows versions, PID, and connection;
  the TUI indicator is minimal.
- Tool and compaction errors are sent as observations without storing results,
  prompts, or code. If the binary is missing or the bridge is incompatible,
  Pi keeps working and shows a concrete action.
- Process tests cover the handshake, lifecycle, restart, crashes, and startup
  errors. The original real probe used Pi `0.85.1` and
  `pi-open-agents@0.1.22` and validated `pi --approve --agent xper`,
  `/xper status`, the handshake, and shutdown without an orphan process.
  That historical probe is not the current installation recipe.
- A native Pi `0.87.1` RPC probe on macOS verified the new `/xper` entry point
  with only the xper extension loaded and isolated Pi/configuration directories.
  It confirmed registration, the objective dialog, starting Discovery, resuming
  the same workflow with a direct objective, and graceful shutdown. The probe
  used no model credentials or model calls and did not load an agent manager.
