# Terminal dashboard

Run `xper` in the project directory. The dashboard uses the current directory,
as existing xper commands do; it does not discover a different Git root.
Opening or browsing it does not create configuration or recording files.
All user-interface state and rendering belong to CLI infrastructure.

## Navigation

Home shows configuration locations, the effective profile, and the latest
recording. Configuration authors scoped files. Status and Metrics share a
project history and selected recording.

| Key | Action |
| --- | --- |
| Tab / Shift+Tab, 1–4 | Switch section |
| Arrows, j/k in lists | Move selection |
| Enter | Open detail, choose an item, or confirm the displayed action |
| Esc | Go back; keep or explicitly discard an unsaved draft |
| ? | Keyboard help |
| q | Quit, with an unsaved-draft choice |
| Ctrl+C | Interrupt and exit without saving the draft |
| r | Refresh recorded data or the Pi catalog |
| F5 in Configuration | Reload files, retaining draft edits for a fresh review |

Printable shortcuts become ordinary text in name and model-search fields.
Wide terminals show navigation and details alongside content. At 80 columns,
Enter opens details; at 60 columns one primary view remains. Below 48×12 a
resize message preserves the current draft and suspends actions except Ctrl+C.
`--ascii` avoids decorative Unicode;
`NO_COLOR` disables automatic colors while selection remains visible.

## Configuration

Choose Global, Project, or Local (private). The destination is shown before
editing. Precedence remains defaults, global, project, then local. Editing an
inherited value creates an override in the chosen file, never a flattened copy
of the effective configuration.

1. Select a context, or press `n` to name one. `e` edits its allowed providers;
   Space toggles providers and Enter keeps the selection in the draft.
2. If there are no profiles, continuing from the context automatically asks for
   the first profile's name. Otherwise, select a profile or press `n` to create
   one. Contexts control allowed providers; profiles assign models to roles.
   Cancelling the name prompt keeps the context draft; Enter on the empty profile
   list opens it again.
3. Select a role and press Enter to search Pi's available models. Type the query,
   use F4 to filter provider, and Enter to choose an exact result. `a` explicitly
   applies the chosen model to every listed role. `t` cycles thinking levels;
   a known non-reasoning model permits only `off`.
4. `d` sets the current profile as this scope's configured default. `c` changes
   an existing profile to the context selected earlier in the wizard.
5. `v` validates and shows the destination, before/after source and masking
   diagnostics. Scroll to review; Enter saves. Esc returns to the draft.

New guided profiles cover every role described by Pi. Existing partial profiles
and unknown roles are retained. An absent route is labelled unconfigured: Pi
stops when that role is needed, rather than silently selecting a default model.
Advice about frontier models, strong reasoning and independent review is
informational. Xper does not rank models or choose one for the user.

Delete removes the selected context, profile, or role override from the chosen
scope. Lower-scope values can reappear; the draft must still pass validation and
be reviewed before any write. `v` also reviews context-only edits from the context
or profile list. Unrelated settings and comments outside changed spans remain.
If a source cannot be parsed, choosing that scope offers an explicit replacement
draft; the original remains untouched until the replacement is reviewed and saved.
Alternatively, correct the source externally and use F5 to reload it.

Workspace activation is separate: `a` on the profile list activates a saved
profile, and `u` clears the local activation so the configured default applies.
Start a new Pi session after changing configuration or activation. Runs that have
already started retain their frozen selections.

The first configuration save runs installation preflight. Ordinary edits can
be prepared without Pi; unavailable catalog validation is reported. Exact new
model choices require an available catalog. Pi loading retains its normal
extension and provider initialization behavior. Search uses a cached catalog;
`r` explicitly reloads it. See the adapter's
[inspection contract](../adapters/pi/docs/inspection.md).

Saves validate affected routes, detect changes since inspection, preserve file
permissions and replace the destination atomically. A conflict retains the draft;
reload and review again. Revision checks are optimistic, not a lock shared with
external editors. Private-local configuration is added to `.gitignore`; that
ignore entry can remain if a later file-save step fails. Credentials are rejected.

## Recorded history and metrics

Status and Metrics list recordings newest-first in recording creation order,
with legacy recordings explicitly marked. `n` loads older pages. Enter opens
the selected run; Esc returns to the list. Visible history refreshes in the
background every two seconds, retaining selection.

Metrics present the existing versioned counts and reported token/cost aggregates.
Unknown inputs stay unknown. A Pi estimate is not a provider invoice. Last report
timestamps use UTC. No elapsed-time, acceptance, rework, or comparison formulas
are introduced by this dashboard.

The SQLite history can lag live Pi execution. The dashboard cannot see unsent
adapter observations, infer closure from silence, evaluate gates or run agents.
Missing storage is an empty view; inspection does not initialize a database.

For scripts and linear output:

```bash
xper --no-tui
xper status --list --json --limit 50
xper status --list --json --after <nextCursor>
xper status --run <runId> --json
```

The list response is `{ "runs": [...], "nextCursor": "..." }`; a null cursor
marks the end. Limits range from 1 to 100. The cursor is opaque to consumers.
These local inspection additions do not change the existing JSONL bridge API.
