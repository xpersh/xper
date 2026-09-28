# XP-012: Judgment and explicit closure

- Status: `pending`
- Milestone: M3
- Entry dependency: XP-011.3
- Next slice: XP-012.1

## Outcome and boundary

Evaluate verified work independently, then apply an explicit verdict. This is a
task group: implement one slice per iteration under the
[iteration rules](README.md#iteration-rules-for-xp-011-onward).

Judge executes through `xper_delegate`, with fresh context and read-only tools.
Reuse the role runner, evidence references, persistence, and budget policy.
Pi owns verdict transitions; Rust records facts. A Judge report, an accepted
increment, and a closed run are distinct facts.

## XP-012.1 — Obtain a Judge report

- Status: `pending`
- Depends on: XP-011.3
- Example: when all planned increments verify, an explicit delegation returns
  an independent verdict with reasons; no closure or rework starts automatically.

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
- Example: `REWORK_IMPLEMENTATION` makes Driver eligible again;
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
