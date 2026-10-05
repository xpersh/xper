//! Filesystem configuration authoring and workspace activation adapters.

use std::{
    collections::{BTreeMap, hash_map::DefaultHasher},
    fs,
    hash::{Hash, Hasher},
    io::{self, Write},
    path::{Path, PathBuf},
    sync::atomic::{AtomicU64, Ordering},
};

use serde_json::Value;
use xper_application::configuration::{
    ConfigurationChange, ConfigurationDocument, ConfigurationPreview, ConfigurationRepository,
    ConfigurationScope, ConfigurationSnapshot,
};
use xper_config::{
    DEFAULT_CONFIG, ScopePaths,
    authoring::{edit_source, validate_profiles},
    merge, parse, resolve_profile, validate,
};

pub(crate) use xper_config::AvailableModel;

/// Optionally check affected profiles against an adapter's current catalog.
pub(crate) fn validate_models(
    preview: &ConfigurationPreview,
    models: &[AvailableModel],
    changes: &[ConfigurationChange],
) -> io::Result<()> {
    for config in [&preview.authoring, &preview.effective] {
        let Some(profiles) = config.get("profiles").and_then(Value::as_object) else {
            continue;
        };
        for (name, profile) in profiles {
            let affected = changes.iter().any(|change| {
                let path = match change {
                    ConfigurationChange::Set { path, .. }
                    | ConfigurationChange::Remove { path } => path,
                };
                match path.first().map(String::as_str) {
                    None => true,
                    Some("profiles") => path.get(1).is_none_or(|changed| changed == name),
                    Some("contexts") => path.get(1).is_none_or(|changed| {
                        profile.get("context").and_then(Value::as_str) == Some(changed.as_str())
                    }),
                    Some("profile") => {
                        config.get("profile").and_then(Value::as_str) == Some(name.as_str())
                    }
                    _ => false,
                }
            });
            if !affected {
                continue;
            }
            let routing = resolve_profile(config, name).map_err(dependency)?;
            xper_config::validate_catalog(&routing, models).map_err(dependency)?;
        }
    }
    Ok(())
}

static NEXT_TEMPORARY: AtomicU64 = AtomicU64::new(1);

/// One explicit workspace and its normal global/project/local search paths.
pub(crate) struct LocalConfiguration {
    root: PathBuf,
    paths: ScopePaths,
}

fn dependency(error: impl std::fmt::Display) -> io::Error {
    io::Error::other(error.to_string())
}

fn read_optional(path: &Path) -> io::Result<Option<String>> {
    match fs::read_to_string(path) {
        Ok(source) => Ok(Some(source)),
        Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(None),
        Err(error) => Err(error),
    }
}

fn pointer(path: &[String]) -> String {
    path.iter()
        .map(|key| format!("/{}", key.replace('~', "~0").replace('/', "~1")))
        .collect()
}

fn annotate(
    lower: &Value,
    upper: &Value,
    path: &mut Vec<String>,
    scope: ConfigurationScope,
    origins: &mut BTreeMap<String, ConfigurationScope>,
) {
    let key = pointer(path);
    if !lower.is_object() || !upper.is_object() {
        let prefix = format!("{key}/");
        origins.retain(|existing, _| existing != &key && !existing.starts_with(&prefix));
    }
    origins.insert(key, scope);
    if let Some(map) = upper.as_object() {
        for (key, value) in map {
            path.push(key.clone());
            annotate(
                lower.get(key).unwrap_or(&Value::Null),
                value,
                path,
                scope,
                origins,
            );
            path.pop();
        }
    }
}

impl LocalConfiguration {
    pub(crate) fn current() -> io::Result<Self> {
        let root = std::env::current_dir()?;
        let home = std::env::var_os("HOME")
            .map(PathBuf::from)
            .ok_or_else(|| io::Error::other("HOME is not set"))?;
        let xdg = std::env::var_os("XDG_CONFIG_HOME").map(PathBuf::from);
        Ok(Self::new(root, home, xdg))
    }

    pub(crate) fn new(root: PathBuf, home: PathBuf, xdg: Option<PathBuf>) -> Self {
        Self {
            paths: ScopePaths::new(&root, &home, xdg.as_deref()),
            root,
        }
    }

