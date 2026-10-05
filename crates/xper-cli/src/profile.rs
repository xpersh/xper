//! Present profile selection and resolved routing in the CLI.

use std::io;

use crate::infrastructure::{configuration::LocalConfiguration, profile_config};
use xper_application::use_cases::activate_profile;

pub(crate) fn activate(name: &str) -> io::Result<bool> {
    let mut repository = LocalConfiguration::current()?;
    let snapshot =
        activate_profile::execute(&mut repository, Some(name)).map_err(io::Error::other)?;
    let context = snapshot
        .effective
        .as_ref()
        .and_then(|value| value.get("profiles"))
        .and_then(|value| value.get(name))
        .and_then(|value| value.get("context"))
        .and_then(serde_json::Value::as_str)
        .ok_or_else(|| {
            io::Error::other("activated profile no longer resolves; inspect configuration")
        })?;
    println!("Active xper profile: {} (context {})", name, context);
    Ok(true)
}

pub(crate) fn inspect(name: Option<&str>, resolved: bool) -> io::Result<bool> {
    let root = std::env::current_dir()?;
    let snapshot = profile_config::resolve_named(&root, name)?;
    if resolved {
        println!("{}", serde_json::to_string_pretty(&snapshot)?);
    } else {
        println!(
            "profile: {}\ncontext: {}\nroles: {}",
            snapshot.profile,
            snapshot.context,
            snapshot
                .routes
                .keys()
                .cloned()
                .collect::<Vec<_>>()
                .join(", ")
        );
    }
    Ok(true)
}
