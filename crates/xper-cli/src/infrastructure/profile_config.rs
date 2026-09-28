//! Local configuration and active-profile file operations.

use std::{fs, io, path::Path};

use serde_json::Value;
use xper_application::events::RoutingSnapshot;
use xper_config::{ScopePaths, load_effective, resolve_profile};

fn effective(root: &Path) -> io::Result<Value> {
    let home = std::env::var_os("HOME")
        .map(std::path::PathBuf::from)
        .ok_or_else(|| io::Error::other("HOME is not set"))?;
    let xdg = std::env::var_os("XDG_CONFIG_HOME").map(std::path::PathBuf::from);
    let paths = ScopePaths::new(root, &home, xdg.as_deref());
    load_effective(&paths).map_err(io::Error::other)
}

fn active_name(root: &Path, config: &Value) -> io::Result<Option<String>> {
    let path = root.join(".xper/active-profile");
    match fs::read_to_string(path) {
        Ok(name) if !name.trim().is_empty() => Ok(Some(name.trim().into())),
        Ok(_) => Err(io::Error::other("active profile name is empty")),
        Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(config
            .get("profile")
            .and_then(Value::as_str)
            .map(str::to_owned)),
        Err(error) => Err(error),
    }
}

pub(crate) fn resolve_named(root: &Path, name: Option<&str>) -> io::Result<RoutingSnapshot> {
    let config = effective(root)?;
    let chosen = match name {
        Some(name) => name.to_owned(),
        None => active_name(root, &config)?
            .ok_or_else(|| io::Error::other("no profile selected; pass a name or activate one"))?,
    };
    resolve_profile(&config, &chosen).map_err(io::Error::other)
}

pub(crate) fn resolved_active(root: &Path) -> io::Result<Option<RoutingSnapshot>> {
    let config = effective(root)?;
    active_name(root, &config)?
        .map(|name| resolve_profile(&config, &name).map_err(io::Error::other))
        .transpose()
}

pub(crate) fn activate(root: &Path, name: &str) -> io::Result<RoutingSnapshot> {
    let snapshot = resolve_named(root, Some(name))?;
    let directory = root.join(".xper");
    fs::create_dir_all(&directory)?;
    let temporary = directory.join("active-profile.tmp");
    fs::write(&temporary, format!("{}\n", snapshot.profile))?;
    fs::rename(temporary, directory.join("active-profile"))?;
    Ok(snapshot)
}

/// Read neutral knowledge-workflow limits from the normal merged configuration.
pub(crate) fn workflow_policy(
    root: &Path,
) -> io::Result<xper_application::knowledge::WorkflowPolicy> {
    let config = effective(root)?;
    let policy: xper_application::knowledge::WorkflowPolicy = config
        .get("workflow")
        .and_then(|workflow| workflow.get("knowledge"))
        .map(|value| {
            serde_json::from_value(value.clone())
                .map_err(|_| io::Error::other("invalid workflow.knowledge policy"))
        })
        .transpose()?
        .unwrap_or_default();
    policy.validate().map_err(io::Error::other)?;
    Ok(policy)
}
