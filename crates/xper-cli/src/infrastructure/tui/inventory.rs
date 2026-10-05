//! Pure presentation inventory of named configuration objects and their sources.

use std::collections::{BTreeMap, BTreeSet};

use serde_json::Value;
use xper_application::configuration::{ConfigurationScope as Scope, ConfigurationSnapshot};

#[derive(Clone, Debug, PartialEq)]
pub(super) struct Profile {
    pub name: String,
    pub origin: Scope,
    pub scopes: Vec<Scope>,
    pub value: Value,
    pub effective_active: bool,
}

impl Profile {
    pub fn source_label(&self) -> String {
        source_label(self.origin, &self.scopes)
    }

    /// Highest contributing file, not an instruction to edit that file.
    pub fn highest_scope(&self) -> Scope {
        self.scopes.last().copied().unwrap_or(self.origin)
    }
}

#[derive(Clone, Debug, PartialEq)]
pub(super) struct Context {
    pub name: String,
    pub origin: Scope,
    pub scopes: Vec<Scope>,
    pub value: Value,
}

impl Context {
    pub fn source_label(&self) -> String {
        source_label(self.origin, &self.scopes)
    }

    /// Highest contributing file, not an instruction to edit that file.
    pub fn highest_scope(&self) -> Scope {
        self.scopes.last().copied().unwrap_or(self.origin)
    }
}

pub(super) fn profiles(snapshot: &ConfigurationSnapshot) -> Vec<Profile> {
    entries(snapshot, "profiles")
        .into_iter()
        .map(|entry| Profile {
            effective_active: snapshot.effective_profile.as_deref() == Some(&entry.name),
            name: entry.name,
            origin: entry.origin,
            scopes: entry.scopes,
            value: entry.value,
        })
        .collect()
}

pub(super) fn contexts(snapshot: &ConfigurationSnapshot) -> Vec<Context> {
    entries(snapshot, "contexts")
        .into_iter()
        .map(|entry| Context {
            name: entry.name,
            origin: entry.origin,
            scopes: entry.scopes,
            value: entry.value,
        })
        .collect()
}

struct Entry {
    name: String,
    origin: Scope,
    scopes: Vec<Scope>,
    value: Value,
}

fn named<'a>(value: &'a Value, collection: &str, name: &str) -> Option<&'a Value> {
    value.get(collection)?.as_object()?.get(name)
}

fn entries(snapshot: &ConfigurationSnapshot, collection: &str) -> Vec<Entry> {
    let mut contributions: BTreeMap<String, BTreeMap<Scope, Value>> = BTreeMap::new();
    for document in &snapshot.documents {
        if document.error.is_some() {
            continue;
        }
        if let Some(objects) = document
            .value
            .as_ref()
            .and_then(|value| value.get(collection))
            .and_then(Value::as_object)
        {
            for (name, value) in objects {
                contributions
                    .entry(name.clone())
                    .or_default()
                    .insert(document.scope, value.clone());
            }
        }
    }

    // Normally the physical documents supply every named object. If a caller
    // provides only resolved values, origin metadata can still identify sources.
    // Cumulative scoped values alone never count as new overrides.
    let candidates: BTreeSet<&String> = snapshot
        .effective
        .iter()
        .chain(snapshot.scoped.values())
        .filter_map(|value| value.get(collection).and_then(Value::as_object))
        .flat_map(|objects| objects.keys())
        .collect();
    for name in candidates {
        if contributions.contains_key(name) {
            continue;
        }
        let pointer = format!(
            "/{collection}/{}",
            name.replace('~', "~0").replace('/', "~1")
        );
        let prefix = format!("{pointer}/");
        for scope in snapshot
            .origins
            .iter()
            .filter(|(path, _)| *path == &pointer || path.starts_with(&prefix))
            .map(|(_, scope)| scope)
        {
            if let Some(value) = snapshot
                .scoped
                .get(scope)
                .and_then(|value| named(value, collection, name))
                .or_else(|| {
                    snapshot
                        .effective
                        .as_ref()
                        .and_then(|value| named(value, collection, name))
                })
            {
                contributions
                    .entry(name.clone())
                    .or_default()
                    .insert(*scope, value.clone());
            }
        }
    }

    contributions
        .into_iter()
        .filter_map(|(name, sources)| {
            let (&highest, fallback) = sources.last_key_value()?;
            let origin = sources
                .iter()
                .find(|(_, value)| value.is_object())
                .or_else(|| sources.first_key_value())?
                .0;
            let value = snapshot
                .effective
                .as_ref()
                .and_then(|value| named(value, collection, &name))
                .filter(|value| value.is_object())
                .or_else(|| {
                    snapshot
                        .scoped
                        .get(&highest)
                        .and_then(|value| named(value, collection, &name))
                })
                .unwrap_or(fallback)
                .clone();
            Some(Entry {
                name,
                origin: *origin,
                scopes: sources.keys().copied().collect(),
                value,
            })
        })
        .collect()
}

