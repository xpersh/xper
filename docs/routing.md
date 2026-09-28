# Execution profiles and model routing

Routing is optional. Without an active profile, the adapter keeps Pi's existing
model behavior. A profile assigns one provider and model directly to each role.
A context limits the providers that profile may use.

Example `.xper/config.yaml`:

```yaml
contexts:
  company:
    allowed_providers:
      - openai
  personal:
    allowed_providers:
      - ollama
      - openrouter
profiles:
  work:
    context: company
    roles:
      discovery.explorer:
        provider: openai
        model: example-fast
        thinking: low
  personal:
    context: personal
    roles:
      discovery.explorer:
        provider: openrouter
        model: example-cheap
        thinking: off
  local:
    context: personal
    roles:
      discovery.explorer:
        provider: ollama
        model: example-local
        thinking: medium
```

The model names are placeholders. One assignment starts one execution attempt.
A failure or timeout finishes the assignment; Pi's workflow does not retry or
change models automatically. Pi owns any recovery and uses the recorded model
selection when resuming an interrupted assignment. Opening the Rust store does
not mark attempts failed or start new attempts.

Activate or inspect a profile with:

```bash
xper profile activate local
xper profile inspect --resolved
```

Activation writes only the chosen name to `.xper/active-profile`. A `profile`
key in configuration acts as the default when there is no local activation.
Start a new Pi session after activation. At `/xper start`, the adapter queries
Pi's model catalog and calls `configuration.resolve`. Rust checks that configured
models are available and support their requested thinking levels. Pi freezes
the resolved route in its run checkpoint,
so later configuration changes do not alter it. Recorded attempt events preserve
the historical selections. A requested route and an observed model change are
different facts; do not rewrite older events when a profile changes.

Rust resolves role names supplied by configuration without knowing Pi's phase
sequence or selecting the next agent. Workflow settings currently stored under
`workflow.knowledge` pass through to Pi, which validates and applies them.
Live profile switching, adaptive selection, and automatic fallback are not
implemented by this refactor. See the
[ownership decision](rfcs/0006-configuration-recording-and-adapter-workflows.md).

Contexts enforce provider allowlists. They do not isolate credentials. The
adapter uses Pi's normal authentication and model configuration. Pi cannot
select between two subscriptions exposed under the same provider identifier,
so a `company` and `personal` context that both use `openai` may use the same
Pi credential. Use distinct provider identifiers if account separation is
required. xper configuration and events contain no API keys or tokens.
