# XP-011: Sequential Implementation and Verify

- Status: `pending`
- Milestone: M3
- Entry dependency: XP-010
- Next slice: XP-011.4

## Outcome and boundary

Deliver verified increments through separately reviewable slices. This file is
a task group, not one implementation request. Follow the
[iteration rules](README.md#iteration-rules-for-xp-011-onward); start only the
next unfinished slice. The discarded broad implementation is not accepted
evidence or a dependency of this plan.

Keep `xper_delegate` as the execution tool. The main Pi agent decides when to
call it; the adapter selects and validates the available assignment. Completing
a role may evaluate its gate but never launches another role automatically.
Do not add `xper_deliver` or a separate activation command for each flow.

The delivery loop is **Implementer -> Verifier**. The Implementer changes code
and supplies tests/evidence; the Verifier independently checks behavior,
regressions, scope, and unnecessary complexity without repairing the result.
Use `implementation.driver` as the Implementer's public role ID and
`verify.verifier` for the Verifier.

Reuse the existing attempt lifecycle, frozen routing, budgets, artifacts, local
journal, and background recorder. Implementation and Verification retain their
own small typed transitions and definition identities under RFC 0007; do not
duplicate the surrounding runtime or expand the Knowledge phase enum. Extract
shared helpers only when two implemented paths actually need them.

These slices execute one role at a time in one existing, dedicated Git checkout
supplied for the run. The initial checkout must be clean; subsequent changes
must belong to the recorded attempt. Do not provision clones, worktrees, test
snapshots, process leases, or an integration scheduler. Reject overlapping
invocations. Interruption never authorizes taking a workspace from a surviving
child; ambiguous ownership remains paused for explicit recovery.

## XP-011.1 — Execute one Implementer assignment

- Status: `review`
- Depends on: XP-010
- Example: after Plan, one delegation implements one increment and returns its
  local change and actual test result; the run remains open.

Implementation note: extend the existing `xper_delegate`, Pi workflow controller,
attempt/budget policy, artifact evidence, journal, and child executor. A temporary
Git checkout with a fake child will prove that the host observes the resulting
commit and reruns the declared commands; pure reducer, migration, handoff, retry,
recovery, and unavailable-recorder tests will cover the workflow boundary.

Consume the sealed Plan and select its first eligible Implementer assignment. Supply
the criteria, accepted inputs, frozen model, and bounded execution time. Require
explicit local test commands; record actual exit status and output references,
the base and resulting local commit, and criterion evidence. Do not commit
unrelated files or push changes.

Acceptance:

- Knowledge continues through the same tool; no second public tool is needed.
- Reuse the existing Plan contract: one Implementer and one dependent Verifier
  per increment. Plans outside that contract remain inspectable and require
  replanning for execution; do not rewrite sealed evidence.
- Validate the supported handoff before sealing a new Plan so an unsupported
  plan remains correctable in Knowledge. A historical unsupported Plan produces
  a local diagnostic without pretending delivery has started.
- A real temporary checkout and fake child prove the path; a model's claim
  cannot make a failing local test pass.
- Settlement and explicit retry reuse existing outcome/budget semantics.
  Recovery preserves interrupted work and never reruns a child automatically.
- Missing or unanswered Rust does not delay this new delegation path.

Stop here: Verifier execution, subsequent increments, and run closure remain
later slices.

### Delivery evidence

- The existing `xper_delegate` now changes from a sealed Knowledge Plan to one
  `pi.implementation` v1 instance, selects the first eligible root Implementer,
  and stops with that increment implemented while the run remains open.
- The adapter reuses its controller, journal, outbox, artifact writer, routing,
  and global policy. New flow-specific code is limited to the pure Implementation
  reducer plus Git inspection, child execution, and host-test effects. No Rust
  workflow logic, protocol RPC, dependency, public tool, Verifier, scheduler,
  worktree manager, push, reset, or run closure was added.
- A real temporary checkout proves the child commit, base/result ancestry,
  changed files, serial host-run command and log capture. Regression cases cover
  nonzero exits despite a claimed success, dirty initial/final trees, missing or
  divergent commits, and tests that modify tracked source without cleanup.
- Reducer and controller tests cover definition identity, deterministic outcomes,
  frozen routing or Pi model, exact Plan-order handoff, cumulative run and
  assignment budgets, overlap, failed evidence, explicit interrupted retry,
  v1/v2-to-v3 migration, incompatible historical Plans, and recovery without
  automatic child execution.
- `npm run check` passes formatting, lint, architecture boundaries, strict
  TypeScript, 67 Rust tests, shared JSON Schema fixtures, and 141 adapter tests.
  `git diff --check` also passes.
- The final diff adds 1,554 production, 917 test, and 343 documentation/contract
  lines (2,814 total; 204 removed), above the roadmap's size alarm. This accepted
  slice includes its inseparable reducer, checkpoint migration, real Git gate,
  artifact contract, resilience tests, and documentation. Review should evaluate
  that scope explicitly; no behavior from XP-011.2 or later was pulled forward.

## XP-011.2 — Review and verify that increment

- Status: `review`
- Depends on: XP-011.1
- Example: the next explicit delegation runs Verifier; rejection makes the
  Implementer eligible for a bounded retry.

Implementation note: extend the existing `xper_delegate`, workflow controller,
attempt/budget policy, artifact writer, journal, Git inspection, and child
executor. A temporary checkout with a fake read-only child will prove that the
host reviews the exact implementation commit, reruns the Implementer's commands
before any additional Verifier commands, detects source mutation, and preserves
rejection evidence for an explicitly delegated rework instance.

Use one fresh read-only Verifier session for the exact implementation result.
Keep the same checkout exclusively assigned while verifying. Record its revision
and detect changes to evaluated source; the Verifier must not repair it. Host-owned
tests run serially, with output references readable from the review context.
Test commands that change evaluated source invalidate the evidence.

Acceptance:

- Independent Verify evidence identifies the evaluated revision; every criterion
  has evidence and required local tests pass. The same review checks regressions,
  unrequested scope, and unnecessary complexity.
- Rejection records a cause and evidence, invalidates affected approvals, and
  permits Implementer rework within existing attempt/time/cost limits.
- Cancellation, timeout, and interruption cannot advance a gate; retry does not
  refund budgets or reuse approvals for changed code.
- Successful Verify marks only the increment verified, not the run accepted.

Stop here: no Define/Design revisit, parallel work, general workspace manager,
or additional reviewer/tool.

### Delivery evidence

- The existing `xper_delegate` now advances only on explicit calls from the
  latest `pi.implementation` v1 instance to its dependent `pi.verification` v1
  instance. Verified completion marks only increment `s1`; no `run.finished`,
  later-increment scheduling, public tool, Rust workflow decision, or protocol
  method was added.
- Verification runs in a fresh Pi child with `read` and `bash`, binds the exact
  Implementation artifact/digest/base/result commit, reruns Implementation
  commands before deduplicated Verifier additions, records bounded host logs,
  and rejects agent/test mutation or `HEAD` drift without repairing the checkout.
- Rejection is preserved as a successful domain verdict with explicit cause,
  evidence, invalidation, and rework facts. An explicit next delegation creates
  a new Implementation instance on the rejected commit, retains both histories,
  freezes each role's model, and consumes cumulative assignment and run budgets.
- Checkpoint envelope format 4 retains ordered Implementation and Verification
  histories, migrates formats 1/2 and envelope 3 in memory, and validates unique
  instance/attempt/artifact identities plus run, Plan, digest, commit, and rework
  references. Recovery interrupts only active attempts and launches no child.
- The final diff updates 31 files with 3,174 additions and 185 removals across
  the adapter, tests, schema/fixture contracts,
  and documentation. No dependency or JSON-RPC contract changed.
- `npm run check` passes formatting, clippy/lint, architecture boundaries,
  strict TypeScript, 67 Rust tests, shared JSON Schema contracts, and 157 adapter
  tests. `git diff --check` also passes.

## XP-011.3 — Deliver remaining increments sequentially

- Status: `review`
- Depends on: XP-011.2
- Example: after increment A verifies, the next explicit delegation can start
  dependent increment B in the same checkout.

Select the next eligible assignment from explicit Plan dependencies. Independent
increments also run sequentially. Keep increment/flow/attempt identities separate
while sharing existing orchestration and persistence.

Acceptance:

- A two-increment fixture proves dependency order, separate evidence, and reload
  between increments. Pending work resumes only on explicit delegation.
- A failed prerequisite blocks dependents; verifying all increments makes the
  run eligible for Judgment Day without closing it.
- Run and assignment budgets remain cumulative across increments and retries.

Stop here: no concurrent dispatch, merge algorithm, workspace pool, or scheduler
optimization. Serial execution does not remove future instance boundaries.

### Delivery evidence

- The existing `xper_delegate` now resumes the single unfinished delivery
  frontier or selects the first pending Implementer in sealed Plan order whose
  explicit dependencies have verified artifact evidence. Independent increments
  use the same serial selection; no child starts during reload or verification.
- Later increments require the clean checkout at the unique latest verified
  commit, add direct dependency artifacts to their sealed inputs, and retain
  separate increment, workflow-instance, attempt, and artifact identities.
  Rejection and failed attempts keep the prerequisite as the only frontier.
- Remaining-Plan admission excludes satisfied assignments while global budgets
  still count every Knowledge, Implementation, and Verification attempt.
  Assignment budgets remain local to the planned role and cumulative across its
  retries and rework.
- Checkpoint envelope format 4 and both delivery definition versions remain
  unchanged. Recovery validates one pending frontier and one verified commit
  chain; all verified increments produce a Judgment Day readiness diagnostic
  without `run.finished`, a Judge flow, a new tool, or a protocol/schema change.
- Controller fixtures cover dependent and independent selection, two increments
  with reload between them, direct evidence, exact checkout revision, blocked
  prerequisites, tight cumulative budgets, and an unresponsive recorder.
- `npm run check` passes formatting, Clippy/Biome lint, architecture boundaries,
  strict TypeScript, 67 Rust tests, shared contract fixtures, and 161 adapter
  tests. `git diff --check` also passes. The final diff updates nine files with
  694 additions and 161 removals and adds no dependency or public contract.

## XP-011.4 — Return a concrete problem to Knowledge

- Status: `pending`
- Depends on: XP-011.3
- Example: Verify identifies an ambiguous criterion, records evidence, and
  returns control to Define before more implementation can be delegated.

Request a Define or Design revisit with the source attempt, increment, Plan
revision, reason, and evidence. Use Knowledge transitions to invalidate affected
accepted artifacts. A revised Plan requires an explicit resumption decision
identifying the checkout revision to continue from; no automatic Git reset,
cherry-pick, or merge is performed.

Acceptance:

- Persist feedback before the handoff; replay does not create duplicate visits.
- No implementation runs against a stale Plan. After resealing, conservatively
  invalidate prior increment approvals and require fresh evidence.
- Preserve old evidence and spent budgets. Interrupted revisits survive reload
  without executing an agent or waiting for Rust.

Stop here: no selective preservation of completed increments, simultaneous
feedback aggregation, or general reconciliation engine.

## Deferred work, not acceptance criteria for this group

- Concurrent increments, isolated workspace ownership, and dependency integration,
  as separately scoped work after sequential delivery is accepted.
- Selective reconciliation, after conservative invalidation demonstrates a need.
- Discovery fan-out/fan-in, as a separate future Knowledge change.
- Publication, debt acceptance, and closure belong to XP-012 or later work.

Do not build infrastructure for these items while implementing the slices above.
