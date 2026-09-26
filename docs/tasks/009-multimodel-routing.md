# XP-009: Contexts, profiles, and multimodel routing

- Status: `pending`
- Milestone: M3
- Dependencies: XP-006 and XP-008

## Goal

Resolve each role's model deterministically without mixing identities,
credentials, or fallbacks across contexts.

## Scope

- Implement contexts, model presets, strategies, lanes, and execution profiles.
- Resolve `profile + phase + role -> provider/model/thinking`.
- Validate available models and capabilities through the adapter.
- Persist the effective snapshot for the run and each attempt.
- Create a new attempt when applying a fallback.
- Add profile activation and inspection commands.

## Acceptance criteria

- `work`, `personal`, and `local-first` configurations have isolated tests.
- A fallback never crosses contexts implicitly.
- Resolution is explainable through `xper profile inspect --resolved`.
- The adapter receives a neutral selection and translates it to the harness.
- Historical runs retain the exact provider, model, and thinking level.

## Out of scope

- Automatically learned adaptive routing.
- API key management or synchronization.
