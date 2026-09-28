//! Resolve direct profile routes and freeze one model for each role.

use std::collections::{BTreeMap, BTreeSet};

use serde_json::Value;
use xper_application::events::{ModelSelection, RoutingSnapshot};

use crate::ConfigError;

/// Model capabilities reported by the configured harness.
#[derive(Clone, Debug)]
pub struct AvailableModel {
    /// Provider identifier reported by the harness.
    pub provider: String,
    /// Exact model identifier reported by the harness.
    pub model: String,
    /// Whether the model supports a non-off thinking setting.
    pub reasoning: bool,
}

/// Validate resolved selections against a catalog without assigning work.
pub fn validate_catalog(
    routing: &RoutingSnapshot,
    models: &[AvailableModel],
) -> Result<(), ConfigError> {
    for selection in routing.routes.values().flatten() {
        let model = models
            .iter()
            .find(|model| model.provider == selection.provider && model.model == selection.model)
            .ok_or_else(|| {
                ConfigError("configured model is not available in the adapter".into())
            })?;
        if selection.thinking != "off" && !model.reasoning {
            return Err(ConfigError(
                "configured thinking requires a reasoning model".into(),
            ));
        }
    }
    Ok(())
}

fn field<'a>(value: &'a Value, key: &str, owner: &str) -> Result<&'a str, ConfigError> {
    value
        .get(key)
        .and_then(Value::as_str)
        .filter(|text| !text.trim().is_empty())
        .ok_or_else(|| ConfigError(format!("{owner}.{key} must be a nonempty string")))
}

fn entry<'a>(root: &'a Value, section: &str, name: &str) -> Result<&'a Value, ConfigError> {
    root.get(section)
        .and_then(|section| section.get(name))
        .filter(|entry| entry.is_object())
        .ok_or_else(|| ConfigError(format!("unknown {section} entry: {name}")))
}

fn selection(
    value: &Value,
    context: &str,
    allowed: &BTreeSet<&str>,
) -> Result<ModelSelection, ConfigError> {
    if value
        .get("context")
        .is_some_and(|given| given.as_str() != Some(context))
    {
        return Err(ConfigError(format!("model context differs from {context}")));
    }
    let provider = field(value, "provider", "model")?;
    if !allowed.contains(provider) {
        return Err(ConfigError(format!(
            "provider {provider} is not allowed in context {context}"
        )));
    }
    let thinking = field(value, "thinking", "model")?;
    if !matches!(
        thinking,
        "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max"
    ) {
        return Err(ConfigError("invalid model thinking level".into()));
    }
    Ok(ModelSelection {
        context: context.into(),
        provider: provider.into(),
        model: field(value, "model", "model")?.into(),
        thinking: thinking.into(),
    })
}

/// Resolve direct role definitions in one profile and validate context policy.
pub fn resolve_profile(config: &Value, profile_name: &str) -> Result<RoutingSnapshot, ConfigError> {
    let profile = entry(config, "profiles", profile_name)?;
    let context_name = field(profile, "context", "profile")?;
    let context = entry(config, "contexts", context_name)?;
    let allowed = context
        .get("allowed_providers")
        .and_then(Value::as_array)
        .ok_or_else(|| ConfigError("context.allowed_providers must be a list".into()))?
        .iter()
        .map(|item| {
            item.as_str()
                .filter(|name| !name.is_empty())
                .ok_or_else(|| {
                    ConfigError("context.allowed_providers entries must be names".into())
                })
        })
        .collect::<Result<BTreeSet<_>, _>>()?;
    if allowed.is_empty() {
        return Err(ConfigError(
            "context.allowed_providers cannot be empty".into(),
        ));
    }
    let roles = profile
        .get("roles")
        .and_then(Value::as_object)
        .filter(|roles| !roles.is_empty())
        .ok_or_else(|| ConfigError("profile.roles must be a nonempty mapping".into()))?;
    let mut routes = BTreeMap::new();
    for (role, route) in roles {
        if role.trim().is_empty() || !route.is_object() {
            return Err(ConfigError(format!("invalid profile role {role}")));
        }
        routes.insert(
            role.clone(),
            vec![selection(route, context_name, &allowed)?],
        );
    }
    Ok(RoutingSnapshot {
        profile: profile_name.into(),
        context: context_name.into(),
        routes,
    })
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;

    fn configuration() -> Value {
        json!({
            "contexts": {
                "company": {"allowed_providers": ["openai"]},
                "personal": {"allowed_providers": ["ollama", "openrouter"]}
            },
            "profiles": {
                "work": {"context": "company", "roles": {
                    "discovery.explorer": {"provider": "openai", "model": "fast", "thinking": "low"}
                }},
                "personal": {"context": "personal", "roles": {
                    "discovery.explorer": {"provider": "openrouter", "model": "cheap", "thinking": "off"}
                }},
                "local": {"context": "personal", "roles": {
                    "discovery.explorer": {"provider": "ollama", "model": "local", "thinking": "medium"}
                }}
            }
        })
    }

    #[test]
    fn work_personal_and_local_resolve_one_model_per_role() {
        let config = configuration();
        let work = resolve_profile(&config, "work").unwrap();
        let personal = resolve_profile(&config, "personal").unwrap();
        let local = resolve_profile(&config, "local").unwrap();
        assert_eq!(work.routes["discovery.explorer"][0].provider, "openai");
        assert_eq!(
            personal.routes["discovery.explorer"][0].provider,
            "openrouter"
        );
        assert_eq!(local.routes["discovery.explorer"][0].model, "local");
        assert_eq!(local.routes["discovery.explorer"].len(), 1);
    }

    #[test]
    fn provider_must_be_allowed_in_the_context() {
        let mut config = configuration();
        config["profiles"]["local"]["roles"]["discovery.explorer"]["provider"] = json!("openai");
        assert!(
            resolve_profile(&config, "local")
                .unwrap_err()
                .to_string()
                .contains("not allowed")
        );
    }
}
