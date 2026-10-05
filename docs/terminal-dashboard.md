# Terminal dashboard

Run `xper` in the project directory. The dashboard uses the current directory,
as existing xper commands do; it does not discover a different Git root.
Opening or browsing it does not create configuration or recording files.
All user-interface state and rendering belong to CLI infrastructure.

## Navigation

Home shows the effective profile, saved profile/context counts, and the latest
recording. Profiles manages model routing and activation. Settings manages
provider contexts. Status and Metrics share a project history and selected recording.

| Key | Action |
| --- | --- |
| Tab / Shift+Tab, 1–5 | Switch section |
| Arrows, j/k in lists | Move selection |
| Enter | Open detail, choose an item, or confirm the displayed action |
| Esc | Go back; keep or explicitly discard an unsaved draft |
| ? | Keyboard help |
| q | Quit, with an unsaved-draft choice |
| Ctrl+C | Interrupt and exit without saving the draft |
| r | Refresh recorded data or the Pi catalog |
| F5 in Profiles / Settings | Reload files, retaining draft edits for a fresh review |

Printable shortcuts become ordinary text in name and model-search fields.
Wide terminals show navigation and details alongside content. At 80 columns,
Enter opens details; at 60 columns one primary view remains. Below 48×12 a
resize message preserves the current draft and suspends actions except Ctrl+C.
`--ascii` avoids decorative Unicode;
`NO_COLOR` disables automatic colors while selection remains visible.

## Profiles

Open Profiles (`2`) to see every logical profile, its creation scope and any
higher-scope overrides. `ACTIVE` identifies the effective selection in this
project. A profile defined globally and adjusted locally appears once, with both
sources shown. Scoped selections are displayed separately from definition scopes.

Select a profile and press Enter for visible actions:

| Action | Result after review and confirmation |
| --- | --- |
| Activate profile | Select this name in Global, Project or Local configuration |
| Edit profile | Edit its context and role models in a chosen scope |
| Delete profile | Remove that scope's definition or override; inherited definitions may remain |
| Remove scoped activation | Remove that scope's selection and reveal the lower-precedence selection |

Activating a profile does not copy its models into another scope. Global applies
to all projects for this user, Project to the shared project configuration, and
Local to this private checkout. Precedence is Global < Project < Local. A profile
and its context must be available at the selected scope; a project-only profile
cannot be activated globally. Review shows the effective selection and any
higher-precedence masking before the destination's source diff.

The legacy `.xper/active-profile` override used by `xper profile activate` remains
compatible and takes priority over all scoped selections. When present it is
labelled explicitly. `u` on the profile list opens a separate confirmation to
remove it. Scoped activation never silently removes that override.

Start a new Pi session after changing selections or models. Pi prepares xper's
resolved profile in the background; check preparation before starting a run.
Existing runs retain their frozen model selections. Activating a profile changes
xper's routing selection, not Pi's authentication or the current chat model.

Global activation also reviews and registers Pi's global extension, linking the
built adapter and current xper executable by absolute path. Review shows these
paths before any write. `xper init --global` performs the same registration without
changing an existing profile selection; `xper doctor --global` checks it.
Pi settings and unrelated extensions are preserved. Custom or externally changed
registration files are never overwritten. The linked build must remain available;
rerun initialization from a new built checkout if those paths change.

Open Pi in another project and check `/xper status`: preparation should report
the resolved profile. The ordinary Pi model selector remains independent. Global
and project xper loaders share one registration per Pi runtime. Project/Local
activation continues to select the YAML scope and does not install another loader;
it can use the global integration or the checkout's existing extension. Removing
a scoped selection leaves the integration registered.

### Create or edit a profile

1. Press `n` in Profiles, choose the scope, then select a context. If needed,
   `n` in the context chooser creates one and selects its allowed providers.
2. Name the profile. Contexts limit providers; profiles assign models to roles.
3. Select a role and press Enter to search Pi's models. Type the query, use F4
   to filter provider, and Enter to choose an exact result. `a` explicitly applies
   a chosen model to all listed roles. `t` changes thinking; non-reasoning models
   permit only `off`. `c` chooses another context for this profile.
4. Press `v` to review the destination, changes and diagnostics. Enter saves;
   Esc returns to the draft. Saving returns to the profile list with the saved
   profile selected. Use its Activate action to choose where Pi should use it.

New guided profiles cover every adapter role. Existing partial profiles and
unknown roles remain intact. An absent route is labelled unconfigured: Pi stops
when that role is needed. Advice about frontier models, reasoning and independent
review is informational; xper does not rank or automatically assign models.

Editing an inherited value creates an override in the chosen scope. Delete on a
role removes only that scope's route override. Deleting a profile also removes a
matching selection in the same scope; other scopes and legacy overrides remain
explicit. Validation blocks deletion when it would leave unresolved references.

## Settings and contexts

Open Settings (`5`) to manage contexts directly, independently of profile creation.
Each context shows its origin and overrides. Enter opens Edit / Delete. `n`
creates a context: choose scope, name it, toggle allowed providers with Space,
then Enter reviews the context and Enter again saves it. Editing follows the
same review. Deleting a context is blocked while surviving profiles require it.
Credentials remain in Pi.

## Drafts and safe writes

The editor keeps unsaved changes in memory. Esc returns or offers to discard a
draft; cancellation never writes it. Switching to Status or Metrics preserves the
draft. Finish or discard it before switching between Profiles and Settings.

Unrelated settings, unknown roles and comments outside changed spans remain.
If a source cannot be parsed, choosing that scope offers an explicit replacement
draft; the original stays untouched until review and save. Alternatively, correct
the source externally and use F5 to reload while retaining draft edits.

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
Global activation validates both proposed changes before writing, then registers
Pi before saving the selection. These files do not share a transaction: if the
configuration write subsequently fails, the error reports that the integration
remains prepared and the profile was not saved. Reload and review to retry.

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