    fn path(&self, scope: ConfigurationScope) -> &Path {
        match scope {
            ConfigurationScope::Global => &self.paths.global,
            ConfigurationScope::Project => &self.paths.project,
            ConfigurationScope::Local => &self.paths.local,
        }
    }

    fn check_revision(&self, expected: u64) -> io::Result<()> {
        if self.inspect()?.revision != expected {
            return Err(io::Error::other(
                "Configuration changed outside this editor. Reload and review your changes before saving.",
            ));
        }
        Ok(())
    }

    fn ignore_local(&self) -> io::Result<()> {
        let path = self.root.join(".gitignore");
        let original = read_optional(&path)?;
        let mut source = original.clone().unwrap_or_default();
        const RULE: &str = "/.xper/config.local.yaml";
        if source.lines().any(|line| line.trim() == RULE) {
            return Ok(());
        }
        if !source.is_empty() && !source.ends_with('\n') {
            source.push('\n');
        }
        source.push_str(RULE);
        source.push('\n');
        replace_atomically(&path, &source, || {
            if read_optional(&path)? != original {
                return Err(io::Error::other(
                    ".gitignore changed while preparing the local configuration; retry after reviewing it",
                ));
            }
            Ok(())
        })
    }
}

/// Write a unique sibling, preserving existing permissions and detecting a
/// changed authoring snapshot immediately before replacing the destination.
fn replace_atomically(
    path: &Path,
    source: &str,
    before_commit: impl FnOnce() -> io::Result<()>,
) -> io::Result<()> {
    if fs::symlink_metadata(path).is_ok_and(|metadata| metadata.file_type().is_symlink()) {
        return Err(io::Error::other(
            "The destination is a symbolic link; edit its target directly",
        ));
    }
    let parent = path
        .parent()
        .ok_or_else(|| io::Error::other("configuration destination has no parent"))?;
    fs::create_dir_all(parent)?;
    let id = NEXT_TEMPORARY.fetch_add(1, Ordering::Relaxed);
    let filename = path
        .file_name()
        .and_then(|name| name.to_str())
        .unwrap_or("configuration");
    let temporary = parent.join(format!(".{filename}.{}.{}.tmp", std::process::id(), id));
    let result = (|| {
        let mut file = fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&temporary)?;
        if let Ok(metadata) = fs::metadata(path) {
            file.set_permissions(metadata.permissions())?;
        }
        file.write_all(source.as_bytes())?;
        file.sync_all()?;
        before_commit()?;
        fs::rename(&temporary, path)?;
        Ok(())
    })();
    if result.is_err() {
        let _ = fs::remove_file(temporary);
    }
    result
}

impl ConfigurationRepository for LocalConfiguration {
    type Error = io::Error;

