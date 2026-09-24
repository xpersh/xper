# Contract fixtures

Language-neutral protocol traces and golden messages belong here. Fixtures
must not contain credentials, prompts, or user source code.

`protocol-v1.json` is read by Rust and TypeScript contract tests. Each case
contains a `message`; invalid envelopes also specify the expected `errorCode`.
