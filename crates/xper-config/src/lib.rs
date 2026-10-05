//! Scope resolution, loading, and validation for xper configuration.

use std::fs;
use std::path::{Path, PathBuf};

use serde_json::{Map, Value};

pub mod authoring;
mod routing;
pub use routing::{AvailableModel, resolve_profile, validate_catalog};

/// Stable package identity used by scaffold-level dependency smoke tests.
pub const PACKAGE_NAME: &str = env!("CARGO_PKG_NAME");

/// Minimal configuration; credentials belong to Pi or the environment.
pub const DEFAULT_CONFIG: &str = "harness:\n  adapter: pi\n";

/// Paths searched in increasing precedence.
#[derive(Debug, Clone)]
pub struct ScopePaths {
    /// User-wide configuration.
    pub global: PathBuf,
    /// Shared project configuration.
    pub project: PathBuf,
    /// Private project overrides.
    pub local: PathBuf,
}

impl ScopePaths {
    /// Resolve paths without creating directories.
    pub fn new(project_root: &Path, home: &Path, xdg_config_home: Option<&Path>) -> Self {
        let config_root = xdg_config_home
            .map(Path::to_path_buf)
            .unwrap_or_else(|| home.join(".config"));
        Self {
            global: config_root.join("xper/config.yaml"),
            project: project_root.join(".xper/config.yaml"),
            local: project_root.join(".xper/config.local.yaml"),
        }
    }
}

/// A parsing or validation error that never echoes configuration contents.
#[derive(Debug)]
pub struct ConfigError(pub String);

impl std::fmt::Display for ConfigError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.0)
    }
}
impl std::error::Error for ConfigError {}

/// Deep-merge mappings. Arrays and scalars from the higher scope replace lower values.
pub fn merge(base: &mut Value, higher: Value) {
    if let (Some(lower), Value::Object(upper)) = (base.as_object_mut(), &higher) {
        for (key, value) in upper {
            match lower.get_mut(key) {
                Some(existing) => merge(existing, value.clone()),
                None => {
                    lower.insert(key.clone(), value.clone());
                }
            }
        }
    } else {
        *base = higher;
    }
}

/// Read and merge existing scopes without changing files.
pub fn load_effective(paths: &ScopePaths) -> Result<Value, ConfigError> {
    let mut effective = parse(DEFAULT_CONFIG)?;
    for path in [&paths.global, &paths.project, &paths.local] {
        if let Some(config) = load_file(path)? {
            merge(&mut effective, config);
        }
    }
    validate(&effective)?;
    Ok(effective)
}

/// Read defaults and the global scope, without project or local overrides.
pub fn load_global(paths: &ScopePaths) -> Result<Value, ConfigError> {
    let mut effective = parse(DEFAULT_CONFIG)?;
    if let Some(config) = load_file(&paths.global)? {
        merge(&mut effective, config);
    }
    validate(&effective)?;
    Ok(effective)
}

/// Read a single YAML configuration if it exists.
pub fn load_file(path: &Path) -> Result<Option<Value>, ConfigError> {
    let source = match fs::read_to_string(path) {
        Ok(source) => source,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(error) => return Err(ConfigError(format!("{}: {error}", path.display()))),
    };
    let value =
        parse(&source).map_err(|error| ConfigError(format!("{}: {error}", path.display())))?;
    validate(&value).map_err(|error| ConfigError(format!("{}: {error}", path.display())))?;
    Ok(Some(value))
}

/// Parse the conservative YAML subset used by xper: indented mappings,
/// sequences, and scalars. JSON input is accepted. Unsupported syntax fails closed.
pub fn parse(source: &str) -> Result<Value, ConfigError> {
    if let Ok(value) = serde_json::from_str(source) {
        return Ok(value);
    }
    let mut lines = Vec::new();
    for (index, line) in source.lines().enumerate() {
        if line.contains('\t') {
            return Err(ConfigError(format!(
                "line {}: tabs are unsupported",
                index + 1
            )));
        }
        let content = strip_comment(line).trim();
        if content.is_empty() || content.starts_with('#') || content == "---" {
            continue;
        }
        if unsupported_syntax(content) {
            return Err(ConfigError(format!(
                "line {}: unsupported YAML syntax",
                index + 1
            )));
        }
        lines.push((
            line.len() - line.trim_start().len(),
            index + 1,
            content.to_owned(),
        ));
    }
    if lines.is_empty() {
        return Ok(Value::Object(Map::new()));
    }
    let mut cursor = 0;
    let value = parse_block(&lines, &mut cursor, lines[0].0)?;
    if cursor != lines.len() {
        return Err(ConfigError(format!(
            "line {}: invalid indentation",
            lines[cursor].1
        )));
    }
    Ok(value)
}

