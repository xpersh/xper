# XP-012: Judgment and explicit closure

- Status: `in_progress`
- Milestone: M3
- Entry dependency: XP-011.3
- Next slice: XP-012.2

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

- Status: `pending`
- Depends on: XP-012.1
- Example: explicitly applying an `ACCEPT` report records acceptance and closes
  the evaluated run; applying it again leaves the same result.

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

## XP-012.3 — Route Judge feedback through existing paths

- Status: `pending`
- Depends on: XP-012.2 and XP-011.4
- Example: `REWORK_IMPLEMENTATION` makes the Implementer eligible again;
  `REVISIT_DESIGN` and `REDEFINE` use the Knowledge handoff.

Acceptance:

- Reuse XP-011 feedback, invalidation, budget, and explicit delegation behavior;
  do not introduce another scheduler or reconciliation mechanism.
- Preserve Judge evidence and the reason for reopening work. Stale approval
  cannot survive changes to the evaluated revision.
- Exhausted budgets expose an unresolved outcome without restarting the run,
  hiding attempts, or automatically repeating judgments.

## XP-012.4 — Resolve debt and human decisions

- Status: `pending`
- Depends on: XP-012.3
- Example: `ACCEPT_WITH_DEBT` stays pending until a human explicitly accepts
  the listed debt for the evaluated revision.

Acceptance:

- Record each debt's description, logical owner, and future condition. Apply
  decisions idempotently through the existing explicit approval surface.
- `HUMAN_DECISION` preserves the question and evidence until a recorded human
  resolution; the agent cannot silently approve on the user's behalf.
- Resolution uses the existing closure or feedback path. Unresolved debt or
  ambiguity never appears as unconditional acceptance.

## Deferred work

Long-form retrospectives, reusable learning/memory, debt tracking integrations,
automatic publication, and human productivity scoring are outside these slices.
Do not implement them to complete the broad Learn / Close vision in RFC 0001.