    fn inspect(&self) -> io::Result<ConfigurationSnapshot> {
        let mut documents = Vec::new();
        let mut effective = Some(parse(DEFAULT_CONFIG).map_err(dependency)?);
        let mut scoped = BTreeMap::new();
        let mut origins = BTreeMap::new();
        let mut diagnostics = Vec::new();
        let mut revision = DefaultHasher::new();
        for scope in [
            ConfigurationScope::Global,
            ConfigurationScope::Project,
            ConfigurationScope::Local,
        ] {
            let path = self.path(scope);
            path.hash(&mut revision);
            let (source, read_error) = match read_optional(path) {
                Ok(source) => (source, None),
                Err(error) => (None, Some(format!("{}: {error}", path.display()))),
            };
            source.hash(&mut revision);
            read_error.hash(&mut revision);
            let parsed: Result<Option<Value>, xper_config::ConfigError> = source
                .as_deref()
                .map(|source| {
                    let value = parse(source)?;
                    validate(&value)?;
                    Ok(value)
                })
                .transpose();
            let (value, error) = match parsed {
                Ok(value) => (value, read_error),
                Err(error) => (None, Some(format!("{}: {error}", path.display()))),
            };
            if let Some(error) = &error {
                diagnostics.push(error.clone());
                effective = None;
            } else if let (Some(base), Some(value)) = (effective.as_mut(), value.as_ref()) {
                annotate(base, value, &mut Vec::new(), scope, &mut origins);
                merge(base, value.clone());
            }
            if let Some(value) = &effective {
                scoped.insert(scope, value.clone());
            }
            documents.push(ConfigurationDocument {
                scope,
                path: path.display().to_string(),
                source,
                value,
                error,
            });
        }
        let activation_path = self.root.join(".xper/active-profile");
        activation_path.hash(&mut revision);
        let activation = read_optional(&activation_path);
        let mut activation_failed = false;
        let active_profile = match activation {
            Ok(source) => {
                source.hash(&mut revision);
                source.and_then(|source| {
                    let name = source.trim();
                    if name.is_empty() {
                        activation_failed = true;
                        diagnostics.push("Active profile name is empty; select a profile or use the configured default".into());
                        None
                    } else {
                        Some(name.to_owned())
                    }
                })
            }
            Err(error) => {
                activation_failed = true;
                error.to_string().hash(&mut revision);
                diagnostics.push(format!("{}: {error}", activation_path.display()));
                None
            }
        };
        let default_profile = effective
            .as_ref()
            .and_then(|value| value.get("profile"))
            .and_then(Value::as_str)
            .map(str::to_owned);
        let effective_profile = if activation_failed {
            None
        } else {
            active_profile.clone().or_else(|| default_profile.clone())
        };
        if let Some(config) = &effective {
            if let Err(error) = validate_profiles(config) {
                diagnostics.push(error.to_string());
            }
            if let Some(name) = &active_profile
                && let Err(error) = resolve_profile(config, name)
            {
                diagnostics.push(format!("Active profile: {error}"));
            }
        }
        Ok(ConfigurationSnapshot {
            documents,
            effective,
            scoped,
            origins,
            default_profile,
            active_profile,
            effective_profile,
            diagnostics,
            revision: revision.finish(),
        })
    }

    fn preview(
        &self,
        snapshot: &ConfigurationSnapshot,
        scope: ConfigurationScope,
        changes: &[ConfigurationChange],
    ) -> io::Result<ConfigurationPreview> {
        let document = snapshot
            .documents
            .iter()
            .find(|document| document.scope == scope)
            .ok_or_else(|| io::Error::other("configuration scope was not inspected"))?;
        if document.source.is_none()
            && let Some(error) = &document.error
        {
            return Err(io::Error::other(error.clone()));
        }
        let source =
            edit_source(document.source.as_deref().unwrap_or(""), changes).map_err(dependency)?;
        let proposed = parse(&source).map_err(dependency)?;
        let mut effective = parse(DEFAULT_CONFIG).map_err(dependency)?;
        let mut authoring = None;
        let mut diagnostics = Vec::new();
        let selects_profile = changes.iter().any(|change| {
            let path = match change {
                ConfigurationChange::Set { path, .. } | ConfigurationChange::Remove { path } => {
                    path
                }
            };
            path.is_empty() || path.first().is_some_and(|key| key == "profile")
        });
        for item in &snapshot.documents {
            if item.scope == scope {
                merge(&mut effective, proposed.clone());
                if selects_profile
                    && let Some(name) = effective.get("profile").and_then(Value::as_str)
                {
                    resolve_profile(&effective, name).map_err(|error| {
                        io::Error::other(format!(
                            "Cannot select profile '{name}' at {scope:?} scope: {error}. Only definitions from that scope and lower-precedence scopes are available."
                        ))
                    })?;
                }
                validate_profiles(&effective).map_err(dependency)?;
                authoring = Some(effective.clone());
            } else if let Some(error) = &item.error {
                return Err(io::Error::other(error.clone()));
            } else if let Some(value) = &item.value {
                merge(&mut effective, value.clone());
            }
        }
        validate_profiles(&effective).map_err(dependency)?;
        for change in changes {
            let path = match change {
                ConfigurationChange::Set { path, .. } | ConfigurationChange::Remove { path } => {
                    path
                }
            };
            if let Some(origin) = snapshot.origins.get(&pointer(path))
                && *origin > scope
            {
                diagnostics.push(format!(
                    "{} remains overridden by the {origin:?} scope",
                    pointer(path)
                ));
            }
        }
        if selects_profile {
            if let Some(origin) = snapshot.origins.get("/profile")
                && *origin > scope
                && let Some(name) = effective.get("profile").and_then(Value::as_str)
            {
                diagnostics.push(format!(
                    "The {origin:?} scope keeps YAML profile '{name}' selected for this workspace."
                ));
            }
            if let Some(name) = &snapshot.active_profile {
                diagnostics.push(format!(
                    "Legacy workspace activation .xper/active-profile keeps '{name}' selected over the YAML scopes. Saving preserves this file; clear it explicitly to use the configured selection."
                ));
            }
        }
        if let Some(name) = &snapshot.active_profile
            && let Err(error) = resolve_profile(&effective, name)
        {
            return Err(io::Error::other(format!(
                "Active profile would become invalid: {error}"
            )));
        }
        Ok(ConfigurationPreview {
            revision: snapshot.revision,
            changes: changes.to_vec(),
            scope,
            path: self.path(scope).display().to_string(),
            changed: document.source.as_deref() != Some(source.as_str()),
            source,
            effective,
            authoring: authoring.expect("selected scope was inspected"),
            diagnostics,
        })
    }

