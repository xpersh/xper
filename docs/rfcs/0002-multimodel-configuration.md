# RFC 0002: Multimodel configuration and routing

- Status: superseded by XP-009
- Date: 2026-09-22
- Depends on: [RFC 0001](0001-product-and-workflow.md)

This RFC records an earlier design proposal. The implemented XP-009 route is
described in [Execution profiles and model routing](../routing.md): profiles
map roles directly to one model with one attempt per assignment,
and contexts enforce provider allowlists. Pi's current provider selection
cannot distinguish two subscriptions under one provider identifier, so the
credential isolation proposed below is not implemented.

[RFC 0006](0006-configuration-recording-and-adapter-workflows.md) establishes
the current ownership: Rust resolves configuration; the adapter chooses when
and how to execute roles and reports their effective model selections. Live
profile switching and automatic fallback below remain proposals.

## Summary

xper must allow each role and phase to use a different provider and model.
Configuration must be reproducible while separating personal, corporate, and
client credentials, endpoints, and policies.

The proposed solution separates four concepts:

| Concept | Question it answers |
| --- | --- |
| Context | Which identity and policy am I working under? |
| Model preset | How is a specific model executed? |
| Strategy | What kind of model does each role need? |
| Execution profile | Which combination do I want to activate now? |

The term `model preset` is used instead of `model profile` to avoid confusion
with a complete execution profile.

## Contexts as a security boundary

A context defines a boundary for:

- Credentials.
- Provider and model catalog.
- Allowed endpoints.
- Data classification.
- Fallback policy.
- Session and metrics storage.
- Telemetry and retention.

Examples:

- `personal`
- `company`
- `client-acme`
- `offline`

A fallback must never cross contexts implicitly. If a corporate model fails,
xper must not send code to a personal account or external provider. If no
valid fallback remains, the run is blocked.

## Configuration scopes

| Scope | Proposed location | Contents |
| --- | --- | --- |
| Global | `${XDG_CONFIG_HOME:-~/.config}/xper/config.yaml` | Contexts, personal presets, and defaults |
| Project | `.xper/config.yaml` | Shared workflow and requirements |
| Project-local | `.xper/config.local.yaml` | Private, unversioned overrides |
| Run | CLI or run manifest | Temporary overrides and experiments |

Precedence:

```text
CLI / run manifest
    |
    v
.xper/config.local.yaml
    |
    v
.xper/config.yaml
    |
    v
global configuration
    |
    v
xper defaults
```

API keys and tokens are not stored in these files. xper reuses Pi's credential
store, environment variables, or a secure store.

Pi uses `~/.pi/agent/settings.json`, `auth.json`, and `models.json` by default.
Its SDK allows model selection per session and separate credential and model
paths. This makes it possible to keep separate runtimes per context.

References:

