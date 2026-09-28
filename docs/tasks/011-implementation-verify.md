# XP-011: Sequential Implementation and Verify

- Status: `pending`
- Milestone: M3
- Entry dependency: XP-010
- Next slice: XP-011.1

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

## XP-011.1 — Execute one Driver assignment

- Status: `pending`
- Depends on: XP-010
- Example: after Plan, one delegation implements one increment and returns its
  local change and actual test result; the run remains open.

Consume the sealed Plan and select its first eligible Driver assignment. Supply
the criteria, accepted inputs, frozen model, and bounded execution time. Require
explicit local test commands; record actual exit status and output references,
the base and resulting local commit, and criterion evidence. Do not commit
unrelated files or push changes.

Acceptance:

- Knowledge continues through the same tool; no second public tool is needed.
- Validate the supported handoff before sealing a new Plan so an unsupported
  plan remains correctable in Knowledge. A historical unsupported Plan produces
  a local diagnostic without pretending delivery has started.
- A real temporary checkout and fake child prove the path; a model's claim
  cannot make a failing local test pass.
- Settlement and explicit retry reuse existing outcome/budget semantics.
  Recovery preserves interrupted work and never reruns a child automatically.
- Missing or unanswered Rust does not delay this new delegation path.

Stop here: no Navigator, Verifier, next increment, rotation, or run closure.

## XP-011.2 — Review and verify that increment

- Status: `pending`
- Depends on: XP-011.1
- Example: separate calls run Navigator, then Verifier; rejection makes Driver
  eligible for an explicit bounded retry.

Use fresh read-only Navigator and Verifier sessions for the exact Driver result.
Keep the same checkout exclusively assigned while reviewing. Record its revision
and detect changes to evaluated source; reviewers must not repair it. Host-owned
tests run serially, with output references readable from the review context.
Test commands that change evaluated source invalidate the evidence.

Acceptance:

- Navigator approval and independent Verify evidence identify the evaluated
  revision; every criterion has evidence and required local tests pass.
- Rejection records a cause and evidence, invalidates affected approvals, and
  permits Driver rework within existing attempt/time/cost limits.
- Cancellation, timeout, and interruption cannot advance a gate; retry does not
  refund budgets or reuse approvals for changed code.
- Successful Verify marks only the increment verified, not the run accepted.

Stop here: fixed pair identities; no Define/Design revisit, parallel work,
general workspace manager, or additional review tool.

## XP-011.3 — Deliver remaining increments sequentially

- Status: `pending`
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

- Configurable pair rotation, after evaluating the fixed pair loop.
- Concurrent increments, isolated workspace ownership, and dependency integration,
  as separately scoped work after sequential delivery is accepted.
- Selective reconciliation, after conservative invalidation demonstrates a need.
- Discovery fan-out/fan-in, as a separate future Knowledge change.
- Publication, debt acceptance, and closure belong to XP-012 or later work.

Do not build infrastructure for these items while implementing the slices above.
