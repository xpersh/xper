# XP-012: Judgment and explicit closure

- Status: `review`
- Milestone: M3
- Entry dependency: XP-011.3
- Next slice: none; the group is ready for review

## Outcome and boundary

Evaluate verified work independently, then apply an explicit verdict. This is a
task group: implement one slice per iteration under the
[iteration rules](README.md#iteration-rules-for-xp-011-onward).

Judge executes through `xper_delegate`, with fresh context and read-only tools.
Reuse the role runner, evidence references, persistence, and budget policy.
Pi owns verdict transitions; Rust records facts. A Judge report, an accepted
increment, and a closed run are distinct facts.

## XP-012.1 — Obtain a Judge report

- Status: `review`
- Depends on: XP-011.3
- Example: when all planned increments verify, an explicit delegation returns
  an independent verdict with reasons; no closure or rework starts automatically.

Implementation note: replace the all-increments-verified readiness diagnostic
with one explicitly delegated, read-only Judge evaluation. Reuse the child role
runner, artifact writer, pure flow transitions, cumulative run budgets, checkpoint
and background outbox. A two-increment fixture and temporary Git checkout will
verify exact evidence, all seven recommendations, interrupted retry, and local
operation with an unavailable recorder. Judge consumes existing test evidence;
it cannot request or execute additional commands.

Provide intent, criteria, evaluated revision/diff reference, decisions, and
verification evidence without inheriting the full conversation. Use the
configured Judge route and report the actual model; do not add dynamic model
shopping or require a second provider when no such route is configured.

Acceptance:

- Each criterion and criticism references the exact evaluated evidence.
- Parse the RFC 0001 verdict vocabulary. Malformed output never becomes
  acceptance; store the recommendation without applying future policies.
- The evaluator cannot modify the result, publish it, or close the run.
- Interrupted evaluation requires explicit retry with frozen inputs.

Stop here: no debt workflow, human decision UI, or retrospective generation.

### Delivery evidence

- After the last planned increment verifies, an explicit `xper_delegate` now
  starts `pi.judgment` v1 instead of returning only the readiness diagnostic.
  Every valid RFC recommendation completes that flow while leaving the run open
  and the recommendation unapplied. Subsequent delegation cannot repeat it.
- The host freezes accepted Knowledge, current delivery artifacts, test-log
  digests, covered increments/criteria and the cumulative Git base/tip. A fresh
  Pi child receives the complete diff and only the `read` tool. Revision or
  evidence changes invalidate the attempt; an oversized diff fails explicitly.
- The existing runner, writer, cumulative run budgets, journal and background
  recorder are reused. Checkpoint format 6 preserves Judgment references and
  migrates older envelopes. Interrupted retries require the assignment ID and
  retain the model, inputs, revision and spent budgets. Requested routing and
  observed response models remain separate facts.
- Tests cover all seven recommendations, malformed output and citations, a
  two-increment handoff, reload, corrupted checkpoints, explicit frozen retries,
  budgets, configured/default routing, actual child flags and model observations,
  real temporary Git changes, and missing/rejecting/unanswered Rust.
- `npm run check` passes formatting, Clippy/Biome lint, 12 Pi architecture tests,
  strict TypeScript, 67 Rust tests, shared JSON Schema fixtures, and 203 adapter
  tests. `git diff --check` and changed documentation links also pass. Execution
  uses synthetic children and isolated checkouts, without model credentials.
- The final diff changes 50 files with 2,143 additions and 60 removals:
  940 production, 775 test, 279 contract, and 149 documentation/check additions.
  This exceeds the roadmap's size alarm; the requested
  slice includes its flow, checkpoint validation, evidence contract, execution
  and regression coverage. Review the complete change together. No later slice,
  new dependency, public command/tool, Rust workflow rule or JSON-RPC method is
  included. The new surfaces are `judgment-v1`, the Judge role, local projection
  fields, and checkpoint format 6.
- Applying recommendations, closure, feedback, debt/human decisions, additional
  tests requested by Judge, retrospectives and publication remain deferred.

## XP-012.2 — Apply acceptance or rejection and close

- Status: `review`
- Depends on: XP-012.1
- Example: explicitly applying an `ACCEPT` report records acceptance and closes
  the evaluated run; applying it again leaves the same result.

Implementation note: extend `/xper approve <reportId> <commit>` to validate and
apply the exact ACCEPT or REJECT report, persist a deterministic Markdown summary,
and close the run once. Reuse Judgment evidence checks, pure delivery coordination,
the artifact writer, serialized controller and checkpoint/outbox. Verify two
increments, stale evidence, replay after checkout changes, interrupted summary
writing, checkpoint migration and closure with unavailable recording.

Extend the existing command/approval path to apply a specific verdict artifact.
Initially handle `ACCEPT` and `REJECT`; other verdicts remain pending with an
unsupported-handling diagnostic. Produce a concise final summary from existing
artifacts and outcomes.

Acceptance:

- Changed evidence invalidates the decision. The user action identifies the
  exact report and revision rather than accepting whatever is latest.
- Acceptance/rejection and closure are explicit idempotent Pi transitions.
  Acceptance facts identify covered increments for later metrics.
- Local recovery preserves the decision and summary. Missing, rejecting, or
  unanswered Rust does not delay closure.
- The summary links criteria, decisions, evidence, and unresolved issues; it
  needs no extra model call, database, or memory subsystem.

Stop here: closure does not merge, push, deploy, or publish changes.

### Delivery evidence

- `/xper approve <reportId> <commit>` applies ACCEPT or REJECT after checking
  the exact report, frozen evidence and clean revision. Repetition returns the
  original closure and Markdown summary even after checkout changes. Other
  verdicts stay pending; existing Knowledge approvals remain available.
- Pure delivery coordination emits the applied decision, per-increment acceptance
  references for ACCEPT, and run closure. Runtime reuses evidence checks and the
  artifact writer; checkpoint format 7 and the existing journal/outbox preserve
  the decision and summary reference without awaiting Rust or invoking a model.
- `npm run check` passes: 67 Rust tests, 211 adapter tests, 12 architecture tests,
  shared schema fixtures, formatting, lint and strict types. New coverage includes
  two increments, stale evidence, interrupted summary writes, migration, replay,
  command compatibility, unavailable recording and real-bridge closure projection.
  Documentation links and `git diff --check` also pass.
- Diff size: 29 files, 988 additions and 104 removals (402 production,
  472 test and 114 documentation additions).
- Public changes: extended approve syntax, `applyJudgment`, closure/status types,
  recorded facts and checkpoint format 7. No dependency, RPC or Rust policy changes.
  Feedback, debt/human resolutions, reopening and publication remain deferred.

## XP-012.3 — Route Judge feedback through existing paths

- Status: `review`
- Depends on: XP-012.2 and XP-011.4
- Example: `REWORK_IMPLEMENTATION` makes the Implementer eligible again;
  `REVISIT_DESIGN` and `REDEFINE` use the Knowledge handoff.

Implementation note: extend explicit `/xper approve <reportId> <commit>` application
to reopen delivery or Knowledge using the existing pure coordination, evidence
checks, journal, outbox, and cumulative budgets. A Judge rework invalidates the
whole Plan's delivery approvals; explicit delegations create fresh Implementer
and Verifier evidence, permitting host-checked unchanged revisions only in this
authorized rework. Preserve historical judgments and idempotent decisions in
checkpoint format 8. Verify two-increment rework, both Knowledge destinations,
unchanged-revision revalidation, stale evidence, migration, recovery, exhausted
budgets, and unavailable recording before running the complete check suite.

Acceptance:

- Reuse XP-011 feedback, invalidation, budget, and explicit delegation behavior;
  do not introduce another scheduler or reconciliation mechanism.
- Preserve Judge evidence and the reason for reopening work. Stale approval
  cannot survive changes to the evaluated revision.
- Exhausted budgets expose an unresolved outcome without restarting the run,
  hiding attempts, or automatically repeating judgments.

### Delivery evidence

- `/xper approve <reportId> <commit>` now applies REWORK_IMPLEMENTATION,
  REVISIT_DESIGN and REDEFINE after the existing report, frozen evidence and clean
  checkout checks. Application and reopening share one local checkpoint commit;
  replay returns the historical decision without creating visits or executions.
- Judge rework invalidates all active delivery approvals, preserves the same Plan
  and starts fresh sequential Implementation/Verification from the evaluated tip.
  Fresh instances receive the Judge and prior evidence; only explicit delegation
  runs them. A later Judge retains the original cumulative diff base.
- Host-observed unchanged revisions require Judge authorization, fresh tests,
  criterion evidence and independent Verification. The additive `revalidationOf`
  variant retains compatibility with existing implementation-v1 artifacts.
  New rework instances use pi.implementation v2; historical v1 instances retain
  their original gate. Define/Design feedback reuses Knowledge transitions,
  invalidation and explicit revised-Plan resumption.
- Checkpoint format 8 preserves historical Judges, decisions and frozen Plan
  contexts. All attempts remain in cumulative budgets. Exhaustion exposes an
  unresolved open outcome; neither approval nor recovery executes another role.
  Rust remains background recording/configuration, with no new RPC or policy.
- `npm run check` passes 67 Rust tests, 221 adapter tests, 12 architecture tests,
  shared schema fixtures, formatting, lint and strict TypeScript. Coverage includes
  changed/unchanged two-increment delivery, repeated judgments, exact replay,
  both Knowledge destinations, interrupted retries, stale/corrupt evidence,
  migration, real Git and host tests, exhausted budgets, and unavailable,
  rejecting or unanswered recording. Documentation links and `git diff --check`
  pass. Tests use synthetic agents and isolated resources without credentials.
- Diff size: 1,479 additions and 170 removals across 61 files:
  739 production, 509 test, 59 contract, and 172 documentation additions.
  This exceeds the roadmap's scope alarms. The accepted plan includes delivery
  invalidation, historical Judge recovery and explicitly requested unchanged-
  revision revalidation. Review this complete slice together; no XP-012.4
  behavior is included.
- Public changes are the reopened `JudgmentApplied` result, status feedback and
  unresolved reason, optional rework authorization on Implementation handoffs,
  implementation-v1 revalidation, pi.implementation v2, and checkpoint format 8.
  No dependency, new command/tool, scheduler, workspace manager or Rust change
  was introduced. Debt/human decisions and publication remain deferred.

## XP-012.4 — Resolve debt and human decisions

- Status: `review`
- Depends on: XP-012.3
- Example: `ACCEPT_WITH_DEBT` stays pending until a human explicitly accepts
  the listed debt for the evaluated revision.

Implementation note: extend the existing approve command with a Pi dialog that
records an immutable human resolution of the exact report and revision. Accept
all listed debt together, or reuse closure and Implementation/Define/Design
feedback. Complete missing legacy details explicitly without changing reports.
Reuse artifact writing, pure delivery coordination, checkpoint/outbox and budgets;
verify cancellation, stale evidence, replay, interrupted writes, migration and
offline recording before the full check suite.

Acceptance:

- Record each debt's description, logical owner, and future condition. Apply
  decisions idempotently through the existing explicit approval surface.
- `HUMAN_DECISION` preserves the question and evidence until a recorded human
  resolution; the agent cannot silently approve on the user's behalf.
- Resolution uses the existing closure or feedback path. Unresolved debt or
  ambiguity never appears as unconditional acceptance.

### Delivery evidence

- The existing approve command now presents a human dialog for ACCEPT_WITH_DEBT
  and HUMAN_DECISION, with the exact report, revision, evidence, question and debt.
  A reason and final confirmation are mandatory; cancellation, incomplete input
  and missing UI preserve the pending recommendation. Delegation cannot approve.
- Structured debt records its description, logical owner and future condition.
  Acceptance covers the complete list and closes as `accepted_with_debt` with
  explicit acceptance facts. Human decisions also reuse rejection or existing
  Implementation/Design/Define feedback. Subsequent agents receive both the
  unchanged Judge report and the human resolution.
- Additive judgment-v1 details and the new judgment_resolution v1 artifact retain
  report/Plan/revision bindings and mark human-completed legacy fields. Checkpoint
  9 stores only decision metadata and artifact references; supported older formats
  migrate without changing history. The original recommendation remains distinct
  from the applied verdict. Interrupted writes resume only through explicit
  approval; conflicting or corrupted resolutions cannot replace a decision.
- `npm run check` passes formatting, lint, strict types, shared schema fixtures,
  12 architecture tests, 67 Rust tests and 232 adapter tests. Coverage includes
  every human outcome, multiple debts, legacy completion, stale evidence during
  dialogs, cancellation/headless operation, detached preflight context, replay,
  checkpoint and artifact corruption, interrupted resolution/summary writes,
  exhausted budgets, feedback across judgments and missing/rejecting/unanswered
  recording. The real bridge projects `accepted_with_debt` and human-resolved
  closure without workflow rules. Tests use synthetic agents and isolated
  resources without model credentials. Changed documentation links and
  `git diff --check` also pass.
- Diff size: 2134 additions and 169 removals across 49 files:
  912 production, 630 test, 421 contract/check, and 171 documentation additions.
  This exceeds the roadmap's scope alarms. The explicitly approved XP-012.4 plan
  includes both verdicts, the interactive dialog, legacy completion and immutable
  recovery evidence. Review the complete slice together; no subsequent feature
  is included.
- Public additions are `prepareJudgmentApproval`, optional human input to
  `applyJudgment`, resolution/status types, extensible recording facts, additive
  report fields, a resolution schema and checkpoint 9. No dependency, new command
  or tool, scheduler, workflow definition, Rust policy or JSON-RPC method changed.
  External debt tracking, retrospectives and publication remain deferred.

## Deferred work

Long-form retrospectives, reusable learning/memory, debt tracking integrations,
automatic publication, and human productivity scoring are outside these slices.
Do not implement them to complete the broad Learn / Close vision in RFC 0001.
