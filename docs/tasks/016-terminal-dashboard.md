# XP-016: Terminal dashboard and configuration authoring

- Status: `review`
- Milestone: M4
- Depends on: existing configuration, recording, and Pi routing
- Scope: the requested four-slice dashboard plus the requested profile-management follow-up

## Outcome and boundary

Running `xper` opens a keyboard-driven Ratatui dashboard. A person can create
or edit a scoped profile using Pi's catalog, then inspect recorded runs and
existing usage metrics. Views belong to CLI infrastructure; Rust remains
configuration and recording, while Pi owns workflow decisions and role help.
No model assignment, agent execution, approval, or workflow transition is automatic.

Reuse scoped configuration, installation preflight, read-only SQLite inspection,
generic projections, and Pi's model discovery. Do not add metric formulas or
implement the workflow visualization and comparison backlog.

Before the initial delivery, configuration requires hand-written identifiers
and history has only latest/specific-run CLI queries. After: a user chooses
scope, context, profile, and exact catalog models, reviews the result, saves it,
and browses recorded status and usage from the same dashboard.

## Reviewable increments

| Slice | Status | Observable result |
| --- | --- | --- |
| XP-016.1 | `review` | Bare `xper` opens navigation and a paginated project history; non-TTY and existing commands retain plain output. |
| XP-016.2 | `review` | Model selection uses Pi's cached catalog and native search, with adapter-owned role guidance. |
| XP-016.3 | `review` | A scoped configuration is previewed, validated, and explicitly saved from a complete profile wizard. |
| XP-016.4 | `review` | Existing configuration is edited without flattening inheritance; activation, conflicts, and unrelated content are preserved. |
| XP-016.5 | `review` | Profiles opens directly to an inventory with source scopes and visible actions; Settings manages contexts independently; activation selects Global, Project or Local explicitly. |

### XP-016.5: Profile management and scoped activation

Before: activating a profile requires navigating scope files and contexts, and
the destination of activation differs from the chosen editing scope. After:
Profiles lists logical profiles with their creation scope, overrides and active
state. Enter exposes Activate, Edit, Delete and Remove activation; New profile
starts directly from that section. Settings manages provider contexts separately.
Actions choose a destination scope and reuse the existing preview/save operations.
Scoped activation uses the YAML profile selector already consumed by Pi; legacy
workspace overrides remain explicit and removable without silent migration.

Verify source inventory, same-name overrides, scoped activation and masking,
creation/edit/delete/back navigation, independent context authoring, draft
preservation, compact rendering and end-to-end PTY flows. Reuse existing
configuration authoring, catalog workers, projections and terminal lifecycle.

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

### Profile-management follow-up (XP-016.5)

Verified on 2026-10-05 with a fresh `npm run check` (exit 0), including 50 CLI
unit tests and two POSIX PTY checks. The PTY drives independent context creation,
profile creation without activation, scoped activation, review cancellation,
and a local model override. Regressions cover all three activation scopes,
higher-only definitions, legacy override preservation, blocked deletion,
profile/context isolation, context reassignment, and pending provider choices
that must survive navigation before Enter. Inventory and rendering tests cover
source scopes, same-name overrides, active state, visible actions at 80 and 60
columns, and the existing terminal-size matrix.

The requested UI reorganization is one follow-up across existing views and
authoring operations. Its diff adds approximately 1,020 production lines,
760 test lines and 170 documentation lines, and removes approximately 350 lines.
There are no new dependencies, public protocol changes, persistence formats or
workflow decisions. `git diff --check` and local Markdown target checks pass.
The complete check reports existing non-failing Biome diagnostics in unchanged
Pi workflow files; these are outside this follow-up.

Known limitation: activating Global saves a global YAML selection but does not
install or register xper in Pi globally. Other projects require the extension
and a launchable bridge. Automatic integration setup for the selected scope is
not included in this slice.

### Initial dashboard delivery (XP-016.1–XP-016.4)

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
