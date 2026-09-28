# Assessment of nicobailon/pi-subagents

- Date: 2026-09-27
- Candidate: `pi-subagents`, by Nico Bailon
- Reviewed revision: [`d3464c528d5dce984ce729afc563571d9cd9c877`](https://github.com/nicobailon/pi-subagents/tree/d3464c528d5dce984ce729afc563571d9cd9c877)
- The reviewed checkout declares version `0.71.0`; conclusions apply to this
  revision, not an unspecified installed release.
- Verdict: the closest integration fit of the three candidates assessed so
  far. Prefer its structured delegation API for an xper integration spike,
  subject to fixing startup cancellation and validating a newer Pi baseline.
- Scope: source review, upstream tests, a native SDK synthetic-provider test,
  and additional cancellation probes. This assessment does not migrate xper
  or change its accepted runtime architecture.

## The useful difference

The canonical `pi-subagents/delegation` contract already describes one owned
foreground child. A request contains `requestId`, `ownerRunId`, `nodeId`, an
agent, task, cwd, model, thinking, timeout, and an explicit output kind.
Cancellation and terminal responses carry the same identity tuple.

This maps directly to xper's Attempt, Run, and Assignment. Unlike a generic
spawn API, xper does not need to reconstruct ownership from a newly allocated
agent ID or implement the package's timeout classification itself. The bridge
rejects concurrent attempts for the same logical node and suppresses duplicate
terminal replies. Terminal statuses distinguish completion, failure, timeout,
cancellation, interruption, and contract/budget/output errors.

The conversion deliberately sets `async: false`, `foregroundOnly: true`,
`clarify: false`, and `acceptance: false`. xper can keep its own gates without
adopting the candidate's workflow scripts, acceptance engine, missions, or
profile system. The package is broader internally than xper's current executor;
the reduction is in the integration code xper must maintain.

Sources: [delegation contract](https://github.com/nicobailon/pi-subagents/blob/d3464c528d5dce984ce729afc563571d9cd9c877/src/api/delegation.ts#L26),
[integration guide](https://github.com/nicobailon/pi-subagents/blob/d3464c528d5dce984ce729afc563571d9cd9c877/docs/extension-api.md#structured-delegation-api),
[request conversion](https://github.com/nicobailon/pi-subagents/blob/d3464c528d5dce984ce729afc563571d9cd9c877/src/slash/delegation-adapters.ts#L309).

## Comparison with the previous candidates

| Requirement | pi-open-agents 0.1.22 | tintinweb at e955e29c | nicobailon at d3464c5 |
| --- | --- | --- | --- |
| Generated specialist Markdown | Supported | Supported | Supported, including recursive agent directories |
| Documented integration for another extension | No suitable durable execution API demonstrated in XP-001 | Versioned spawn/stop/consume event bus | Structured owned-child delegation, plus separate async RPC |
| xper attempt correlation | Must be added around tool observations/execution | Map native ID to xper attempt | Caller supplies run/node/attempt identity directly |
| Terminal classification | Known false-success error/cancellation signals | Explicit native status; incomplete cancellation paths | Typed foreground terminal responses and timeout classification |
| Model provider policy | xper must validate | String resolution can fall back across providers | Qualified model selection retains the provider; aliases still require care |
| Startup cancellation | Known cancellation/success ambiguity | Reproduced prompt after cancellation | Reproduced prompt after cancellation, with a correct cancelled response |
| Cancel before request | Not established | Pre-aborted runner gap | Public bridge handles it without execution |
| Primary coordinator activation | Supported | Not provided | Not provided as a primary-agent loader |
| Pi baseline for xper | Prior probe used 0.85.1 | Selected compatibility tests passed on 0.85.1 | Declares pi-ai >=0.86.1; reviewed tests pin Pi 0.87.0 |

This is a comparison of assessed revisions and integration behavior, not a
claim that a larger test count proves higher quality. See the earlier
[Pi spike](001-pi-integration.md) and
[tintinweb assessment](002-pi-subagents-assessment.md).

## Generated agents and frozen profiles

Project `.pi/agents` definitions override lower-priority sources. Discovery
is recursive, so xper could own `.pi/agents/xper/` and generate one file per
specialist. Both `name` and `description` are required. A Discovery template
with an illustrative model identifier could be:

```markdown
---
name: xper-discovery-explorer
description: Investigate a task and produce a Discovery Brief
model: provider/exact-model-id
thinking: low
tools: read, bash
extensions: []
systemPromptMode: replace
inheritGlobalContext: false
inheritProjectContext: false
inheritSkills: false
---

Investigate the user's task and return a Discovery Brief with context,
evidence, risks, and open questions. Do not implement changes.
```

Generated files are configuration artifacts, not immutable routing policy.
Per-launch model selection has priority over provider/role settings, which in
turn have priority over Markdown defaults. xper should pass the frozen run's
model and thinking on each delegation. Agent discovery fingerprints files and
settings, so new launches observe edits. The parent prompt's advertised agent
catalog has a separate lifetime; `/reload` refreshes that catalog after external
edits.

An explicit qualified model does not silently change provider when unavailable.
The resolver still tolerates aliases, punctuation differences, and date suffixes,
so xper should use exact IDs and validate the resolved selection. A populated
catalog rejects unknown configured/explicit models; an empty catalog defers
resolution to Pi. The child factory resolves the model and passes it to
`createAgentSession`, retaining the parent's registered provider configuration.

Terminal responses expose the resolved launch model and thinking. This is not
independent proof of a provider's internal reasoning level: thinking is resolved
before session creation, rather than read back as an observed provider setting.

Sources: [agent format](https://github.com/nicobailon/pi-subagents/blob/d3464c528d5dce984ce729afc563571d9cd9c877/docs/agents.md),
[model precedence](https://github.com/nicobailon/pi-subagents/blob/d3464c528d5dce984ce729afc563571d9cd9c877/docs/models.md),
[provider-constrained resolution](https://github.com/nicobailon/pi-subagents/blob/d3464c528d5dce984ce729afc563571d9cd9c877/src/runs/shared/model-resolution.ts#L134),
[native session factory](https://github.com/nicobailon/pi-subagents/blob/d3464c528d5dce984ce729afc563571d9cd9c877/src/runs/shared/child-session.ts#L288).

## Lifecycle findings

### Improvements over the previous candidate

The structured bridge accepts a cancellation before the corresponding request,
remembers the exact tuple, and returns `cancelled` without executing it. This
behavior passed an additional probe. It also validates request shape, protects
active logical-node ownership, and deduplicates terminal replies.

The foreground runner checks provider errors and missing output. It has timeout
and abort handling with bounded result settlement. These are cooperative SDK
sessions in the parent process: a bounded terminal response is not an operating
system guarantee that an arbitrary blocked tool has been killed. Detached runs
have a separate process lifecycle, but they are not needed for the proposed
Discovery integration.

Sources: [pre-cancellation and ownership](https://github.com/nicobailon/pi-subagents/blob/d3464c528d5dce984ce729afc563571d9cd9c877/src/slash/prompt-template-bridge.ts#L253),
[timeout handling](https://github.com/nicobailon/pi-subagents/blob/d3464c528d5dce984ce729afc563571d9cd9c877/src/runs/foreground/execution.ts#L1197).

### Reproduced: cancellation during session creation can still dispatch a prompt

After awaiting child session creation, the foreground runner sees the abort,
calls `abortChild()`, and then calls `created.prompt()` unconditionally. Aborting
an idle Pi session does not suppress a later prompt: Pi's agent abort targets
the active run, while a new prompt creates its own controller.

Three additional synthetic probes exercised this boundary:

1. An already-aborted signal passed directly to `runSync` still invoked the
   child's prompt once: failed safety assertion.
2. A public cancellation emitted before its request returned one `cancelled`
   response with zero executions: passed.
3. A cancellation emitted during child creation returned `cancelled`, but
   dispatched the child's prompt once: failed safety assertion.

The third probe connects the real public bridge directly to the real foreground
runner through its injected execution seam, with the repository's scripted
child-session factory. It isolates the race; it does not exercise a complete
installed xper integration or send a request to a live model. The result state
remains cancelled, so this is unwanted execution after cancellation rather than
false success.

Source: [abort followed by prompt](https://github.com/nicobailon/pi-subagents/blob/d3464c528d5dce984ce729afc563571d9cd9c877/src/runs/foreground/execution.ts#L1387).

### Teardown is not durable delivery

The bridge promises at most one terminal reply, not a reply after every context
shutdown. Cleanup aborts running requests and clears ownership, suppressing late
responses. xper must dispose pending listeners on teardown and leave uncertain
durable attempts to its recovery rules. `interrupted` also needs an explicit
mapping: xper currently reserves that state for store recovery.

The tintinweb queued-cancellation/no-terminal-callback failure was not reproduced
on this foreground delegation path. Child session openings are serialized, and
cancellation during that wait is covered by the startup concern above.

Source: [bridge cleanup](https://github.com/nicobailon/pi-subagents/blob/d3464c528d5dce984ce729afc563571d9cd9c877/src/slash/prompt-template-bridge.ts#L408).

## Minimal xper integration

1. Profile activation validates and renders specialist Markdown definitions.
2. `delegateDiscovery` passes its already-known Run, Assignment, and Attempt IDs
   to the injected execution dependency.
3. That dependency subscribes before emitting the public delegation request,
   using `ownerRunId = runId`, `nodeId = assignmentId`, and
   `requestId = attemptId`, plus `context: "fresh"`, explicit model/thinking,
   timeout, and `result: { kind: "text" }`.
4. It converts xper's AbortSignal into the public cancellation event and maps
   the matching terminal response into xper's existing outcomes.
5. Brief writing, `attempt.finish`, advancement, evidence, and SQLite recovery
   remain in their current owners.

The request should use `intercomBridge: { mode: "off" }` unless an actual
supervisor integration is intentionally enabled. xper does not need the
candidate's separate async RPC, workflow scripts, missions, or profile generator
for this path.

The public delegation subpath exports types and event constants. Installing a
package through Pi does not automatically make it resolvable by a sibling
extension's Node imports. The documented event contract can be used directly;
an optional development dependency can provide types. No search for the active
package's internal runner is necessary.

The coordinator remains a separate integration responsibility. These Markdown
files define children, not `mode: primary`; removing `pi-open-agents` would
require xper's extension to apply the coordinator prompt itself. The candidate's
optional profile-based model switch is not a primary-agent loader.

The structured delegation payload has no version field, so pin the package and
test its public contract. The separate async RPC's capability handshake does
not certify the structured foreground API.

## Compatibility and verification

The package declares `@earendil-works/pi-ai >=0.86.1` and pins Pi `0.87.0` in
its development dependencies. xper's tested Pi is `0.85.1`. Adoption therefore
requires an explicit baseline upgrade and corresponding xper compatibility
validation; this assessment does not claim support on `0.85.1`.

Environment: macOS arm64, Node `26.8.1`, npm `11.19.0`, dependencies installed
only in a temporary clone with installation scripts disabled. Node differs
from xper's Node 24 target. Tests use isolated temporary state; live model
smokes were not enabled.

Verification results are recorded below and in local evidence:

- Typecheck against the candidate's locked Pi `0.87.0`: passed.
- Original unit suite and selected foreground/model integration tests:
  initial sandbox execution encountered process-inspection and local-socket
  restrictions. A synthetic subprocess probe failed its process-tree check in
  the sandbox and passed outside it; the affected suites were repeated with
  local process/socket access. The repeat produced:
  - Unit suite: 3,414 tests; 3,376 passed, 26 failed, 12 skipped.
  - Selected integration tests: 311 tests; 310 passed, 1 failed.
- Targeted diagnosis found that `PI_OFFLINE=1` disables npm discovery expected
  by six tests. The inherited PATH also selected a Node version-manager shim
  after the tests isolated HOME. A third issue was the macOS `/tmp` versus
  `/private/tmp` path spelling. Repeating all six affected unit files with the
  actual Node directory in PATH, offline mode unset, and canonical TMPDIR
  produced 189 tests: 187 passed, 1 failed, 1 skipped. The sole remaining
  npm-process timeout test passed on an isolated rerun (1 passed); its grouped
  failure lacked a PID file within its 500 ms startup deadline. The previously
  failing integration host command also passed (1 passed, about 5 seconds).
  These repeats resolve the observed environment failures and isolate one
  timing-sensitive test; they do not constitute a single green full-suite run.
- Native Pi `0.87.0` SDK test with a synthetic provider: the nested reviewer
  consumed its delegated results successfully (1 test passed).
- Additional lifecycle probes: 3 tests; 1 passed, 2 failed the expected
  no-prompt-after-cancellation assertions.

The selected integration files are `single-execution.part-1`,
`single-execution.part-2`, and `model-resolution-diagnostic`. The native SDK
test is `nested-async-wait`, using the installed candidate dependency as its
explicit native host. This is not the full upstream integration suite.

Local, unversioned evidence is retained in
`spikes/nicobailon-pi-subagents-assessment/`, including commands, logs, the
process-environment diagnostic, and the additional lifecycle probes. These
artifacts are not included in a clean clone. No upstream production source,
user Pi installation, xper runtime code, or xper dependencies were changed.

Before adoption: fix and verify startup cancellation, choose and test a new Pi
baseline with a reproducible test environment, then prove Discovery through
the structured delegation API while preserving xper's existing
success/failure/cancellation/timeout and recovery semantics. This is a bounded
adapter spike, not a rewrite of the Rust core.
