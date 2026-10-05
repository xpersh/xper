# Execution profiles and model routing

Routing is optional. Without a prepared profile, the adapter keeps Pi's existing
model behavior. A profile assigns one provider and model directly to each role.
A context limits the providers that a resolved profile may use.

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

The dashboard selects a profile for a configuration scope by writing its name
to that file's `profile` key. Global selection applies across projects; project
selection is shared through `.xper/config.yaml`; local selection is private in
`.xper/config.local.yaml`. Local overrides project, which overrides global.
Removing a scope's selection restores the inherited choice without deleting
profile definitions. Review shows the final selection and any higher-priority
override before saving.

The selected profile and its context must exist in the destination scope or a
lower-precedence scope. For example, a project-only profile cannot be selected
globally. A global profile can be selected in the project or local scope without
copying its definition. Contexts enforce provider policy and are managed
separately from profile selection; neither operation configures Pi credentials.

The existing CLI can activate or inspect a profile with:

```bash
xper profile activate local
xper profile inspect --resolved
```

CLI activation retains its legacy behavior: it writes only the chosen name to
`.xper/active-profile`. This workspace override takes precedence over the YAML
`profile` key in every scope. Scoped dashboard saves preserve it and report its
effect. Explicitly clearing the legacy override returns to the merged YAML
selection; saving a different scoped selection does not clear it automatically.

Start a new Pi session after changing selection. The adapter prepares configuration in
the background using Pi's model catalog and `configuration.resolve`. Rust checks
that configured models are available and support their requested thinking levels.

`/xper start` never waits for that preparation or a Rust response. It freezes the
latest available prepared route and policy, or Pi defaults when none is ready,
and displays degraded preparation when appropriate. Check preparation status
before starting if a particular profile must be applied. Configuring a profile
on disk does not mean that a run started with defaults is using it. A late
response or later configuration change does not alter the active run.
Recorded attempt events preserve
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

Judge uses the role `judgment_day.judge` through the same direct routing contract.
A frozen profile must include that route before Judgment can dispatch; it may use
the same provider/model as other roles. Without a prepared profile, the first
Judge attempt freezes the active Pi model. Explicit retries preserve the original
selection, with no dynamic replacement or second-provider requirement.
