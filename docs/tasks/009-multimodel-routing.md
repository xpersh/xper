# XP-009: Contexts, profiles, and multimodel routing

- Status: `done`
- Milestone: M3
- Dependencies: XP-006 and XP-008

## Goal

Resolve each role's model deterministically under a context's provider policy.

## Scope

- Implement provider-policy contexts and profiles with direct role routes.
- Resolve `profile + phase + role -> provider/model/thinking`.
- Validate available models and capabilities through the adapter.
- Persist the effective snapshot for the run and each attempt.
- Start one attempt with the selected model; preserve interrupted-attempt recovery.
- Add profile activation and inspection commands.

## Acceptance criteria

- `work`, `personal`, and `local` configurations have resolver tests.
- Provider policy prevents a profile from selecting a provider outside its context.
- Failures and timeouts settle the assignment without automatic retries or model changes.
- Resolution is explainable through `xper profile inspect --resolved`.
- The adapter receives a neutral selection and translates it to the harness.
- Historical runs retain the exact provider, model, and thinking level.

## Out of scope

- Automatically learned adaptive routing.
- API key management or synchronization.
- Separation of two Pi subscriptions using the same provider identifier.

## Evidence

- Config resolver tests cover direct `work`, `personal`, and `local`
  routes and provider policy.
- Application and bridge integration tests verify one attempt per failed
  assignment, frozen routes, and exact selections after SQLite reopen.
- Pi adapter tests verify model and thinking translation using Pi's shared
  configuration and single-attempt delegation.
- The example YAML in `docs/routing.md` resolves with
  `xper profile inspect local --resolved` and shows one selected model.
- `npm run check` passed: formatting, Clippy, Biome, architecture boundaries,
  typecheck, Rust tests, and 55 TypeScript tests.
