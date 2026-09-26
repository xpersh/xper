# XP-012: Judgment Day, rework, and closure

- Status: `pending`
- Milestone: M3
- Dependencies: XP-011

## Goal

Close a run with an adversarial, reproducible evaluation separate from the
implementation context.

## Scope

- Build the minimum context package for Judge.
- Run Judgment Day with an independent model and context when possible.
- Implement all verdicts defined in RFC 0001.
- Route rework to Implementation, Design, or Define.
- Request a human decision for ambiguity or irreversible actions.
- Generate a retrospective and close the run.

## Acceptance criteria

- Each acceptance criterion links to concrete evidence.
- Judge does not inherit the entire conversation by default.
- `ACCEPT_WITH_DEBT` records the debt, logical owner, and future condition.
- Verdicts produce deterministic, idempotent transitions.
- A closed run retains its snapshot, artifacts, metrics, and retrospective.

## Out of scope

- Automatic deployment or publication to production.
- Scoring human productivity.