fn parse_block(
    lines: &[(usize, usize, String)],
    cursor: &mut usize,
    indent: usize,
) -> Result<Value, ConfigError> {
    let sequence = lines[*cursor].2.starts_with("- ");
    let mut object = Map::new();
    let mut array = Vec::new();
    while *cursor < lines.len() && lines[*cursor].0 == indent {
        let (_, number, content) = &lines[*cursor];
        if content.starts_with("- ") != sequence {
            return Err(ConfigError(format!(
                "line {number}: mixed mapping and sequence"
            )));
        }
        if sequence {
            let item = content[2..].trim();
            if item.is_empty() {
                *cursor += 1;
                array.push(nested(lines, cursor, indent)?);
            } else {
                array.push(scalar(item, *number)?);
                *cursor += 1;
            }
        } else {
            let (key, rest) = split_mapping(content)
                .ok_or_else(|| ConfigError(format!("line {number}: expected key: value")))?;
            let key = mapping_key(key.trim(), *number)?;
            if key.is_empty() || object.contains_key(&key) {
                return Err(ConfigError(format!(
                    "line {number}: empty or duplicate key"
                )));
            }
            let value = if rest.trim().is_empty() {
                *cursor += 1;
                nested(lines, cursor, indent)?
            } else {
                let value = scalar(rest.trim(), *number)?;
                *cursor += 1;
                value
            };
            object.insert(key, value);
        }
    }
    Ok(if sequence {
        Value::Array(array)
    } else {
        Value::Object(object)
    })
}

fn nested(
    lines: &[(usize, usize, String)],
    cursor: &mut usize,
    parent: usize,
) -> Result<Value, ConfigError> {
    if *cursor < lines.len() && lines[*cursor].0 > parent {
        parse_block(lines, cursor, lines[*cursor].0)
    } else {
        Ok(Value::Null)
    }
}

fn mapping_key(value: &str, number: usize) -> Result<String, ConfigError> {
    if value.starts_with(['"', '\'']) {
        return scalar(value, number)?
            .as_str()
            .map(str::to_owned)
            .ok_or_else(|| ConfigError(format!("line {number}: invalid mapping key")));
    }
    Ok(value.to_owned())
}

// Keep token decisions outside quoted strings. This is deliberately not a
// general YAML parser: anchors, tags and block scalars remain unsupported.
fn outside_quotes(value: &str) -> Vec<(usize, char)> {
    let mut quote = None;
    let mut result = Vec::new();
    let mut characters = value.char_indices().peekable();
    while let Some((offset, character)) = characters.next() {
        if (quote == Some('"') && character == '\\')
            || (quote == Some('\'')
                && character == '\''
                && characters.peek().is_some_and(|(_, next)| *next == '\''))
        {
            characters.next();
        } else if quote == Some(character) {
            quote = None;
        } else if quote.is_none()
            && matches!(character, '\'' | '"')
            && value[..offset].chars().next_back().is_none_or(|previous| {
                previous.is_whitespace() || matches!(previous, ':' | '[' | '{' | ',' | '-')
            })
        {
            quote = Some(character);
        } else if quote.is_none() {
            result.push((offset, character));
        }
    }
    result
}

fn strip_comment(value: &str) -> &str {
    for (offset, character) in outside_quotes(value) {
        if character == '#' && (offset == 0 || value[..offset].ends_with(char::is_whitespace)) {
            return &value[..offset];
        }
    }
    value
}

fn split_mapping(value: &str) -> Option<(&str, &str)> {
    outside_quotes(value)
        .into_iter()
        .find(|(_, character)| *character == ':')
        .map(|(offset, _)| (&value[..offset], &value[offset + 1..]))
}

fn unsupported_syntax(value: &str) -> bool {
    outside_quotes(value)
        .iter()
        .any(|(_, character)| matches!(character, '&' | '*' | '!' | '|' | '>'))
}

fn scalar(value: &str, number: usize) -> Result<Value, ConfigError> {
    let value = strip_comment(value).trim();
    if value.starts_with('"') {
        return serde_json::from_str(value)
            .map_err(|_| ConfigError(format!("line {number}: invalid quoted value")));
    }
    if value.starts_with('\'') {
        return value
            .strip_prefix('\'')
            .and_then(|v| v.strip_suffix('\''))
            .map(|v| Value::String(v.replace("''", "'")))
            .ok_or_else(|| ConfigError(format!("line {number}: invalid quoted value")));
    }
    if value.starts_with('[') || value.starts_with('{') {
        return serde_json::from_str(value)
            .map_err(|_| ConfigError(format!("line {number}: use JSON syntax for inline values")));
    }
    if (matches!(value, "true" | "false" | "null") || value.parse::<f64>().is_ok())
        && let Ok(parsed) = serde_json::from_str(value)
    {
        return Ok(parsed);
    }
    Ok(Value::String(value.to_owned()))
}

