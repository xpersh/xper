# XP-016: Terminal dashboard and configuration authoring

- Status: `review`
- Milestone: M4
- Depends on: existing configuration, recording, and Pi routing
- Scope: the complete four-slice delivery explicitly requested together

## Outcome and boundary

Running `xper` opens a keyboard-driven Ratatui dashboard. A person can create
or edit a scoped profile using Pi's catalog, then inspect recorded runs and
existing usage metrics. Views belong to CLI infrastructure; Rust remains
configuration and recording, while Pi owns workflow decisions and role help.
No model assignment, agent execution, approval, or workflow transition is automatic.

Reuse scoped configuration, installation preflight, read-only SQLite inspection,
generic projections, and Pi's model discovery. Do not add metric formulas or
implement the workflow visualization and comparison backlog.

## Reviewable increments

| Slice | Status | Observable result |
| --- | --- | --- |
| XP-016.1 | `review` | Bare `xper` opens navigation and a paginated project history; non-TTY and existing commands retain plain output. |
| XP-016.2 | `review` | Model selection uses Pi's cached catalog and native search, with adapter-owned role guidance. |
| XP-016.3 | `review` | A scoped configuration is previewed, validated, and explicitly saved from a complete profile wizard. |
| XP-016.4 | `review` | Existing configuration is edited without flattening inheritance; activation, conflicts, and unrelated content are preserved. |

Before: configuration requires hand-written identifiers and history has only
latest/specific-run CLI queries. After: a user chooses scope, context, profile,
and exact catalog models, reviews the result, saves it, and browses recorded
status and usage from the same dashboard.

## Acceptance and verification

- Explicit application operations and ports; no Pi policy or Ratatui in the core.
- Versioned adapter inspection contract, schemas, and shared synthetic fixtures.
- Scope provenance, inherited overrides, quoted IDs, unknown-field preservation,
  conflicting edits, atomic replacement, private-local ignore rules, and cancellation.
- New profiles cover the adapter's roles; existing partial profiles remain inspectable
  with missing-route diagnostics, without inventing per-role fallback.
- Paginated modern and legacy history, unknown metrics, absent/read-only stores,
  asynchronous loading, stale-result rejection, and recoverable failures.
- Keyboard access, 80x24 and 60-column layouts, minimum-size state, Unicode,
  monochrome, ASCII, terminal restoration, and plain output compatibility.
- Targeted unit, rendering, contract, integration, and PTY checks followed by
  `npm run check`; record actual evidence before moving slices to `review`.

## Delivery evidence

Verified on 2026-10-05 with `npm run check` (exit 0): formatting, lint, architecture
boundaries, shared contracts, type checking, the Rust workspace, and all 245 Pi
tests. `git diff --check` and local Markdown path checks also pass.

- XP-016.1: application/store/CLI tests cover bounded pages, modern and legacy
  ordering, missing storage without writes, cursor errors, JSON compatibility,
  and preserved selection across overlapping and disjoint refreshes. Rendering
  checks cover 140x40, 80x24, 60x24, 48x12 and 40x10; a 60-column regression checks
  scrolling through metrics when the run has very few events.
- XP-016.2: adapter tests exercise cached native fuzzy search, custom providers,
  empty results, refresh, timeout, cancellation and protocol validation. Rust
  worker tests cover stale searches, close/reopen cancellation, role metadata
  surviving catalog failure, and the exact JSONL frame size boundary.
- XP-016.3: an isolated POSIX PTY drives context/provider/profile creation,
  manual assignment of all eight roles, review and save. Cancelling the same
  wizard writes no configuration. First save retains installation preflight.
  Continuing after provider selection automatically prompts for the first
  profile, avoiding an empty list that could be mistaken for a failed creation.
  Regression checks cover cancelling/resuming the name prompt with the context
  draft intact and retaining the profile list when profiles already exist.
- XP-016.4: configuration tests cover scope-specific authoring, masking, inherited
  overrides, partial profiles, quoted identifiers, comments, unknown settings,
  permissions, conflicting external edits, atomic-write errors and activation.
  UI regressions bind every preview to its exact revision, scope and changes;
  context reassignment preserves implicit inheritance and updates explicit routes.
  A PTY edit verifies a minimal local model override while preserving other files.

PTY checks also cover the initial frame, ASCII output, resizing, suppression of
hidden actions below the minimum size, unavailable/pending catalogs, q/Ctrl+C,
and terminal/cursor restoration. Error and panic paths use an isolated probe of
the same Ratatui lifecycle wrapper. They use Python 3's standard library on POSIX;
Windows terminal behavior has not been exercised in this delivery.

The combined four-slice scope was explicitly requested. The review contains
approximately 5,500 added code/build/schema lines, 1,600 test/fixture lines,
400 documentation lines, and 700 dependency-lock lines. New dependencies are
Ratatui 0.30, Crossterm 0.29, `time` formatting, and Pi TUI 0.87.1's native search.
The public additions are the dashboard/CLI flags, paginated local history and
the separate adapter inspection v1 contract; the existing bridge is unchanged.

See the [user guide](../terminal-dashboard.md),
[core architecture](../architecture.md), and
[adapter inspection contract](../../adapters/pi/docs/inspection.md). Advanced
metrics, comparisons, workflow graphs, budget/approval editing and agent execution
remain excluded. File conflict checks are optimistic; external editors do not
share a lock. No slice is accepted solely because its tests pass.
