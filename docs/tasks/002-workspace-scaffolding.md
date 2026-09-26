# XP-002: Workspace scaffolding and quality gates

- Status: `done`
- Milestone: M1
- Dependencies: XP-001

## Goal

Create the minimum structure that enforces RFC 0005 boundaries without
implementing product behavior yet.

## Scope

- Create the Rust workspace and initial crates needed for M1.
- Create the `adapters/pi` TypeScript package.
- Separate domain, application, protocol, infrastructure, and binary.
- Configure formatting, lint, typecheck, and tests.
- Set up basic CI and reproducible caches.
- Add checks that prevent harness dependencies in the core.

## Deliverables

- A workspace that builds without the agreed warning classes.
- Documented development commands.
- A minimal test per crate and TypeScript package.
- A short ADR if the final layout differs from RFC 0005.

## Acceptance criteria

- A clean installation can run all checks.
- `xper-domain` does not depend on I/O, SQLite, CLI, or external SDKs.
- The Pi adapter depends only on the public protocol for access to the core.
- CI runs formatting, lint, typecheck, and tests.

## Out of scope

- Adding empty crates for every future component.
- Implementing the bridge or state machine.

## Result

- A Rust workspace with the six crates needed for M1 and a pinned toolchain.
- An npm workspace with `adapters/pi`, strict TypeScript, and pinned dependencies.
- Unified gates through `npm run check`: formatting, lint, dependency boundaries,
  typecheck, and tests.
- CI with Cargo/npm caches and the same set of local gates.
- A layout aligned with RFC 0005; no ADR was needed.
