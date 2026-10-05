//! Source-preserving edits to xper's deliberately small configuration syntax.

use serde_json::{Map, Value};
use xper_application::configuration::ConfigurationChange;

use crate::{
    ConfigError, mapping_key, parse, resolve_profile, split_mapping, strip_comment, validate,
};

/// Validate authorable contexts and every effective profile without workflow policy.
pub fn validate_profiles(value: &Value) -> Result<(), ConfigError> {
    validate(value)?;
    if let Some(contexts) = value.get("contexts").and_then(Value::as_object) {
        for (name, context) in contexts {
            if name.trim().is_empty() {
                return Err(ConfigError("context name must not be empty".into()));
            }
            let providers = context.get("allowed_providers").and_then(Value::as_array);
            if !providers.is_some_and(|providers| {
                !providers.is_empty()
                    && providers.iter().all(|provider| {
                        provider
                            .as_str()
                            .is_some_and(|name| !name.trim().is_empty())
                    })
            }) {
                return Err(ConfigError(format!(
                    "context {name}: allowed_providers must be a nonempty list of names"
                )));
            }
        }
    }
    if let Some(profiles) = value.get("profiles").and_then(Value::as_object) {
        for name in profiles.keys() {
            if name.trim().is_empty() {
                return Err(ConfigError("profile name must not be empty".into()));
            }
            resolve_profile(value, name)?;
        }
    }
    if let Some(name) = value.get("profile").and_then(Value::as_str) {
        resolve_profile(value, name)?;
    }
    Ok(())
}

fn change_value(value: &mut Value, change: &ConfigurationChange) -> Result<(), ConfigError> {
    let path = match change {
        ConfigurationChange::Set { path, .. } | ConfigurationChange::Remove { path } => path,
    };
    if path.is_empty() {
        match change {
            ConfigurationChange::Set {
                value: replacement, ..
            } => *value = replacement.clone(),
            ConfigurationChange::Remove { .. } => {
                return Err(ConfigError(
                    "cannot remove the configuration document".into(),
                ));
            }
        }
        return Ok(());
    }
    let mut parent = value;
    for key in &path[..path.len() - 1] {
        let map = parent.as_object_mut().ok_or_else(|| {
            ConfigError("configuration edit traverses a non-mapping value".into())
        })?;
        if matches!(change, ConfigurationChange::Remove { .. }) && !map.contains_key(key) {
            return Ok(());
        }
        parent = map.entry(key).or_insert_with(|| Value::Object(Map::new()));
    }
    let map = parent
        .as_object_mut()
        .ok_or_else(|| ConfigError("configuration edit requires a mapping parent".into()))?;
    let key = path.last().expect("nonempty path");
    match change {
        ConfigurationChange::Set { value, .. } => {
            map.insert(key.clone(), value.clone());
        }
        ConfigurationChange::Remove { .. } => {
            map.remove(key);
        }
    }
    Ok(())
}

fn at_path<'a>(value: &'a Value, path: &[String]) -> Option<&'a Value> {
    path.iter().try_fold(value, |value, key| value.get(key))
}

fn key_text(key: &str) -> String {
    if !key.is_empty()
        && key
            .chars()
            .all(|c| c.is_alphanumeric() || matches!(c, '_' | '-' | '.'))
    {
        key.to_owned()
    } else {
        serde_json::to_string(key).expect("string serialization")
    }
}

fn render_node(key: &str, value: &Value, indent: usize) -> String {
    let prefix = " ".repeat(indent);
    let heading = format!("{prefix}{}:", key_text(key));
    match value {
        Value::Object(map) if !map.is_empty() => {
            let mut text = format!("{heading}\n");
            for (key, child) in map {
                text.push_str(&render_node(key, child, indent + 2));
            }
            text
        }
        Value::Array(items)
            if !items.is_empty()
                && items
                    .iter()
                    .all(|item| !item.is_object() && !item.is_array()) =>
        {
            let mut text = format!("{heading}\n");
            for item in items {
                text.push_str(&format!(
                    "{prefix}  - {}\n",
                    serde_json::to_string(item).expect("value serialization")
                ));
            }
            text
        }
        _ => format!(
            "{heading} {}\n",
            serde_json::to_string(value).expect("value serialization")
        ),
    }
}

fn render_document(value: &Value) -> Result<String, ConfigError> {
    let map = value
        .as_object()
        .ok_or_else(|| ConfigError("configuration must be a mapping".into()))?;
    if map.is_empty() {
        return Ok("{}\n".into());
    }
    Ok(map
        .iter()
        .map(|(key, value)| render_node(key, value, 0))
        .collect())
}

