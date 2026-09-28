# XP-013: Incremental metrics and inspection

- Status: `pending`
- Milestone: M4
- Entry dependencies: existing recording/inspection from XP-007 and RFC 0006;
  adapter observations from XP-010
- Next slice: XP-013.1

## Outcome and boundary

Make recorded execution useful without recreating the recorder or waiting for
the complete workflow. Follow the
[iteration rules](README.md#iteration-rules-for-xp-011-onward).

Reuse SQLite, public paginated queries, `xper status`, and reported usage
aggregates. Earlier core-owned workflow descriptions are historical;
[RFC 0006](../rfcs/0006-configuration-recording-and-adapter-workflows.md) governs
ownership. Rust projects explicit facts and never infers gates, acceptance,
failure, or recovery from missing events. Metric errors cannot affect Pi.
Version formulas and preserve unknown inputs.

## XP-013.1 — Inspect time and usage for one run

- Status: `pending`
- Depends on: XP-010 and existing recording queries
- Example: inspect a run in text or JSON, distinguishing elapsed time, total
  agent time, reported cost, and missing measurements.

Add missing measurements to the existing CLI inspection path, without rebuilding
status, event storage, or transport. Limit this slice to run elapsed time,
summed settled-attempt time, and the existing usage aggregates.

Acceptance:

- Concurrent synthetic attempts do not inflate run elapsed time. Open intervals
  remain ongoing/incomplete rather than fabricated as settled.
- Unknown tokens/cost remain unknown; partial totals are labeled partial.
  Reservations and Pi estimates are not presented as provider invoices.
- Show the last recorded observation and known recording limitations. A remote
  reader cannot claim knowledge of unsent events or infer closure from silence.
- Versioned fixtures demonstrate formulas; existing CLI output stays compatible.

Stop here: no acceptance formulas, critical path, comparisons, TUI, or dashboard.

## XP-013.2 — Export one run safely

- Status: `pending`
- Depends on: XP-013.1
- Example: export one run for offline inspection without copying prompts, code,
  tool output, or opaque checkpoint contents.

Define a versioned allowlist over existing queries: identities, known outcomes,
metric provenance, reported definition/position metadata, and evidence
references. Raw `status --json` or arbitrary event payloads are not a safe
export contract.

Acceptance:

- A fixture with sensitive-looking opaque fields proves they are omitted;
  unknown future fields are excluded unless deliberately added to the contract.
- Pagination includes all available allowed records for the selected run.
  Export neither mutates nor resumes it.
- Missing definitions, unsupported versions, and incomplete records remain
  explicit without invented history.

Stop here: no content capture, redaction service, remote exporter, retention
manager, or export of artifact contents.

## XP-013.3 — Measure accepted increments

- Status: `pending`
- Depends on: XP-013.1 and XP-012.2
- Example: show time/cost per accepted increment; Verify success alone does not
  count as acceptance.

Acceptance:

- Specify units, intervals/denominators, required facts, and treatment of
  shared/unattributed cost before implementing these formulas.
- Use explicit acceptance and attribution; missing facts yield unknown/partial
  results. Rust does not derive acceptance from workflow phases.
- Fixtures cover duplicate event delivery, no accepted increments, and
  unallocated costs. Add missing producer facts as a separately scoped change.

Stop here: no rework ratios or remaining RFC 0003 metrics.

## XP-013.4 — Measure first-pass acceptance and rework

- Status: `pending`
- Depends on: XP-013.3 and XP-011.2
- Example: distinguish a recorded rework decision from an interrupted invocation
  that needed another attempt.

Acceptance:

- Define the counted unit and numerator/denominator, then version the formulas.
  Do not conflate verified assignments with accepted increments.
- Fixtures distinguish explicit rework, infrastructure retries, incomplete
  outcomes, zero denominators, and duplicate facts.
- Report unavailable semantics as unknown; add missing producer facts separately
  rather than inferring adapter policy in Rust.

## XP-013.5 — Compare two explicitly equivalent runs

- Status: `pending`
- Depends on: XP-013.2 and XP-013.4
- Example: compare runs with identical task, base revision, criteria, tools, and
  limits, showing their differing profile/model.

Acceptance:

- Require explicit equivalence metadata. Missing/different controls produce an
  explanatory non-comparable result rather than a ranking.
- Reuse versioned metrics, provenance, and missing-data limitations.
- Comparison does not execute experiments, launch agents, or cross contexts implicitly.

## Deferred work

Active/pause/human-wait intervals, provider/tool latency, percentiles, critical
path, retention/compaction, and experiment execution need separate tasks with
real producer evidence. Do not invent production events to unlock them.
Visual inspection belongs to XP-015; no separate Ratatui application or dashboard
is included here.
