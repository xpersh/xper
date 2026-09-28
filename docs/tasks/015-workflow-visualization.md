# XP-015: Read-only workflow visualization

- Status: `pending`
- Milestone: M4
- Dependencies: XP-010 and the definition/observation contract in RFC 0007

## Goal

Make workflow topology and reported execution understandable without moving
workflow control into the UI or Rust recorder.

## Scope

- Render the exact adapter definition ID and version associated with an instance.
- Show declared nodes and edges, current reported position, visits, transitions,
  attempt outcomes, and evidence references.
- Distinguish possible transitions from paths actually taken and blocked gates.
- Support multiple flow instances without assuming a single global phase.
- Show recording freshness, pending/incomplete history, and unsupported versions.
- Choose the presentation surface when implementing this task; the current
  definition contract does not prescribe a web dashboard or UI library.

## Acceptance criteria

- Rendering consumes versioned definition data; it does not infer topology from
  phase order or require a hardcoded knowledge-flow diagram.
- Adding a synthetic second flow with different node names does not require
  changing the knowledge phase enum or the Rust recorder.
- A run with parallel instances and a revisit retains distinct instance,
  visit, and attempt identities in the view.
- Missing definitions and incomplete or legacy histories remain visibly unknown;
  the view never substitutes the latest definition for a historical version.
- The UI performs no transitions, approvals, scheduling, or agent execution.
- Loading or failing the view cannot affect a running Pi workflow.
- Default output excludes prompts, artifact contents, credentials, and user code.

## Out of scope

- Visual workflow editing or remote execution commands.
- Implementing the future Implementation/Verification workflows.
- Metrics formula and comparison work owned by XP-013.

## Design reference

[RFC 0007](../rfcs/0007-explicit-adapter-state-machines.md) separates executable
workflow definitions, instance state, observations, and presentation.
