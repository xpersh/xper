# Contract fixtures

Language-neutral protocol traces and golden messages belong here. Fixtures
must not contain credentials, prompts, or user source code.

`protocol-v1.json` is read by Rust and TypeScript contract tests. Each case
contains a `message`; invalid envelopes also specify the expected `errorCode`.

`installations/valid`, `installations/partial`, and `installations/incompatible`
are installation snapshots used by the CLI integration tests. They contain only
fake package metadata, agent definitions, and configuration; the tests supply a
fake Pi executable and isolated home directory.
