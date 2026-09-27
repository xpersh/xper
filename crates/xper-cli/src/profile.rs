//! Present profile selection and resolved routing in the CLI.

use std::io;

use crate::infrastructure::profile_config;

pub(crate) fn activate(name: &str) -> io::Result<bool> {
    let root = std::env::current_dir()?;
    let snapshot = profile_config::activate(&root, name)?;
    println!(
        "Active xper profile: {} (context {})",
        snapshot.profile, snapshot.context
    );
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
