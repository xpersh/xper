# XP-014: Packaging, compatibility, and initial release

- Status: `pending`
- Milestone: M4
- Dependencies: XP-006, XP-012, and XP-013

## Goal

Distribute xper reproducibly on macOS, Linux, and Windows, including the Rust
binary and Pi TypeScript adapter.

## Scope

- Define combined or coordinated packaging for the CLI, bridge, and adapter.
- Produce binaries for supported architectures.
- Pin the tested Pi and `pi-open-agents` compatibility matrix.
- Validate global and project installation.
- Implement upgrades, rollback, and incompatible-version diagnostics.
- Run cross-platform smoke tests.
- Publish checksums, a changelog, and security notes.

## Acceptance criteria

- A clean installation completes `xper doctor` on each supported platform.
- The adapter locates the binary without machine-specific paths.
- Incompatibility fails before starting a run.
- Uninstalling xper does not remove Pi configuration, metrics, or credentials.
- Release artifacts are reproducible and identified by version.

## Out of scope

- OpenCode, Claude Code, or Codex adapters.
- Automatic updates without consent.
