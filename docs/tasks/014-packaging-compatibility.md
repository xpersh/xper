# XP-014: Distribution in tested stages

- Status: `pending`
- Milestone: M4
- Entry dependencies: XP-006 and the accepted executable slice through XP-010
- Next slice: XP-014.1

## Outcome and boundary

Distribute implemented capabilities, one verified scenario or platform at a time.
Packaging does not depend on Judgment Day or the complete metrics backlog.
Follow the [iteration rules](README.md#iteration-rules-for-xp-011-onward).

Reuse the npm adapter build, Rust build, `init`, `doctor`, and handshake.
Prefer a versioned archive and documented commands before an installer or release
framework. Building and testing artifacts does not itself publish a release.

## XP-014.1 — Produce one installable local artifact

- Status: `pending`
- Depends on: XP-006 and XP-010
- Example: build a bundle for the current macOS development host, install it in
  a clean temporary project, load the adapter, and pass `xper doctor`.

Record the exact architecture/toolchain in this slice's evidence. Include the
CLI/bridge binary, built adapter, version manifest, checksum, and minimal install
instructions. Make support claims only for the tested target.

Acceptance:

- Installation does not rely on source paths such as `target/debug`.
- The adapter finds the selected binary and records a synthetic run without
  model credentials or network publication.
- Versions and source/toolchain/lockfiles identify how to rebuild the artifact.
  Do not claim byte-identical builds without evidence.

Stop here: one target and project installation; no cross-platform release,
package-manager formulas, installers, or update daemon.

## XP-014.2 — Verify installation scope and compatibility

- Status: `pending`
- Depends on: XP-014.1
- Example: exercise project/global installation in isolated homes, including
  an incompatible recorder and an existing Pi configuration.

Acceptance:

- Repeated installation preserves unrelated Pi configuration and credentials.
- `doctor` gives actionable incompatibility diagnostics; the compatibility matrix
  contains only Pi/CLI/adapter combinations actually exercised.
- Failed recorder negotiation disables that connection and exposes degradation;
  local Pi execution and recovery remain available.
- Diagnose a locally incompatible adapter package at installation/loading.
  Optional Rust availability never becomes a workflow prerequisite.

Stop here: no new negotiation protocol without a demonstrated limitation of
the current contract.

## XP-014.3 — Support one Linux target

- Status: `pending`
- Depends on: XP-014.2
- Example: install and execute the same packaged smoke scenario on Linux.

Acceptance:

- Record the selected architecture; run build, clean installation, discovery,
  `doctor`, synthetic delegation, cancellation/recovery, and offline-recorder
  checks on that actual target.
- Fix observed platform differences in their owning modules; no speculative
  platform abstraction or extra CPU targets.
- Update the support matrix with evidence. Cross-compilation alone is insufficient;
  unavailable runtime verification remains explicitly pending.

## XP-014.4 — Support one Windows target

- Status: `pending`
- Depends on: XP-014.2
- Example: install and execute the same packaged smoke scenario on Windows.

Acceptance:

- Record the architecture and actual runtime checks used for the same scenarios
  as XP-014.3; do not infer process/path compatibility from a successful build.
- Scope changes to observed failures and preserve the supported host behavior.
  If process support requires a separate implementation slice, split it first.
- Update the matrix only with executed checks; do not bundle Linux support or
  multiple architectures into this iteration.

## XP-014.5 — Support upgrade, rollback, and removal

- Status: `pending`
- Depends on: XP-014.2; platform claims require the corresponding port evidence
- Example: upgrade a supported installed version and restore it without losing
  configuration or recorded history.

Acceptance:

- Test the supported version pair, backup behavior, and rollback procedure.
  Refuse unsafe local-state migrations before altering files.
- Removal preserves Pi configuration, credentials, history, and user artifacts;
  never delete shared directories to simplify cleanup.
- Prepare changelog, checksums, compatibility limitations, and security notes for
  release review. Registry/upload publication is a separate action.

## Deferred work

Extra CPU architectures, native installers, package-manager integrations,
release automation, byte-for-byte reproducibility, and automatic updates are
separate follow-ups. Other harness adapters remain outside this group.