fn scope_label(scope: Scope) -> &'static str {
    match scope {
        Scope::Global => "Global",
        Scope::Project => "Project",
        Scope::Local => "Local",
    }
}

fn source_label(origin: Scope, scopes: &[Scope]) -> String {
    let overrides = scopes
        .iter()
        .filter(|scope| **scope > origin)
        .map(|scope| scope_label(*scope))
        .collect::<Vec<_>>();
    if overrides.is_empty() {
        scope_label(origin).into()
    } else {
        format!(
            "{}; overrides: {}",
            scope_label(origin),
            overrides.join(", ")
        )
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use xper_application::configuration::ConfigurationDocument;

    fn document(scope: Scope, value: Value) -> ConfigurationDocument {
        ConfigurationDocument {
            scope,
            path: format!("/synthetic/{scope:?}.yaml"),
            source: Some(value.to_string()),
            value: Some(value),
            error: None,
        }
    }

    fn snapshot(documents: Vec<ConfigurationDocument>) -> ConfigurationSnapshot {
        ConfigurationSnapshot {
            documents,
            effective: None,
            scoped: BTreeMap::new(),
            origins: BTreeMap::new(),
            default_profile: None,
            active_profile: None,
            effective_profile: None,
            diagnostics: vec![],
            revision: 1,
        }
    }

    #[test]
    fn one_logical_profile_retains_its_first_definition_and_every_override() {
        let global =
            json!({"profiles":{"work":{"context":"company","roles":{"role":{"model":"global"}}}}});
        let project = json!({"profiles":{"work":{"roles":{"role":{"model":"project"}}}}});
        let local = json!({"profiles":{"work":{"roles":{"role":{"thinking":"high"}}}}});
        // Document order does not override the scopes' defined precedence.
        let mut snapshot = snapshot(vec![
            document(Scope::Local, local),
            document(Scope::Global, global),
            document(Scope::Project, project),
        ]);
        snapshot.effective = Some(
            json!({"profiles":{"work":{"context":"company","roles":{"role":{"model":"project","thinking":"high"}}}}}),
        );
        snapshot
            .origins
            .insert("/profiles/work".into(), Scope::Local);
        snapshot.effective_profile = Some("work".into());
        let entries = profiles(&snapshot);
        assert_eq!(entries.len(), 1);
        assert_eq!(entries[0].origin, Scope::Global);
        assert_eq!(
            entries[0].scopes,
            [Scope::Global, Scope::Project, Scope::Local]
        );
        assert_eq!(entries[0].highest_scope(), Scope::Local);
        assert_eq!(
            entries[0].source_label(),
            "Global; overrides: Project, Local"
        );
        assert_eq!(entries[0].value["roles"]["role"]["model"], "project");
        assert_eq!(entries[0].value["context"], "company");
        assert!(entries[0].effective_active);
    }

    #[test]
    fn contexts_are_sorted_and_inheritance_does_not_create_contributing_scopes() {
        let global = json!({"contexts":{"company":{"allowed_providers":["one"]},"personal":{"allowed_providers":["two"]}}});
        let mut snapshot = snapshot(vec![
            document(Scope::Global, global.clone()),
            document(
                Scope::Project,
                json!({"contexts":{"company":{"allowed_providers":["three"]}}}),
            ),
        ]);
        let effective = json!({"contexts":{"company":{"allowed_providers":["three"]},"personal":{"allowed_providers":["two"]}}});
        snapshot.effective = Some(effective.clone());
        snapshot.scoped.insert(Scope::Global, global);
        snapshot.scoped.insert(Scope::Project, effective.clone());
        snapshot.scoped.insert(Scope::Local, effective);
        let contexts = contexts(&snapshot);
        assert_eq!(
            contexts
                .iter()
                .map(|entry| entry.name.as_str())
                .collect::<Vec<_>>(),
            ["company", "personal"]
        );
        assert_eq!(contexts[0].scopes, [Scope::Global, Scope::Project]);
        assert_eq!(contexts[0].highest_scope(), Scope::Project);
        assert_eq!(contexts[0].value["allowed_providers"], json!(["three"]));
        assert_eq!(contexts[1].source_label(), "Global");
        assert_eq!(contexts[1].scopes, [Scope::Global]);
    }

    #[test]
    fn invalid_document_does_not_hide_objects_in_other_readable_documents() {
        let global =
            json!({"profiles":{"work":{"context":"company","roles":{"role":{"model":"global"}}}}});
        let local = json!({"profiles":{"work":{"roles":{"role":{"model":"local"}}},"private":{"context":"home","roles":{}}}});
        let mut broken = document(Scope::Project, json!({"profiles":{"untrusted":{}}}));
        broken.error = Some("Invalid source document".into());
        broken.value = None;
        let mut snapshot = snapshot(vec![
            document(Scope::Global, global.clone()),
            broken,
            document(Scope::Local, local),
        ]);
        snapshot.scoped.insert(Scope::Global, global);
        let entries = profiles(&snapshot);
        assert_eq!(
            entries
                .iter()
                .map(|entry| entry.name.as_str())
                .collect::<Vec<_>>(),
            ["private", "work"]
        );
        assert_eq!(entries[0].origin, Scope::Local);
        assert_eq!(entries[1].origin, Scope::Global);
        assert_eq!(entries[1].scopes, [Scope::Global, Scope::Local]);
        assert_eq!(entries[1].value["roles"]["role"]["model"], "local");
        assert!(!entries[1].effective_active);
    }

    #[test]
    fn scoped_fallback_preserves_inherited_fields_when_effective_is_unavailable() {
        let mut snapshot = snapshot(vec![
            document(
                Scope::Global,
                json!({"profiles":{"work":{"context":"company","roles":{}}}}),
            ),
            document(
                Scope::Project,
                json!({"profiles":{"work":{"roles":{"custom":{"model":"new"}}}}}),
            ),
        ]);
        snapshot.scoped.insert(
            Scope::Project,
            json!({"profiles":{"work":{"context":"company","roles":{"custom":{"model":"new"}}}}}),
        );
        let entries = profiles(&snapshot);
        assert_eq!(entries[0].value["context"], "company");
        assert_eq!(entries[0].value["roles"]["custom"]["model"], "new");
    }

    #[test]
    fn metadata_fallback_escapes_names_and_does_not_confuse_prefixes() {
        let mut snapshot = snapshot(vec![]);
        snapshot.effective =
            Some(json!({"profiles":{"work/tilde~":{"roles":{}},"work/tilde~other":{"roles":{}}}}));
        snapshot
            .origins
            .insert("/profiles/work~1tilde~0/roles".into(), Scope::Project);
        let entries = profiles(&snapshot);
        assert_eq!(entries.len(), 1);
        assert_eq!(entries[0].name, "work/tilde~");
        assert_eq!(entries[0].origin, Scope::Project);
    }
}
