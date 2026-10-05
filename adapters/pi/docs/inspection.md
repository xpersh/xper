# Configuration inspection helper

`node adapters/pi/dist/inspection/cli.js` starts a child process owned by the
configuration screen. It exposes role descriptions and the Pi model catalog;
it does not create an xper workflow or connect to the Rust recorder.

The host resolves the built helper from the checkout's `adapters/pi` package or
`${PI_CODING_AGENT_DIR:-$HOME/.pi/agent}/npm/node_modules/@xper/adapter-pi`,
checking the package version. It runs Node with the target workspace as cwd,
inherits Pi's environment, and keeps stdin open until responses arrive.
Closing stdin, SIGINT, or SIGTERM cancels an outstanding Pi catalog process.
No resident server, socket, installation, or package discovery is performed.

## Version 1 contract

The [schema](../../../schemas/adapter-inspection-v1.schema.json) and
[synthetic fixtures](../../../fixtures/adapter-inspection-v1.json) define this
adapter-owned contract, separately from Rust's JSON-RPC service. Frames are
UTF-8 JSON followed by LF, limited to 1,048,576 bytes before LF. IDs are nonempty
strings of at most 256 UTF-8 bytes. Stdout contains only response frames.

Requests have `schemaVersion: 1`, `id`, `method`, and optional `params`:

| Method | Params | Result |
| --- | --- | --- |
| `describe` | Omitted or `{}` | `{adapter: "pi", version, roles: [{id, label, guidance}]}` |
| `models` | Omitted or `{}` | `{models: [{provider, model, reasoning}]}` |
| `search` | `{query, provider?}` | The matching model list in native fuzzy-match order |
| `refresh` | Omitted or `{}` | A newly loaded model list |

Success is `{schemaVersion: 1, id, result}`; failure is
`{schemaVersion: 1, id, error: {code, message}}`. An invalid or unavailable ID
is returned as null. Unknown versions, methods, fields, and invalid params fail
without calling Pi. Responses can arrive out of order; consumers correlate IDs
and discard search results superseded by newer input.

`describe` reads the eight role IDs and labels from Pi's workflow definitions.
Guidance follows RFC 0002 and is advisory: it neither assigns models nor imposes
a frontier capability, price, or separate-provider requirement. Profile routes
remain manual. A missing route in a prepared profile stops that role; it is not
a request to fall back to Pi's default model.

`models` and the first `search` load a snapshot through the existing
`pi --offline --list-models` integration (`XPER_PI_COMMAND` can override Pi).
Concurrent initial loads share one process. Queries filter that cached snapshot
by exact provider and use `fuzzyFilter` from `@earendil-works/pi-tui` 0.87.1 over
the provider and model ID. Empty queries return the provider-filtered snapshot.
Searching never starts another Pi process. Only explicit `refresh` replaces the
snapshot; a failed refresh returns its error and retains the previous snapshot.
Concurrent refreshes share the in-flight load. Existing cached searches remain
available during refresh.

The catalog distinguishes an empty result from `CATALOG_UNAVAILABLE`,
`CATALOG_TIMEOUT` (10 seconds), and `CATALOG_INVALID`. It never copies raw child
stderr, configuration, or credentials into responses. `INVALID_REQUEST`,
`UNSUPPORTED_VERSION`, `UNKNOWN_METHOD`, and `RESPONSE_TOO_LARGE` cover protocol
failures. The host keeps navigation available while loading or after failure.

Pi 0.87.1's list command uses an in-memory session and exits before
`session_start`, but it loads extension factories and custom providers and may
invoke project-trust hooks. Offline mode disables Pi's built-in startup network
operations; it does not sandbox third-party extensions or custom auth checks.
Catalog loading therefore retains normal Pi initialization semantics. The helper
exports only provider/model IDs and reasoning support; authentication stays in Pi.

The reasoning flag supports the current configuration validation: non-reasoning
models require `off`; the supported strings otherwise remain `off`, `minimal`,
`low`, `medium`, `high`, `xhigh`, and `max`. This catalog does not claim to know
per-model thinking-level subsets.
