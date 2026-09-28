# XP-015: Read-only workflow inspection

- Status: `pending`
- Milestone: M4
- Entry dependency: XP-010 and the RFC 0007 definition contract
- Next slice: XP-015.1

## Outcome and boundary

Show declared topology and reported execution in small independent deliveries.
Follow the [iteration rules](README.md#iteration-rules-for-xp-011-onward).
This group does not require delivery, final judgment, or every metric.

The first surface is a local generated HTML/SVG document opened in a browser,
using a supplied versioned definition/export. No server, hosting, live
connection, application shell, statechart runtime, or UI framework is required.
A later product UI is a separate decision informed by these views.

The view never evaluates guards, executes reducers, approves gates, schedules
work, or calls agents. Rust records opaque adapter facts without interpreting
Knowledge's phase names.

## XP-015.1 — Draw one recorded definition

- Status: `pending`
- Depends on: XP-010
- Example: supply a recorded Knowledge definition and obtain a diagram showing
  its actual version, nodes, and declared edges.

Acceptance:

- Render the supplied definition, without hardcoded phase order or deriving
  possible edges from observed transitions.
- A synthetic definition with different node names renders through the same path.
- Missing/unsupported definitions produce a diagnostic, never substitution of
  the newest graph or guessed historical topology.
- The output works offline, reads no artifact contents, and modifies no run.

Stop here: one graph; no execution overlay, dashboard, polling, or graph editor.

## XP-015.2 — Show one instance's observed path

- Status: `pending`
- Depends on: XP-015.1 and the safe export from XP-013.2
- Example: display a revisit, separating possible edges from reported traversals
  and labeling the last observed position.

Acceptance:

- Match the exact definition ID/version and preserve visit/transition identities.
  Repeated reports do not create invented traversals.
- Show observation time and incomplete/unsupported history. An exported snapshot
  cannot claim knowledge of unsent events or current live execution.
- Distinguish reported blocked gates, completed instances, and final run closure;
  infer no approvals or execution outcomes.

Stop here: no subscriptions, metrics formulas, or workflow controls.

## XP-015.3 — Inspect attempts and additional instances

- Status: `pending`
- Depends on: XP-015.2
- Example: select another recorded instance and inspect its attempts, outcomes,
  and evidence references without mixing them with the first.

Acceptance:

- A fixture with different definitions and overlapping attempts keeps run,
  instance, visit, and attempt identities separate; add no global phase enum.
- Simple local navigation reveals metadata and references. Prompts, code,
  credentials, and artifact contents are not loaded by default.
- A damaged instance is unavailable without corrupting another view.
- Generating, opening, or failing the view cannot affect Pi execution.

Stop here: inspecting concurrent fixtures does not authorize implementing
concurrent execution in XP-011.

## Deferred work

Live UI integration, large-graph layout optimization, metric overlays, timelines,
profile comparisons, and remote sharing need separate tasks. Visual editing
and remote execution controls are outside this design.
