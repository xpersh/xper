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
- Detect Pi, `pi-open-agents`, the adapter, versions, and conflicts.
- Create or repair the primary agent definition with confirmation.
- Show the installation command when a dependency is missing.
- Prevent silent installation in noninteractive mode.

## Acceptance criteria

- `doctor` does not modify files or packages.
- `PASS`, `WARN`, and `FAIL` checks have stable IDs.
- Missing Pi or `pi-open-agents` produces a concrete action.
- Running `init` twice is idempotent and preserves user changes.
- No secrets are written to configuration or logs.
- Fixtures exist for valid, partial, and incompatible installations.

## Out of scope

- Automatically authenticating providers.
- Executing a run or choosing models adaptively.

## Result

- `xper-config` resolves global, project, and local scopes with map merging,
  defined precedence, and validation of structure and credential fields.
- `xper init` and `xper init --global` create configuration, pin the tested Pi
  dependency, and create or repair the primary agent with confirmation. They
  preserve valid files and back up a repaired definition.
- `xper doctor` and `--json` emit checks with stable IDs for Pi, the dependency,
  adapter, conflicts, agent, and configuration without writing files.
- Fixtures and tests cover valid, partial, and incompatible installations,
  idempotency, read-only doctor behavior, and credential rejection.