struct Span {
    path: Vec<String>,
    start: usize,
    end: usize,
    indent: usize,
    block: bool,
    comment: String,
}

fn spans(source: &str) -> Vec<Span> {
    let mut spans: Vec<Span> = Vec::new();
    let mut parents: Vec<usize> = Vec::new();
    let mut offset = 0;
    for (number, line) in source.split_inclusive('\n').enumerate() {
        let text = strip_comment(line).trim();
        if text.is_empty() || text == "---" {
            offset += line.len();
            continue;
        }
        let indent = line.len() - line.trim_start().len();
        while parents
            .last()
            .is_some_and(|index| spans[*index].indent >= indent)
        {
            parents.pop();
        }
        for index in &parents {
            spans[*index].end = offset + line.len();
        }
        if !text.starts_with("- ")
            && let Some((key, rest)) = split_mapping(text)
            && let Ok(key) = mapping_key(key.trim(), number + 1)
        {
            let mut path = parents
                .last()
                .map_or_else(Vec::new, |index| spans[*index].path.clone());
            path.push(key);
            let without_comment = strip_comment(line);
            spans.push(Span {
                path,
                start: offset,
                end: offset + line.len(),
                indent,
                block: rest.trim().is_empty(),
                comment: line[without_comment.len()..].trim_end().to_owned(),
            });
            parents.push(spans.len() - 1);
        }
        offset += line.len();
    }
    spans
}

fn with_comment(mut replacement: String, comment: &str) -> String {
    if !comment.is_empty() {
        let offset = replacement.find('\n').unwrap_or(replacement.len());
        replacement.insert_str(offset, &format!(" {comment}"));
    }
    replacement
}

fn edit_one(source: &str, change: &ConfigurationChange) -> Result<String, ConfigError> {
    let path = match change {
        ConfigurationChange::Set { path, .. } | ConfigurationChange::Remove { path } => path,
    };
    if path.is_empty()
        && let ConfigurationChange::Set { value, .. } = change
    {
        validate(value)?;
        return render_document(value);
    }
    let before = parse(source)?;
    let mut after = before.clone();
    change_value(&mut after, change)?;
    validate(&after)?;
    if before == after {
        return Ok(source.to_owned());
    }
    if serde_json::from_str::<Value>(source).is_ok() {
        return serde_json::to_string_pretty(&after)
            .map(|text| format!("{text}\n"))
            .map_err(|_| ConfigError("cannot serialize configuration".into()));
    }
    let nodes = spans(source);
    let mut output = source.to_owned();
    if matches!(change, ConfigurationChange::Remove { .. })
        && path.len() > 1
        && let Some(parent) = nodes
            .iter()
            .find(|node| node.path == path[..path.len() - 1])
        && at_path(&after, &parent.path)
            .is_some_and(|value| value.as_object().is_some_and(Map::is_empty))
    {
        let replacement = with_comment(
            render_node(
                parent.path.last().expect("nonempty path"),
                at_path(&after, &parent.path).expect("existing parent"),
                parent.indent,
            ),
            &parent.comment,
        );
        output.replace_range(parent.start..parent.end, &replacement);
        if parse(&output)? != after {
            return Err(ConfigError(
                "configuration edit could not preserve the document".into(),
            ));
        }
        return Ok(output);
    }
    if let Some(node) = nodes.iter().find(|node| node.path == *path) {
        let replacement = at_path(&after, path).map_or_else(String::new, |value| {
            with_comment(
                render_node(path.last().expect("nonempty path"), value, node.indent),
                &node.comment,
            )
        });
        output.replace_range(node.start..node.end, &replacement);
    } else if let Some(parent) = nodes
        .iter()
        .rev()
        .find(|node| path.starts_with(&node.path) && node.path.len() < path.len())
    {
        if parent.block && at_path(&before, &parent.path).is_some_and(Value::is_object) {
            let child_path = &path[..parent.path.len() + 1];
            if let Some(value) = at_path(&after, child_path) {
                let mut text = render_node(
                    child_path.last().expect("nonempty path"),
                    value,
                    parent.indent + 2,
                );
                if !output[..parent.end].ends_with('\n') {
                    text.insert(0, '\n');
                }
                output.insert_str(parent.end, &text);
            }
        } else {
            let replacement = with_comment(
                render_node(
                    parent.path.last().expect("nonempty path"),
                    at_path(&after, &parent.path).expect("changed parent"),
                    parent.indent,
                ),
                &parent.comment,
            );
            output.replace_range(parent.start..parent.end, &replacement);
        }
    } else if let Some(key) = path.first()
        && let Some(value) = after.get(key)
    {
        if !output.is_empty() && !output.ends_with('\n') {
            output.push('\n');
        }
        output.push_str(&render_node(
            key,
            value,
            nodes.first().map_or(0, |node| node.indent),
        ));
    }
    if parse(&output)? != after {
        return Err(ConfigError(
            "configuration edit could not preserve the document; no file was changed".into(),
        ));
    }
    Ok(output)
}

