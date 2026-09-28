# XP-006: Configuration, init, and doctor

- Status: `done`
- Milestone: M1
- Dependencies: XP-002 and XP-005

## Goal

Prepare and diagnose a reproducible installation without starting a workflow.

## Scope

- Implement global, project, and project-local scopes.
- Define configuration merge, precedence, and validation.
- Implement `xper init` and `xper init --global`.
- Implement `xper doctor` and `xper doctor --json`.
- Check Pi and adapter compatibility, Pi settings, and xper configuration.
- Prepare xper configuration without changing Pi packages or agents.
- Show the installation command when a dependency is missing.
- Prevent silent installation in noninteractive mode.

## Acceptance criteria

- `doctor` does not modify files or packages.
- `PASS`, `WARN`, and `FAIL` checks have stable IDs.
- Missing Pi or an unavailable adapter produces a concrete action.
- Running `init` twice is idempotent and preserves user changes.
- No secrets are written to configuration or logs.
- Fixtures exist for valid, partial, and incompatible installations.

## Out of scope

- Automatically authenticating providers.
- Executing a run or choosing models adaptively.

## Result

- `xper-config` resolves global, project, and local scopes with map merging,
  defined precedence, and validation of structure and credential fields.
- `xper init` and `xper init --global` create configuration after preflight
  succeeds, preserving valid existing files. Project initialization adds the
  local configuration path to `.gitignore`. They leave Pi packages, settings,
  and agent definitions untouched.
- `xper doctor` and `--json` emit checks with stable IDs for Pi, Pi settings,
  the adapter, and configuration without writing files.
- Fixtures and tests cover valid, partial, and incompatible installations,
  idempotency, read-only doctor behavior, credential rejection, and
  initialization without an agent-manager package.
- Pi version preflight accepts stable `0.85.1` through `0.87.1`, inclusive,
  for both `doctor` and `init`.
  CLI regression tests cover the bounds, intermediate versions, numeric
  ordering, malformed versions, and rejection without writes. Runtime evidence
  and its limits are recorded in the
  [Pi compatibility revision](../rfcs/0004-pi-integration.md#pi-compatibility-revision-2026-09-27).

## Dependency removal (2026-09-27)

The [direct activation revision](../rfcs/0004-pi-integration.md#direct-workflow-activation-revision-2026-09-27)
supersedes the original primary-agent installation criteria. Setup no longer
requires `pi-open-agents`, pins packages, rejects competing agent managers, or
creates and repairs primary-agent definitions. Existing user-managed Pi
resources remain untouched. `doctor` retains its report shape while retiring
checks specific to those removed requirements.
