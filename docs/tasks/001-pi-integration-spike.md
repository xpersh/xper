# XP-001: Pi and pi-open-agents integration spike

- Status: `done`
- Milestone: M0
- Dependencies: none

## Goal

Eliminate unknown integration risks before designing production code around
APIs that may not exist or be stable.

## Scope

- Create a minimal, disposable Pi extension.
- Confirm registration of commands, tools, hooks, and TUI elements.
- Confirm that an extension can start and stop a child process over `stdio`
  on macOS, Linux, and Windows.
- Verify which events are received for tools registered by other extensions.
- Inspect the actual `pi-open-agents` API and its versioning strategy.
- Test activation of `xper` as a `primary` agent.
- Test delegation and correlate start, result, error, and cancellation.
- Determine how to detect the effective package, version, and scope.

## Deliverables

- A short report with evidence and tested versions.
- A matrix of available and missing capabilities.
- A subagent integration decision: direct API, mediation through tools/hooks,
  or an alternative implementation.
- A list of risks passed on to XP-004, XP-005, and XP-006.

Result: [XP-001 report and decision](../spikes/001-pi-integration.md).

## Acceptance criteria

- There is a reproducible test of the extension–child-process lifecycle.
- It is known whether `pi-open-agents` offers a contract extensions can consume.
- It is clear how to observe or control a delegation without parsing UI text.
- A viable path or a `NO-GO` with a concrete alternative is documented.
- Spike code is separate and can be removed without affecting the product.

## Out of scope

- Implementing the workflow, persistence, or final configuration.
- Choosing all crates or publishing packages.