- [Pi settings](https://pi.dev/docs/latest/settings)
- [Pi SDK](https://pi.dev/docs/latest/sdk)
- [Providers](https://pi.dev/docs/latest/providers)
- [Custom models](https://pi.dev/docs/latest/models)

## Model presets

A model preset identifies a reusable execution configuration:

```yaml
model_presets:
  local-coder:
    context: personal
    provider: ollama
    model: qwen-coder
    thinking: medium
    limits:
      max_cost_usd: 0
      timeout_seconds: 900
    fallback:
      - personal-cheap

  personal-cheap:
    context: personal
    provider: openrouter
    model: mimo
    thinking: low
    limits:
      max_cost_usd: 1.00

  company-sol:
    context: company
    provider: company-openai
    model: sol
    thinking: high
    limits:
      max_cost_usd: 3.00
```

The model names above are illustrative. Actual identifiers are resolved
against the catalog available when configuring or running xper.

A preset does not contain the role's prompt, tools, or permissions. Those
belong to the role or workflow policy. This separation allows changing the
model without changing the agent's responsibility.

## Lanes and strategies

A strategy maps roles to logical lanes rather than directly to providers:

```yaml
strategies:
  balanced:
    routing:
      discovery.explorer: fast
      define.product: reviewer
      design.designer: reviewer
      breakdown.planner: fast
      plan.planner: reviewer
      implementation.driver: coder
      implementation.navigator: reviewer
      verify.verifier: reviewer
      judgment_day.judge: judge
```

Each context binds those lanes to concrete presets:

The following examples are design proposals and are not the current
configuration format. See the implementation guide linked above.

```yaml
contexts:
  company:
    credential_store: company
    policy:
      allowed_providers:
        - company-openai
        - company-vllm
      forbid_external_fallbacks: true
      data_classification: confidential
    bindings:
      fast: company-fast
      coder: company-coder
      reviewer: company-reviewer
      judge: company-sol

  personal:
    credential_store: personal
    policy:
      allowed_providers:
        - ollama
        - openrouter
        - personal-openai
      forbid_external_fallbacks: false
    bindings:
      fast: personal-cheap
      coder: local-coder
      reviewer: personal-reviewer
      judge: personal-sol
```

This lets `balanced` preserve the same intent across environments:

```text
work     + implementation.driver -> company-coder
personal + implementation.driver -> local-coder
```

## Execution profiles

An execution profile is the unit the user normally selects:

```yaml
profiles:
  work:
    context: company
    strategy: balanced

  personal:
    context: personal
    strategy: balanced

  personal-local:
    context: personal
    strategy: local-first
```

Example usage:

```bash
xper profile activate work
pi
```

The profile will also be changeable from the session through an extension
command, such as `/xper profile use personal`. Final syntax will be settled
when designing the interactive interface.

## Resolution timing

The final binding is resolved immediately before creating the agent:

```text
/xper <objective> + active profile work
        |
        v
context company + strategy balanced
        |
        v
judgment_day.judge -> lane judge
        |
        v
company.bindings.judge -> company-sol
        |
        v
exact provider/model/thinking
        |
        v
child agent executed by the Pi adapter
```

The coordinator records the resolution in the run. The agent retains the
resolved model throughout the attempt. If a fallback is needed after starting,
xper creates a new attempt and records the handoff; it does not silently change
the model within the same execution.

## Conceptual CLI

Initialization:

```bash
xper init
xper init --global
```

Context, model, and profile management:

```bash
xper context create company
xper context create personal

xper model add company-sol --context company
xper model add local-coder --context personal

xper profile create work --context company --strategy balanced
xper profile create personal --context personal --strategy balanced

xper profile set work judgment_day.judge=company-sol
xper profile set personal implementation.driver=local-coder
```

Inspection and diagnostics:

```bash
xper models list
xper profile inspect work --resolved
xper config show --effective
xper doctor
```

Current `xper init` behavior follows
[RFC 0004's direct activation revision](0004-pi-integration.md#direct-workflow-activation-revision-2026-09-27):
it checks Pi compatibility, Pi settings, the adapter, and configuration before
creating missing xper configuration. Project initialization also ignores local
configuration in Git. It preserves existing files and does not install agent
packages or create a primary-agent definition.

The broader onboarding ideas in this RFC—discovering authenticated models,
creating contexts and presets, choosing strategies, and previewing routing—
remain future interactive features. They are not part of the current `init`.

`xper doctor` repeats preflight without modifying the system and distinguishes:

- `PASS`: the inspected Pi runtime, settings, adapter, or configuration is valid.
- `WARN`: preparation such as building the adapter or creating an xper
  configuration file remains; built-in configuration defaults can apply.
- `FAIL`: a required executable, supported version, or valid configuration
  is unavailable.

The supported Pi range and its validation limits are documented in
[RFC 0004](0004-pi-integration.md#doctor-and-compatibility). External
agent-manager package versions do not determine installation readiness.

Suggested initial strategy presets:

- `balanced`
- `quality-first`
- `cost-first`
- `local-first`
- `custom`

## Initial routing policy

The first version must be deterministic:

```text
profile + phase + role -> preset -> provider/model
```

Adaptive routing can be added later using constraints such as context window,
reasoning, cost, locality, or tool support. It must not be introduced until
decisions can be explained and reproduced.

Initial recommendation:

| Phase or role | Model type |
| --- | --- |
| Discovery | Fast and inexpensive |
| Define | Strong product reasoning |
| Design | High capability for risky changes |
| Breakdown / Plan | Balanced model |
| Implementation Driver | Local or inexpensive |
| Navigator | Different from Driver when feasible |
| Verify | Independent of the implementer |
| Judgment Day | The most reliable available model and a fresh context |
| Coordinator | Stable; need not be the most expensive |

## Enterprise configuration

An organization can distribute a policy without credentials:

```yaml
organization: acme

required_context:
  tags:
    - acme
    - confidential

policy:
  external_providers: forbidden
  judgment_day:
    minimum_reasoning: high
    independent_model: true
```

Each person locally binds those capabilities to authorized accounts and
endpoints. The repository knows the policy but not keys or private paths.

## Security and reproducibility invariants

- Secrets are not written to versionable configuration.
- Fallbacks remain within the context.
- The active context is fixed when a run starts.
- Each run retains a snapshot of its resolved configuration.
- Every CLI override is recorded.
- Models incompatible with required capabilities fail during preflight.
- A model change after starting creates a new attempt.
- Corporate configuration cannot silently fall back to a personal account.

## Open decisions

- Final format: YAML, JSON, or both.
- Naming and namespace conventions for shared presets.
- How to distribute corporate policies.
- Exact integration with Pi login and credentials.
- Cross-platform support for global paths.
- Capability schema for future adaptive routing.
