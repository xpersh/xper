# Assessment of tintinweb/pi-subagents

- Date: 2026-09-27
- Candidate: `@tintinweb/pi-subagents`
- Reviewed revision: [`e955e29c51b7a6cce37e1108cd2d6c57a77e151c`](https://github.com/tintinweb/pi-subagents/tree/e955e29c51b7a6cce37e1108cd2d6c57a77e151c)
- The reviewed checkout declares version `0.19.0`; this assessment covers that
  commit, not every build published under that version.
- Verdict: a better integration candidate than `pi-open-agents@0.1.22`, with
  concrete cancellation issues to resolve before replacing xper's executor.
- Scope: source review, upstream tests, and synthetic regression probes. This
  does not change xper's accepted architecture or install a Pi extension.

## Why this candidate matters

The material difference is a documented interface for other Pi extensions.
`pi-subagents` provides `spawn`, `stop`, `consume`, and `ping` requests over
`pi.events`, plus lifecycle events carrying the native agent ID and outcome.
An xper extension can call this interface without importing an internal runner
or locating another package's installation directory.

These calls stay inside the Pi process. The executor creates child sessions
through Pi's SDK, using `createAgentSession`; it does not launch one OS process
per agent. Sessions reuse the parent's model registry/runtime and authentication
context. This reduces process plumbing, but cancellation is cooperative and
xper loses the ability to terminate a separate executor process forcibly.

Sources: [RPC contract](https://github.com/tintinweb/pi-subagents/blob/e955e29c51b7a6cce37e1108cd2d6c57a77e151c/docs/rpc.md),
[request handlers](https://github.com/tintinweb/pi-subagents/blob/e955e29c51b7a6cce37e1108cd2d6c57a77e151c/src/cross-extension-rpc.ts#L97),
[session creation](https://github.com/tintinweb/pi-subagents/blob/e955e29c51b7a6cce37e1108cd2d6c57a77e151c/src/agent-runner.ts#L980).

## Fit for xper

| Requirement | Assessment |
| --- | --- |
| Generate specialist agents when activating a profile | Supported through Markdown frontmatter and body in `.pi/agents/*.md`. |
| Change definitions without restarting Pi | Both `Agent` and RPC spawning reload definitions before dispatch. Existing xper runs must retain their recorded selection. |
| Provider/model and thinking per role | Supported, but tolerant matching and inheritance require explicit validation for xper's deterministic routing. |
| Call the executor from `xper_delegate` | Supported through a documented event bus contract, with no dependency on package internals. |
| Correlate results to an xper Attempt | Possible by recording the returned native ID, preferably from `onSpawned`/`onQueued` before the spawn reply. |
| Distinguish ordinary provider failures | Explicit error status and `subagents:failed`; tested with a synthetic provider and real Pi sessions. |
| Reliable cancellation at every lifecycle point | Incomplete: startup cancellation can miss the first prompt; queued cancellation does not invoke the completion callback. |
| A wall-clock timeout | xper must own the deadline and remember whether it caused the abort. Abort acknowledgement does not prove that all execution has stopped. |
| Activate `xper` as the primary agent | Not provided. This package defines subagent types, not the `mode: primary` / `--agent xper` interface. |
| Preserve xper workflow and evidence | Keep the Rust core, Brief writer, Attempt lifecycle, and gates. The package's session records are not their replacement. |

## Generated agent definitions

The CLI could render each resolved role into a generated file. For example,
with an illustrative model identifier:

```markdown
---
name: xper-discovery
description: Investigate the task and produce a Discovery Brief
model: provider/exact-model-id
thinking: low
tools: read, bash
extensions: false
skills: false
prompt_mode: replace
---

Investigate the user's task and return a Discovery Brief with context,
evidence, risks, and open questions. Do not implement changes.
```

The format differs from `pi-open-agents`: tools are a list or CSV, not its
boolean map; `prompt_mode` replaces `systemPrompt`; `mode: primary` has no
equivalent here. Explicit tools, extensions, and skills preserve Discovery's
current execution scope. `prompt_mode: replace` suppresses workspace context
files in the child. A tools list containing `bash` is not a read-only sandbox.

Project `.pi/agents` takes precedence over `.agents/agents` and global agents.
The parser accepts model and thinking strings without validating them. The
CLI should therefore validate generated definitions before publishing them.

Sources: [discovery and parsing](https://github.com/tintinweb/pi-subagents/blob/e955e29c51b7a6cce37e1108cd2d6c57a77e151c/src/custom-agents.ts#L44),
[reload before RPC dispatch](https://github.com/tintinweb/pi-subagents/blob/e955e29c51b7a6cce37e1108cd2d6c57a77e151c/src/index.ts#L666).

## Model routing needs one precise adapter rule

The `Agent` tool and cross-extension RPC do not share identical precedence:

| Execution path | Behavior |
| --- | --- |
| `Agent` tool | Frontmatter model/thinking wins over caller parameters. Model strings use tolerant resolution. |
| RPC with explicit `model` and `thinkingLevel` | Caller options win over frontmatter. |
| RPC with an explicit model string | Resolves through fuzzy matching, including a fallback to another provider. |
| RPC relying only on frontmatter | Tries exact `provider/model`; an unavailable or unresolved model silently inherits the parent's model. |
| RPC with an exact registry Model object | Uses the supplied object and avoids string matching. xper must check exact identity and availability before passing it. |

Consequently, generated files alone do not enforce xper's provider allowlist
or frozen routing. The small execution adapter should resolve the core's exact
provider/model from Pi's available registry and pass that object plus
`thinkingLevel`. Unsupported thinking can be clamped by Pi; requested and
effective levels should not be conflated. Keep context policy in xper:
`scopeModels` is not equivalent because frontmatter and inherited selections
may only generate warnings.

This also allows a new profile to affect new runs while an existing run keeps
its recorded model. Role definitions themselves are reloaded, so freezing the
model is not a promise that edited prompts or permissions remain unchanged.

Sources: [tool precedence](https://github.com/tintinweb/pi-subagents/blob/e955e29c51b7a6cce37e1108cd2d6c57a77e151c/src/invocation-config.ts#L135),
[RPC normalization](https://github.com/tintinweb/pi-subagents/blob/e955e29c51b7a6cce37e1108cd2d6c57a77e151c/src/cross-extension-rpc.ts#L112),
[provider fallback](https://github.com/tintinweb/pi-subagents/blob/e955e29c51b7a6cce37e1108cd2d6c57a77e151c/src/model-resolver.ts#L101),
[parent inheritance](https://github.com/tintinweb/pi-subagents/blob/e955e29c51b7a6cce37e1108cd2d6c57a77e151c/src/agent-runner.ts#L364).

## Lifecycle findings

### Cancellation before the first prompt can be lost

The manager marks a pre-aborted run as `stopped` but still calls the runner.
The runner attaches its abort listener after asynchronous session startup, and
the listener helper does not check whether the signal is already aborted.
Cancellation before listener registration therefore does not reach the child.

Additional synthetic probes reproduce the gap with the real runner and a
simulated Pi session: a pre-aborted signal and cancellation during
`bindExtensions` both reach `session.prompt`. A probe using the real manager
and runner also observes `status: stopped` while the simulated prompt runs.
These probes do not call a live model or demonstrate a provider charge; they
demonstrate execution entering the prompt after cancellation.

Sources: [manager startup](https://github.com/tintinweb/pi-subagents/blob/e955e29c51b7a6cce37e1108cd2d6c57a77e151c/src/agent-manager.ts#L746),
[abort listener](https://github.com/tintinweb/pi-subagents/blob/e955e29c51b7a6cce37e1108cd2d6c57a77e151c/src/agent-runner.ts#L596),
[listener registration and prompt](https://github.com/tintinweb/pi-subagents/blob/e955e29c51b7a6cce37e1108cd2d6c57a77e151c/src/agent-runner.ts#L1097).

### A queued cancellation has no terminal callback

The queued branch of `abort` removes the entry, marks it `stopped`, and returns
without invoking `onComplete`. The extension emits terminal events from that
callback, so a client waiting only for `completed` or `failed` can remain
waiting. An additional real-manager probe reproduces a stopped queued record
with zero terminal callbacks. The source has a similar early return when cancellation happens
during worktree preparation. A successful `stop` reply acknowledges the stop
request; it is not a complete termination barrier.

Sources: [queued abort](https://github.com/tintinweb/pi-subagents/blob/e955e29c51b7a6cce37e1108cd2d6c57a77e151c/src/agent-manager.ts#L1407),
[terminal event emission](https://github.com/tintinweb/pi-subagents/blob/e955e29c51b7a6cce37e1108cd2d6c57a77e151c/src/index.ts#L575).

### Use native status and events, not generic tool success

Ordinary settled errors are explicitly classified. The runner inspects the
last assistant turn for provider errors, and manager completion preserves
`stopped`. However, the `Agent` tool still returns some failures as text with
`details.status: error`, rather than marking the generic Pi tool envelope as
failed. xper should consume the documented terminal status/event contract.
It should also inspect the status itself: `completed` can carry `steered`, not
only an ordinary successful completion.

Source: [Agent result handling](https://github.com/tintinweb/pi-subagents/blob/e955e29c51b7a6cce37e1108cd2d6c57a77e151c/src/index.ts#L2251).

## Minimum integration, after lifecycle fixes

1. Extend profile activation to generate specialist Markdown files owned by
   xper, using the validated effective configuration and role templates.
2. Replace the injected execution dependency in
   [delegateDiscovery](../../adapters/pi/src/actions/delegate-discovery.ts),
   leaving assignment creation, Brief writing, result recording, and phase
   advancement in their current modules.
3. Have that dependency probe the bus, subscribe before spawning, correlate
   the native ID, supply the exact model and thinking, and normalize outcomes.
   Emit `consume` synchronously when accepting a result to suppress the
   plugin's duplicate completion notification.
4. Keep the wall-clock deadline and reason for cancellation in the adapter.
   Verify cancellation before spawn, during startup, while queued, while
   running, and during shutdown before removing the current executor.
5. Move coordinator prompt activation into xper's Pi extension if removing
   `pi-open-agents` entirely. This is a small primary activation feature, but
   it is a separate requirement from generating specialist files.

For a focused integration, disable the candidate's `workflowsEnabled` and
`schedulingEnabled` features: xper already owns workflow decisions and this
assessment does not call for recurring jobs. Set `fallbackSubagent: "none"`
to reject an unresolved role. Avoid adopting its worktree or workflow engine
as part of this executor change. Package version pinning remains necessary:
the RPC version is `2`, but additive capabilities have shipped without a
protocol version increment.

## Verification

The assessment used a separate clone and temporary Pi state. Dependencies were
installed with scripts disabled. Live model tests were disabled; the suite's
end-to-end tests use synthetic providers. The user's Pi installation and xper
configuration were not changed.

Environment: macOS arm64, Node `26.8.1`, npm `11.19.0`. This differs from xper's
Node 24 development target; it is not a cross-platform certification.

| Check | Result |
| --- | --- |
| Upstream `npm run typecheck`, lockfile Pi `0.84.2` | Passed. |
| Full original upstream suite, Pi `0.84.2` | 105 files passed; 2,129 tests passed, 7 skipped. |
| `npm run typecheck` after changing only temporary Pi dependencies to `0.85.1` | Passed. |
| Targeted RPC, manager, model, parser, and real-session tests on Pi `0.85.1` | 9 files passed; 285 tests passed, 4 skipped. |
| Additional cancellation probes on Pi `0.85.1` | 4 tests fail their expected safety assertions: 3 demonstrate prompt dispatch after cancellation; 1 demonstrates no queued-cancellation terminal callback. |

The targeted compatibility run covers `cross-extension-rpc`,
`rpc-lifecycle-gating`, `agent-runner-e2e`, `subagent-error-status-e2e`,
`subagents-print-mode-e2e`, `isolated-provider.e2e`, `model-resolver`,
`custom-agents`, and `agent-manager`. It is not a complete xper integration
test. Windows, Linux, live credentials/providers, actual TUI interaction, and
hard cancellation of blocked tools were not tested.

Local unversioned evidence is retained under
`spikes/pi-subagents-assessment/`: command results, a reproduction test to
copy into the reviewed upstream checkout's `test/` directory, and test logs.
Like the original Pi spike, these local artifacts are not in a clean clone.

No xper runtime code or dependencies changed. Its full CI suite was therefore
not rerun for this documentation-only assessment.