    fn save(
        &mut self,
        snapshot: &ConfigurationSnapshot,
        scope: ConfigurationScope,
        changes: &[ConfigurationChange],
    ) -> io::Result<ConfigurationSnapshot> {
        self.check_revision(snapshot.revision)?;
        let preview = self.preview(snapshot, scope, changes)?;
        if preview.changed {
            if scope == ConfigurationScope::Local {
                self.ignore_local()?;
            }
            replace_atomically(self.path(scope), &preview.source, || {
                self.check_revision(snapshot.revision)
            })?;
        }
        self.inspect()
    }

    fn activate(&mut self, name: Option<&str>) -> io::Result<ConfigurationSnapshot> {
        let snapshot = self.inspect()?;
        let path = self.root.join(".xper/active-profile");
        if let Some(name) = name {
            let config = snapshot.effective.as_ref().ok_or_else(|| {
                io::Error::other("repair configuration before activating a profile")
            })?;
            let routing = resolve_profile(config, name).map_err(dependency)?;
            replace_atomically(&path, &format!("{}\n", routing.profile), || {
                self.check_revision(snapshot.revision)
            })?;
        } else {
            self.check_revision(snapshot.revision)?;
            match fs::remove_file(path) {
                Ok(()) => {}
                Err(error) if error.kind() == io::ErrorKind::NotFound => {}
                Err(error) => return Err(error),
            }
        }
        self.inspect()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    struct Workspace(PathBuf);
    impl Workspace {
        fn new() -> Self {
            let id = NEXT_TEMPORARY.fetch_add(1, Ordering::Relaxed);
            let root = std::env::temp_dir()
                .join(format!("xper-config-editor-{}-{id}", std::process::id()));
            fs::create_dir_all(&root).unwrap();
            Self(root)
        }
        fn repository(&self) -> LocalConfiguration {
            LocalConfiguration::new(self.0.clone(), self.0.join("home"), None)
        }
    }
    impl Drop for Workspace {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }
    fn set(path: &[&str], value: Value) -> ConfigurationChange {
        ConfigurationChange::Set {
            path: path.iter().map(|key| (*key).into()).collect(),
            value,
        }
    }
    fn profile() -> Value {
        json!({"contexts":{"home":{"allowed_providers":["openai"]}},"profiles":{"personal":{"context":"home","roles":{"custom.role":{"provider":"openai","model":"m","thinking":"off"}}}},"profile":"personal"})
    }

    #[test]
    fn preview_does_not_write_and_save_only_changes_selected_scope() {
        let workspace = Workspace::new();
        let mut repository = workspace.repository();
        let before = repository.inspect().unwrap();
        let changes = [set(&[], profile())];
        let preview = repository
            .preview(&before, ConfigurationScope::Global, &changes)
            .unwrap();
        assert!(preview.changed);
        assert!(!repository.path(ConfigurationScope::Global).exists());
        let global = repository
            .save(&before, ConfigurationScope::Global, &changes)
            .unwrap();
        let global_source =
            fs::read_to_string(repository.path(ConfigurationScope::Global)).unwrap();
        let local = repository
            .save(
                &global,
                ConfigurationScope::Local,
                &[set(
                    &["profiles", "personal", "roles", "custom.role", "model"],
                    json!("other"),
                )],
            )
            .unwrap();
        assert_eq!(
            local.effective.unwrap()["profiles"]["personal"]["roles"]["custom.role"]["model"],
            "other"
        );
        assert_eq!(
            local.origins["/profiles/personal/roles/custom.role/model"],
            ConfigurationScope::Local
        );
        assert_eq!(
            fs::read_to_string(repository.path(ConfigurationScope::Global)).unwrap(),
            global_source
        );
        assert!(
            fs::read_to_string(workspace.0.join(".gitignore"))
                .unwrap()
                .contains("/.xper/config.local.yaml")
        );
        assert!(!repository.path(ConfigurationScope::Project).exists());
    }

    #[test]
    fn external_changes_to_any_scope_reject_save_without_overwrite() {
        let workspace = Workspace::new();
        let mut repository = workspace.repository();
        let before = repository.inspect().unwrap();
        fs::create_dir_all(workspace.0.join(".xper")).unwrap();
        fs::write(repository.path(ConfigurationScope::Project), "# external\n").unwrap();
        assert!(
            repository
                .save(&before, ConfigurationScope::Global, &[set(&[], profile())])
                .unwrap_err()
                .to_string()
                .contains("outside this editor")
        );
        assert!(!repository.path(ConfigurationScope::Global).exists());
        assert_eq!(
            fs::read_to_string(repository.path(ConfigurationScope::Project)).unwrap(),
            "# external\n"
        );
    }

    #[test]
    fn activation_is_separate_from_default_and_can_be_cleared() {
        let workspace = Workspace::new();
        let mut repository = workspace.repository();
        let before = repository.inspect().unwrap();
        repository
            .save(&before, ConfigurationScope::Project, &[set(&[], profile())])
            .unwrap();
        let source = fs::read_to_string(repository.path(ConfigurationScope::Project)).unwrap();
        assert_eq!(
            repository
                .activate(Some("personal"))
                .unwrap()
                .active_profile
                .as_deref(),
            Some("personal")
        );
        assert!(repository.activate(Some("unknown")).is_err());
        let cleared = repository.activate(None).unwrap();
        assert!(cleared.active_profile.is_none());
        assert_eq!(cleared.effective_profile.as_deref(), Some("personal"));
        assert_eq!(
            fs::read_to_string(repository.path(ConfigurationScope::Project)).unwrap(),
            source
        );
    }

    #[test]
    fn scoped_profile_selection_follows_precedence_and_removal_restores_inheritance() {
        let workspace = Workspace::new();
        let mut repository = workspace.repository();
        let mut config = profile();
        config["profiles"]["shared"] = config["profiles"]["personal"].clone();
        config["profiles"]["private"] = config["profiles"]["personal"].clone();
        let snapshot = repository.inspect().unwrap();
        let global = repository
            .save(&snapshot, ConfigurationScope::Global, &[set(&[], config)])
            .unwrap();
        assert_eq!(global.effective_profile.as_deref(), Some("personal"));
        let project = repository
            .save(
                &global,
                ConfigurationScope::Project,
                &[set(&["profile"], json!("shared"))],
            )
            .unwrap();
        assert_eq!(project.effective_profile.as_deref(), Some("shared"));
        let local = repository
            .save(
                &project,
                ConfigurationScope::Local,
                &[set(&["profile"], json!("private"))],
            )
            .unwrap();
        assert_eq!(local.effective_profile.as_deref(), Some("private"));
        assert!(local.active_profile.is_none());
        assert!(!workspace.0.join(".xper/active-profile").exists());

        let preview = repository
            .preview(
                &local,
                ConfigurationScope::Global,
                &[set(&["profile"], json!("shared"))],
            )
            .unwrap();
        assert_eq!(preview.authoring["profile"], "shared");
        assert_eq!(preview.effective["profile"], "private");
        assert!(
            preview
                .diagnostics
                .iter()
                .any(|message| { message.contains("Local scope keeps YAML profile 'private'") })
        );

        let remove = [ConfigurationChange::Remove {
            path: vec!["profile".into()],
        }];
        let project_again = repository
            .save(&local, ConfigurationScope::Local, &remove)
            .unwrap();
        assert_eq!(project_again.effective_profile.as_deref(), Some("shared"));
        let global_again = repository
            .save(&project_again, ConfigurationScope::Project, &remove)
            .unwrap();
        assert_eq!(global_again.effective_profile.as_deref(), Some("personal"));
        let unselected = repository
            .save(&global_again, ConfigurationScope::Global, &remove)
            .unwrap();
        assert!(unselected.effective_profile.is_none());
        assert!(unselected.effective.unwrap()["profiles"]["personal"].is_object());
    }

    #[test]
    fn scoped_selection_rejects_profiles_available_only_in_a_higher_scope() {
        for (target, definitions) in [
            (ConfigurationScope::Global, ConfigurationScope::Project),
            (ConfigurationScope::Project, ConfigurationScope::Local),
        ] {
            let workspace = Workspace::new();
            let mut repository = workspace.repository();
            let before = repository.inspect().unwrap();
            let snapshot = repository
                .save(&before, definitions, &[set(&[], profile())])
                .unwrap();
            let error = repository
                .preview(&snapshot, target, &[set(&["profile"], json!("personal"))])
                .unwrap_err()
                .to_string();
            assert!(error.contains(&format!("Cannot select profile 'personal' at {target:?}")));
            assert!(error.contains("lower-precedence scopes"));
            assert!(!repository.path(target).exists());
        }
    }

    #[test]
    fn scoped_selection_rejects_a_profile_whose_context_exists_only_above_it() {
        let workspace = Workspace::new();
        let mut repository = workspace.repository();
        let global_path = repository.path(ConfigurationScope::Global);
        fs::create_dir_all(global_path.parent().unwrap()).unwrap();
        let global_source = json!({"profiles":profile()["profiles"]}).to_string();
        fs::write(global_path, &global_source).unwrap();
        let before = repository.inspect().unwrap();
        let snapshot = repository
            .save(
                &before,
                ConfigurationScope::Project,
                &[set(&["contexts"], profile()["contexts"].clone())],
            )
            .unwrap();
        let selection = [set(&["profile"], json!("personal"))];
        let error = repository
            .preview(&snapshot, ConfigurationScope::Global, &selection)
            .unwrap_err()
            .to_string();
        assert!(error.contains("Cannot select profile 'personal' at Global scope"));
        assert!(error.contains("home"));
        assert_eq!(
            fs::read_to_string(repository.path(ConfigurationScope::Global)).unwrap(),
            global_source
        );
        assert!(
            repository
                .preview(&snapshot, ConfigurationScope::Project, &selection)
                .is_ok()
        );
    }

    #[test]
    fn scoped_selection_reports_and_preserves_legacy_activation_until_explicitly_cleared() {
        let workspace = Workspace::new();
        let mut repository = workspace.repository();
        let mut config = profile();
        config["profiles"]["work"] = config["profiles"]["personal"].clone();
        let before = repository.inspect().unwrap();
        repository
            .save(&before, ConfigurationScope::Global, &[set(&[], config)])
            .unwrap();
        let snapshot = repository.activate(Some("personal")).unwrap();
        let selection = [set(&["profile"], json!("work"))];
        let preview = repository
            .preview(&snapshot, ConfigurationScope::Local, &selection)
            .unwrap();
        assert_eq!(preview.effective["profile"], "work");
        assert!(preview.diagnostics.iter().any(|message| {
            message.contains(".xper/active-profile keeps 'personal' selected")
                && message.contains("clear it explicitly")
        }));
        let saved = repository
            .save(&snapshot, ConfigurationScope::Local, &selection)
            .unwrap();
        assert_eq!(saved.default_profile.as_deref(), Some("work"));
        assert_eq!(saved.effective_profile.as_deref(), Some("personal"));
        assert_eq!(
            fs::read_to_string(workspace.0.join(".xper/active-profile")).unwrap(),
            "personal\n"
        );
        let cleared = repository.activate(None).unwrap();
        assert!(cleared.active_profile.is_none());
        assert_eq!(cleared.effective_profile.as_deref(), Some("work"));
    }

    #[test]
    fn invalid_source_is_inspectable_and_can_be_explicitly_repaired() {
        let workspace = Workspace::new();
        let mut repository = workspace.repository();
        fs::create_dir_all(workspace.0.join(".xper")).unwrap();
        fs::write(repository.path(ConfigurationScope::Project), "invalid yaml").unwrap();
        let before = repository.inspect().unwrap();
        assert!(before.effective.is_none());
        assert!(!before.diagnostics.is_empty());
        let after = repository
            .save(&before, ConfigurationScope::Project, &[set(&[], profile())])
            .unwrap();
        assert!(after.diagnostics.is_empty());
    }

    #[test]
    fn credentials_and_invalid_unselected_profiles_cannot_be_saved() {
        let workspace = Workspace::new();
        let mut repository = workspace.repository();
        let before = repository.inspect().unwrap();
        let error = repository
            .save(
                &before,
                ConfigurationScope::Project,
                &[set(&["api_key"], json!("never-print-this"))],
            )
            .unwrap_err();
        assert!(!error.to_string().contains("never-print-this"));
        assert!(!repository.path(ConfigurationScope::Project).exists());
        let mut value = profile();
        value["profiles"]["bad"] = json!({"context":"missing", "roles":{}});
        assert!(
            repository
                .save(&before, ConfigurationScope::Project, &[set(&[], value)])
                .is_err()
        );
    }

    #[test]
    fn atomic_write_error_preserves_destination_and_cleans_temporary() {
        let workspace = Workspace::new();
        let path = workspace.0.join("config.yaml");
        fs::write(&path, "original").unwrap();
        assert!(
            replace_atomically(&path, "replacement", || Err(io::Error::other("conflict"))).is_err()
        );
        assert_eq!(fs::read_to_string(&path).unwrap(), "original");
        assert_eq!(fs::read_dir(&workspace.0).unwrap().count(), 1);
    }

    #[test]
    fn removing_local_override_reveals_global_value_and_keeps_ignore_idempotent() {
        let workspace = Workspace::new();
        let mut repository = workspace.repository();
        let before = repository.inspect().unwrap();
        let global = repository
            .save(&before, ConfigurationScope::Global, &[set(&[], profile())])
            .unwrap();
        let local = repository
            .save(
                &global,
                ConfigurationScope::Local,
                &[set(
                    &["profiles", "personal", "roles", "custom.role", "model"],
                    json!("override"),
                )],
            )
            .unwrap();
        let removed = repository
            .save(
                &local,
                ConfigurationScope::Local,
                &[ConfigurationChange::Remove {
                    path: vec!["profiles".into()],
                }],
            )
            .unwrap();
        assert_eq!(
            removed.effective.unwrap()["profiles"]["personal"]["roles"]["custom.role"]["model"],
            "m"
        );
        assert_eq!(
            fs::read_to_string(workspace.0.join(".gitignore"))
                .unwrap()
                .lines()
                .filter(|line| *line == "/.xper/config.local.yaml")
                .count(),
            1
        );
    }

    #[test]
    fn unavailable_unrelated_profile_does_not_block_catalog_validation() {
        let mut value = profile();
        value["profiles"]["archived"] = value["profiles"]["personal"].clone();
        value["profiles"]["archived"]["roles"]["custom.role"]["model"] = json!("unavailable");
        let preview = ConfigurationPreview {
            revision: 0,
            changes: vec![],
            scope: ConfigurationScope::Global,
            path: String::new(),
            source: String::new(),
            effective: value.clone(),
            authoring: value,
            changed: true,
            diagnostics: Vec::new(),
        };
        let models = [AvailableModel {
            provider: "openai".into(),
            model: "m".into(),
            reasoning: false,
        }];
        assert!(
            validate_models(
                &preview,
                &models,
                &[set(&["profiles", "personal"], json!({}))]
            )
            .is_ok()
        );
        assert!(
            validate_models(&preview, &models, &[set(&["contexts", "home"], json!({}))]).is_err()
        );
    }

    #[test]
    fn higher_scope_cannot_hide_invalid_saved_configuration() {
        let workspace = Workspace::new();
        let mut repository = workspace.repository();
        let before = repository.inspect().unwrap();
        let project = repository
            .save(&before, ConfigurationScope::Project, &[set(&[], profile())])
            .unwrap();
        let invalid_global = json!({"profile":"personal"});
        assert!(
            repository
                .preview(
                    &project,
                    ConfigurationScope::Global,
                    &[set(&[], invalid_global)]
                )
                .is_err()
        );
    }

    #[test]
    fn broken_activation_does_not_claim_the_default_is_effective() {
        let workspace = Workspace::new();
        let mut repository = workspace.repository();
        let before = repository.inspect().unwrap();
        repository
            .save(&before, ConfigurationScope::Project, &[set(&[], profile())])
            .unwrap();
        fs::write(workspace.0.join(".xper/active-profile"), "\n").unwrap();
        let broken = repository.inspect().unwrap();
        assert_eq!(broken.default_profile.as_deref(), Some("personal"));
        assert!(broken.effective_profile.is_none());
        assert!(!broken.diagnostics.is_empty());
        assert_eq!(
            repository
                .activate(None)
                .unwrap()
                .effective_profile
                .as_deref(),
            Some("personal")
        );
    }

    #[test]
    fn global_authoring_excludes_project_only_contexts_and_profiles() {
        let workspace = Workspace::new();
        let mut repository = workspace.repository();
        let before = repository.inspect().unwrap();
        let snapshot = repository
            .save(&before, ConfigurationScope::Project, &[set(&[], profile())])
            .unwrap();
        assert!(
            snapshot.scoped[&ConfigurationScope::Global]
                .get("contexts")
                .is_none()
        );
        assert!(
            snapshot.scoped[&ConfigurationScope::Global]
                .get("profiles")
                .is_none()
        );
        assert_eq!(
            snapshot.scoped[&ConfigurationScope::Project]["profiles"]["personal"]["context"],
            "home"
        );
        let preview = repository
            .preview(
                &snapshot,
                ConfigurationScope::Global,
                &[set(&["harness", "adapter"], json!("pi"))],
            )
            .unwrap();
        assert!(preview.authoring.get("profiles").is_none());
        assert!(preview.effective["profiles"].get("personal").is_some());
    }

    #[test]
    fn scoped_authoring_keeps_lower_values_separate_from_masking_overrides() {
        let workspace = Workspace::new();
        let mut repository = workspace.repository();
        let before = repository.inspect().unwrap();
        let global = repository
            .save(&before, ConfigurationScope::Global, &[set(&[], profile())])
            .unwrap();
        let path = ["profiles", "personal", "roles", "custom.role", "model"];
        let project = repository
            .save(
                &global,
                ConfigurationScope::Project,
                &[set(&path, json!("project"))],
            )
            .unwrap();
        let snapshot = repository
            .save(
                &project,
                ConfigurationScope::Local,
                &[set(&path, json!("local"))],
            )
            .unwrap();
        let route = "/profiles/personal/roles/custom.role/model";
        assert_eq!(
            snapshot.scoped[&ConfigurationScope::Global]
                .pointer(route)
                .unwrap(),
            "m"
        );
        assert_eq!(
            snapshot.scoped[&ConfigurationScope::Project]
                .pointer(route)
                .unwrap(),
            "project"
        );
        assert_eq!(
            snapshot.scoped[&ConfigurationScope::Local]
                .pointer(route)
                .unwrap(),
            "local"
        );
        let changes = [set(&path, json!("new-global"))];
        let preview = repository
            .preview(&snapshot, ConfigurationScope::Global, &changes)
            .unwrap();
        assert_eq!(preview.authoring.pointer(route).unwrap(), "new-global");
        assert_eq!(preview.effective.pointer(route).unwrap(), "local");
        assert!(
            preview
                .diagnostics
                .iter()
                .any(|message| message.contains("overridden"))
        );
        let catalog = ["new-global", "local"].map(|model| AvailableModel {
            provider: "openai".into(),
            model: model.into(),
            reasoning: false,
        });
        assert!(validate_models(&preview, &catalog, &changes).is_ok());
        assert!(validate_models(&preview, &catalog[..1], &changes).is_err());
        assert!(validate_models(&preview, &catalog[1..], &changes).is_err());
    }
}
