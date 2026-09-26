# Working on the Pi adapter

Apply these instructions together with the [root AGENTS.md](../../AGENTS.md).
First read the [adapter architecture](docs/architecture.md), including its
diagram. These rules also guide changes to the checkout's `.pi/` integration.

## Where changes belong

- `src/extension.ts` composes dependencies and registers the extension.
- `src/pi/` translates Pi commands, tools, and hooks, presents results, and
  manages the session and observations.
- `src/actions/` coordinates an integration action with injected dependencies.
  It does not import Pi APIs, processes, files, or concrete bridge
  implementations. Test the action with doubles before connecting its entry point.
- `src/bridge/xper-client.ts` provides typed workflow operations and validates
  their responses. Add new public operations needed by the adapter here; do not
  make workflow RPC calls from other modules.
- `src/bridge/client.ts` handles transport, correlation, and the handshake;
  `src/bridge/protocol.ts` handles contract envelopes and errors.
- `src/discovery/` implements Pi execution and Brief writing. Keep these effects
  outside the action that coordinates them.

The core decides gates and transitions. Do not import crate internals or
reconstruct domain rules in TypeScript. A Pi observation does not replace an
attempt's recorded result.

Preserve the distinction between success, failure, cancellation, and timeout.
Publish an artifact path only after saving it, and do not overwrite existing
evidence. If a mutation fails at the transport layer, do not invent another
result or retry without knowing whether the core committed it.

## Verification

From the root:

```bash
npm run boundaries --workspace @xper/adapter-pi
npm run typecheck --workspace @xper/adapter-pi
npm run test --workspace @xper/adapter-pi
```

The test command builds the package. Action and client tests use doubles;
artifact tests use temporary directories. Integration tests require the checkout
and Rust toolchain, start the bridge, and simulate the Pi process without model
credentials. Preserve this separation when adding tests.

Do not edit `dist/`. For manual integration checks, follow the
[README](../../README.md#relationship-with-pi); a demo does not replace tests.
Before delivering code changes, also run `npm run check`.
