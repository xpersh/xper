# Developing xper with agents

These instructions apply to the entire repository. Also read the local
instructions listed below before changing an area, even if your harness does
not automatically load `AGENTS.md` files from subdirectories.

## Before editing

1. Review `git status` and preserve existing changes outside your task.
2. Read the [README](README.md) to understand the product's current capabilities.
   The first vertical slice goes from Discovery to Define; the backlog does not
   necessarily describe implemented features.
3. Identify the responsibility affected by the change and read the relevant guides:

   | Area | Instructions and reference |
   | --- | --- |
   | Rust core and CLI (`crates/`) | [crates/AGENTS.md](crates/AGENTS.md) and [core architecture](docs/architecture.md) |
   | Pi adapter (`adapters/pi/`) and `.pi/` integration | [adapters/pi/AGENTS.md](adapters/pi/AGENTS.md) and [Pi architecture](adapters/pi/docs/architecture.md) |
   | Cross-process contract (`schemas/`, `fixtures/`, `xper-protocol`) | [Public protocol](schemas/README.md), [fixtures](fixtures/README.md), and the instructions for affected producers and consumers |
   | A backlog task | Its file in [docs/tasks/](docs/tasks/README.md), including status and acceptance criteria |

The architecture guides describe the current organization; the RFCs explain
the decisions and intended direction. If you find a discrepancy with the code,
point it out and resolve it within the scope of the change. Do not implement
future phases just because they appear in an RFC.

If `.codegraph/` exists, first use `codegraph_explore` or
`codegraph explore "<question or symbol>"` to locate or understand code.
Otherwise, use `rg`; do not generate an index as part of another task.

## Implementation rules

- Use English for repository documentation, agent instructions, code comments,
  user-facing messages, test descriptions, and new descriptive filenames.
  Preserve public identifiers and data whose exact content matters to a test.
  Conversation with the user can follow their preferred language.
- The core governs the workflow. Adapters access it through the public protocol
  and keep harness-specific details inside their own packages.
- Add behavior to the block responsible for it and use explicit dependencies.
  Do not introduce global containers, command buses, or empty modules to
  anticipate future needs.
- Keep each architecture check with its owner. A new adapter must have its own
  instructions, guide, and checks; if it is an npm workspace, define `boundaries`
  to participate in the aggregate command.
- When changing a public contract, review the schema, fixtures, Rust
  implementation, affected consumers, and compatibility tests together.
  Preserve error and version semantics or document their evolution.
- A deliberate change to boundaries must update the guide and its checks with
  a justification. Do not disable a rule to make code pass when it belongs in
  another module.
- Do not edit generated output (`target/`, `adapters/pi/dist/`, `node_modules/`)
  or use local `.xper/` state as a fixture. Tests must use synthetic data and
  isolated resources, without model credentials.

## Verification and delivery

Requirements and installation are covered in [Development](README.md#development).
Run all commands in these instructions from the repository root.

- During implementation, run tests for the affected behavior and the checks for
  its area. Add tests when changing observable behavior; a fix must cover the
  regression it addresses.
- Before delivering changes to code, dependencies, or build configuration, run
  `npm run check`: formatting, lint, architecture boundaries, typecheck, and
  tests. This is the set of checks run by CI.
- For documentation-only changes, check links, paths, commands, and
  `git diff --check`; there is no need to repeat the entire suite.
- Update documentation for responsibilities or contracts that change. When
  working on a backlog task, maintain its status and evidence according to its
  acceptance criteria.
- Review the final diff and explain what changed, why it belongs in those
  modules, and what you verified. State which checks you could not run and why;
  do not claim success without evidence.

`.pi/extensions/xper.ts` loads the Pi integration used by the product. These
`AGENTS.md` files provide instructions for developing this repository; they
serve different responsibilities.
