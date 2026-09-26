# XP-008: First end-to-end vertical slice

- Status: `done`
- Milestone: M2
- Dependencies: XP-003, XP-004, XP-005, XP-006, and XP-007

## Goal

Demonstrate the complete architecture with the smallest flow that provides
evidence: start a run, delegate Discovery, and advance to Define.

## Scope

- Start or resume a run from a Pi session with `xper` active.
- Create a `discovery.explorer` assignment.
- Resolve and launch a subagent through the path chosen in XP-001.
- Correlate the native lifecycle with an xper Attempt.
- Record a minimal Discovery Brief artifact.
- Evaluate the Discovery gate and request a transition to Define.
- Show state through `/xper status` and `xper status`.
- Persist the complete sequence in SQLite.

## Acceptance criteria

- There is a reproducible end-to-end test and a documented manual demo.
- Success, failure, cancellation, and timeout end in distinct states.
- Restarting the bridge allows the run to be recovered.
- The core contains no Pi imports or types.
- The transition does not happen without the required evidence.
- The timeline can be rebuilt solely from persisted events.

## Out of scope

- Other phases and advanced TUI features.
- Adaptive routing or profile comparisons.

## Implementation

- `/xper start <objective>` opens or resumes the run associated with that Pi
  session and persists `Intake -> Discovery` in a single transaction. Each new
  session can start an independent run. In different worktrees, each session
  uses its own `.xper/events.sqlite`; their runs remain separate even when
  they share a directory.
- The custom `xper_delegate` tool creates a `discovery.explorer` assignment and
  an Attempt. The adapter resolves that role and launches a child Pi process
  over RPC. It correlates the native `toolCallId` with xper's `attemptId` in
  observations; it does not derive the result from the `pi-open-agents`
  `subagent` tool. The child starts without a persistent session or the xper
  extension: the attempt belongs to the primary agent's run.
- The child's final result is written as a Discovery Brief in `.xper/artifacts/`.
  The event records only its reference. Success, failure, cancellation, and
  timeout are recorded as distinct outcomes; a crash leaves an `interrupted`
  attempt after the bridge lease expires (30 seconds plus the next check cycle)
  and allows a new attempt for the same assignment through the `assignmentId`
  parameter of `xper_delegate`.
- `run.advance` records the gate evaluation. It enters Define only when a
  nonempty Brief is linked to a successful attempt and assignment from the
  Discovery visit and all assignments in that visit have finished. Multiple
  `xper_delegate` calls can run concurrently, each with its own assignment and
  attempt. `/xper status` and `xper status --json` show the projection, and the
  CLI also exposes the timeline of persisted events.

SQLite serializes brief event writes, but bridges and subagents can work in
parallel. Each bridge maintains a periodically renewed lease; opening another
connection does not interrupt its attempts. After a crash, a second bridge
recovers attempts when the lease expires. A normal bridge shutdown releases
the lease immediately. If `events.sqlite` is locked or contains incompatible
history, the bridge returns the error instead of creating a separate volatile
database.

Schema migration v3 removes additional bindings created by the old `join`:
it preserves the first session associated with each run and does not modify
its event history. Unbound sessions can start their own runs.

## Manual demo

From this checkout, with Pi and a provider/model configured:

```bash
npm ci
npm run build --workspace @xper/adapter-pi
cargo build -p xper-cli
pi install -l npm:pi-open-agents@0.1.22
pi --approve --agent xper
```

In the Pi session:

```text
/xper start Explore the current state of this project
/xper advance
Use xper_delegate to inspect the project and produce a Discovery Brief.
/xper status
```

The first advance request should return `advanced: false`. After a successful
`xper_delegate` result, the tool requests advancement, and status should show
`phase define`. Outside Pi, from the same directory:

```bash
target/debug/xper status
target/debug/xper status --json
```

The JSON should contain an `artifact_registered`, a passing `gate_evaluated`,
and a `phase_entered` for Define. Restarting Pi or running `/reload` and querying
`/xper status` should retain the same run. The timeline contains only IDs,
states, and the Brief path; task text and child output are not stored in SQLite.

Two Pi sessions, preferably in separate worktrees, create isolated runs when
executing `/xper start <objective>`. Within a run, multiple `xper_delegate`
calls can execute concurrently; the gate waits for the last pending assignment
before entering Define. From each worktree,
`xper status --run <runId> --json` inspects a specific run.

## Reproducible verification

```bash
npm run check
```

The end-to-end test in `adapters/pi/src/__tests__/extension.test.ts` uses a
deterministic child Pi RPC process without credentials to cover the four
outcomes, the gate without evidence, recovery after restart, and the CLI.
Another test kills the bridge during an attempt, moves its lease expiry
forward, and verifies its `interrupted` state and retry. An additional test
opens two bridges against the same SQLite database, checks separate runs per
session, and concurrent delegations within one of them. `xper-store-sqlite`
tests rebuild projections from the log and verify transactional append.