/// Validate known configuration shape and reject embedded credentials.
pub fn validate(value: &Value) -> Result<(), ConfigError> {
    let root = value
        .as_object()
        .ok_or_else(|| ConfigError("configuration must be a mapping".into()))?;
    reject_credentials(value)?;
    for key in ["harness", "adapters", "contexts", "profiles", "workflow"] {
        if root.get(key).is_some_and(|v| !v.is_object()) {
            return Err(ConfigError(format!("{key} must be a mapping")));
        }
    }
    if root.get("profile").is_some_and(|v| !v.is_string()) {
        return Err(ConfigError("profile must be a string".into()));
    }
    if value
        .pointer("/harness/adapter")
        .is_some_and(|v| !v.is_string())
    {
        return Err(ConfigError("harness.adapter must be a string".into()));
    }
    if value
        .pointer("/adapters/pi")
        .is_some_and(|v| !v.is_object())
    {
        return Err(ConfigError("adapters.pi must be a mapping".into()));
    }
    for key in ["contexts", "profiles"] {
        if root
            .get(key)
            .and_then(Value::as_object)
            .is_some_and(|entries| entries.values().any(|entry| !entry.is_object()))
        {
            return Err(ConfigError(format!("{key} entries must be mappings")));
        }
    }
    Ok(())
}

/// Reject credential-shaped keys without including their values in errors.
pub fn reject_credentials(value: &Value) -> Result<(), ConfigError> {
    match value {
        Value::Object(map) => {
            for (key, child) in map {
                let name = key.to_ascii_lowercase();
                if name.contains("secret")
                    || name.contains("password")
                    || name.contains("token")
                    || name.contains("api_key")
                    || name == "apikey"
                {
                    return Err(ConfigError("configuration contains a credential field; use Pi's credential store or the environment".into()));
                }
                reject_credentials(child)?;
            }
        }
        Value::Array(items) => {
            for item in items {
                reject_credentials(item)?;
            }
        }
        _ => {}
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn scopes_merge_maps_and_replace_arrays() {
        let mut base = parse("contexts:\n  work:\n    bindings:\n      fast: old\n      coder: old\nlist:\n  - old\n").unwrap();
        merge(
            &mut base,
            parse("contexts:\n  work:\n    bindings:\n      coder: new\nlist:\n  - new\n").unwrap(),
        );
        assert_eq!(base.pointer("/contexts/work/bindings/fast").unwrap(), "old");
        assert_eq!(
            base.pointer("/contexts/work/bindings/coder").unwrap(),
            "new"
        );
        assert_eq!(base.pointer("/list/0").unwrap(), "new");
    }

    #[test]
    fn credentials_are_rejected_without_echoing_values() {
        let error = validate(&parse("api_key: forbidden-value").unwrap()).unwrap_err();
        assert!(!error.to_string().contains("forbidden-value"));
    }

    #[test]
    fn fixture_local_scope_overrides_project_scope() {
        let root = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../fixtures/installations/valid");
        let paths = ScopePaths::new(&root, Path::new("/nonexistent-home"), None);
        let effective = load_effective(&paths).unwrap();
        assert_eq!(
            effective
                .pointer("/workflow/implementation/max_attempts")
                .unwrap(),
            5
        );
        assert_eq!(effective.pointer("/harness/adapter").unwrap(), "pi");
    }

    #[test]
    fn known_fields_reject_invalid_types() {
        let invalid = parse("adapters:\n  pi: invalid\n").unwrap();
        assert!(validate(&invalid).is_err());
    }

    #[test]
    fn adapter_workflow_configuration_is_opaque_to_the_core() {
        let adapter_policy = parse("workflow:\n  implementation:\n    max_attempts: 0\n").unwrap();
        assert!(validate(&adapter_policy).is_ok());
    }

    #[test]
    fn defaults_do_not_require_agent_packages_and_legacy_keys_remain_readable() {
        let defaults = parse(DEFAULT_CONFIG).unwrap();
        assert!(defaults.pointer("/adapters/pi/primary_agent").is_none());
        assert!(
            defaults
                .pointer("/adapters/pi/require_pi_open_agents")
                .is_none()
        );
        let legacy =
            parse("adapters:\n  pi:\n    primary_agent: xper\n    require_pi_open_agents: true\n")
                .unwrap();
        assert!(validate(&legacy).is_ok());
    }

    #[test]
    fn package_identity() {
        assert_eq!(PACKAGE_NAME, "xper-config");
        assert_eq!(xper_application::DOMAIN_PACKAGE_NAME, "xper-domain");
    }
}
