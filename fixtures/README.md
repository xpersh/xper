# Contract fixtures

Language-neutral protocol traces and golden messages belong here. Fixtures
must not contain credentials, prompts, or user source code.

`adapter-inspection-v1.json` contains synthetic requests, responses, empty results,
errors, and invalid messages for the Pi configuration inspection helper. Both
schema checks and adapter tests consume it; its model IDs are placeholders.

`protocol-v1.json` is read by Rust and TypeScript contract tests. Each case
contains a `message`; invalid envelopes also specify the expected `errorCode`.

`installations/valid`, `installations/partial`, and `installations/incompatible`
are synthetic installation snapshots used by the CLI integration tests. Valid
and partial installations need no agent-manager package or primary-agent
definition. The historically named `incompatible` fixture retains third-party
package metadata and agent definitions to verify that xper accepts and
preserves user-managed Pi resources. Version failures are supplied through a
fake Pi executable; every test uses an isolated home directory.

`knowledge-v1.json` contains synthetic Definition, Design, Story Map, Execution
Plan, and feedback artifacts. Pi workflow and fake-executor integration tests
consume these examples. The Rust core does not deserialize or validate knowledge
artifacts. Their input IDs are replaced by actual registered IDs during the
integration test. `npm run test:contracts` validates the fixture files against
the public schemas; protocol result fixtures can name a `resultSchema` to validate
method-specific response fields as well.
`implementation-v1.json` contains a host-observed implementation result with
the exact Git revisions, changed paths, test command exit code and criterion
evidence consumed by Verifier. It also includes an unchanged-revision revalidation
authorized by a Judge report, with fresh tests and empty changed paths.
`verification-v1.json` contains a verified host-constructed review plus rejected
reviews that request a Define or Design revisit. Every example is bound to its
Implementation artifact and exact commit and includes criterion and
regression/scope/simplicity evidence plus observed command output references.

`judgment-v1.json` contains a synthetic independent recommendation with sealed
artifact/log references and an exact evaluated revision. Schema and adapter tests
exercise all seven verdicts from this fixture, plus invalid evidence and coverage.
No verdict in this fixture represents an applied acceptance or run closure.

The Judgment fixtures also include structured debt and human questions alongside
legacy recommendations without those fields. `judgment-resolution-v1.json` contains
synthetic explicit human resolutions bound to report/Plan/revision identities. Shared
schema checks cover their shape; Pi tests additionally enforce exact source details,
reference membership, debt acceptance, persistence, replay and human-only command UI.
