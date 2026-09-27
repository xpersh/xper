# Execution profiles and model routing

Routing is optional. Without an active profile, Discovery keeps Pi's existing
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
A failure or timeout finishes the assignment; xper does not retry or change
models automatically. If a running attempt is interrupted by store recovery,
the same assignment can be resumed with its recorded model selection.

Activate or inspect a profile with:

```bash
xper profile activate local
xper profile inspect --resolved
```

Activation writes only the chosen name to `.xper/active-profile`. A `profile`
key in configuration acts as the default when there is no local activation.
Start a new Pi session after activation. At `/xper start`, the adapter queries
Pi's model catalog, and the core checks that the configured model is available
and supports its requested thinking level. The run freezes the resolved route,
so later configuration changes do not alter it. `xper status --json` preserves
the selection in historical attempts.

Contexts enforce provider allowlists. They do not isolate credentials. The
adapter uses Pi's normal authentication and model configuration. Pi cannot
select between two subscriptions exposed under the same provider identifier,
so a `company` and `personal` context that both use `openai` may use the same
Pi credential. Use distinct provider identifiers if account separation is
required. xper configuration and events contain no API keys or tokens.