/// Apply precise mapping edits, preserving source outside changed nodes.
/// Invalid input can only be repaired by an explicit whole-document replacement.
pub fn edit_source(source: &str, changes: &[ConfigurationChange]) -> Result<String, ConfigError> {
    let mut result = source.to_owned();
    for change in changes {
        result = edit_one(&result, change)?;
    }
    validate(&parse(&result)?)?;
    Ok(result)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn set(path: &[&str], value: Value) -> ConfigurationChange {
        ConfigurationChange::Set {
            path: path.iter().map(|key| (*key).into()).collect(),
            value,
        }
    }

    #[test]
    fn precise_edits_preserve_unrelated_comments_and_fields() {
        let source = "# user note\nharness:\n  adapter: pi # keep\n# opaque adapter data\nworkflow:\n  custom: {\"one\": 1}\nprofiles:\n  personal:\n    context: home # context note\n    roles: {}\n";
        let edited = edit_source(
            source,
            &[
                set(&["profiles", "personal", "context"], json!("work")),
                set(
                    &["profiles", "personal", "roles", "discovery.explorer"],
                    json!({"provider":"openai", "model":"a # model & ! *> |", "thinking":"off"}),
                ),
            ],
        )
        .unwrap();
        assert!(edited.contains("# user note\nharness:\n  adapter: pi # keep\n# opaque adapter data\nworkflow:\n  custom: {\"one\": 1}\n"));
        assert!(edited.contains("context: \"work\" # context note"));
        assert_eq!(
            parse(&edited).unwrap()["profiles"]["personal"]["roles"]["discovery.explorer"]["model"],
            "a # model & ! *> |"
        );
    }

    #[test]
    fn adding_and_removing_overrides_round_trip() {
        let source = "# empty config\nharness:\n  adapter: pi\n";
        let edited = edit_source(
            source,
            &[
                set(
                    &["contexts", "home", "allowed_providers"],
                    json!(["openai"]),
                ),
                set(&["profile"], json!("true")),
            ],
        )
        .unwrap();
        assert!(edited.starts_with(source));
        let removed = edit_source(
            &edited,
            &[ConfigurationChange::Remove {
                path: vec!["profile".into()],
            }],
        )
        .unwrap();
        assert!(parse(&removed).unwrap().get("profile").is_none());
    }

    #[test]
    fn quoted_values_and_keys_are_not_yaml_syntax() {
        let source =
            "profiles:\n  \"profile: # \\\"!\":\n    model: \"model&*!|> # text\" # real comment\n";
        assert_eq!(
            parse(source).unwrap()["profiles"]["profile: # \"!"]["model"],
            "model&*!|> # text"
        );
        assert_eq!(
            parse("model: 'openai/don''t # *>!' # comment").unwrap()["model"],
            "openai/don't # *>!"
        );
        for source in [
            "model: &anchor value",
            "model: *anchor",
            "model: !tag value",
            "model: |",
            "model: >",
            "model: don't &anchor",
        ] {
            assert!(parse(source).is_err());
        }
    }

    #[test]
    fn removing_last_override_keeps_parent_mapping_and_json_input() {
        let changes = [ConfigurationChange::Remove {
            path: vec!["profiles".into(), "personal".into()],
        }];
        let source = "profiles: # keep this comment\n  personal: {}\n# end\n";
        let edited = edit_source(source, &changes).unwrap();
        assert_eq!(edited, "profiles: {} # keep this comment\n# end\n");
        let edited =
            edit_source("{\"profiles\":{\"personal\":{}},\"opaque\":17}", &changes).unwrap();
        assert_eq!(parse(&edited).unwrap(), json!({"profiles":{},"opaque":17}));
    }

    #[test]
    fn invalid_source_requires_explicit_replacement() {
        assert!(edit_source("invalid", &[set(&["profile"], json!("new"))]).is_err());
        assert_eq!(
            parse(
                &edit_source("invalid", &[set(&[], json!({"harness":{"adapter":"pi"}}))]).unwrap()
            )
            .unwrap()["harness"]["adapter"],
            "pi"
        );
    }

    #[test]
    fn validates_every_profile_and_context() {
        let config = json!({"contexts":{"home":{"allowed_providers":["openai"]}},"profiles":{"bad":{"context":"home","roles":{"custom":{"provider":"outside","model":"m","thinking":"off"}}}}});
        assert!(validate_profiles(&config).is_err());
    }
}
