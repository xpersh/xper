# Contract fixtures

Language-neutral protocol traces and golden messages belong here. Fixtures
must not contain credentials, prompts, or user source code.

`protocol-v1.json` is read by Rust and TypeScript contract tests. Each case
contains a `message`; invalid envelopes also specify the expected `errorCode`.

`installations/valid`, `installations/partial`, and `installations/incompatible`
are synthetic installation snapshots used by the CLI integration tests. Valid
and partial installations need no agent-manager package or primary-agent
definition. The historically named `incompatible` fixture retains third-party
package metadata and agent definitions to verify that xper accepts and
preserves user-managed Pi resources. Version failures are supplied through a
fake Pi executable; every test uses an isolated home directory.
