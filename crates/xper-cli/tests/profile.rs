//! Profile commands use isolated configuration and never touch real Pi state.

use std::{fs, process::Command};

use serde_json::{Value, json};

#[test]
fn activate_and_inspect_resolved_profile_without_changing_shared_config() {
    let root = std::env::temp_dir().join(format!("xper-profile-{}", std::process::id()));
    fs::create_dir_all(root.join(".xper")).unwrap();
    fs::create_dir_all(root.join("home")).unwrap();
    let configuration = json!({
        "contexts":{"company":{"allowed_providers":["corp"]}},
        "profiles":{"work":{"context":"company","roles":{"discovery.explorer":{"provider":"corp","model":"m1","thinking":"low"}}}}
    });
    let path = root.join(".xper/config.yaml");
    fs::write(&path, serde_json::to_vec_pretty(&configuration).unwrap()).unwrap();
    let command = |args: &[&str]| {
        Command::new(env!("CARGO_BIN_EXE_xper"))
            .args(args)
            .current_dir(&root)
            .env("HOME", root.join("home"))
            .env("XDG_CONFIG_HOME", root.join("home/.config"))
            .output()
            .unwrap()
    };
    let inspected = command(&["profile", "inspect", "work", "--resolved"]);
    assert!(inspected.status.success());
    let route: Value = serde_json::from_slice(&inspected.stdout).unwrap();
    assert_eq!(route["routes"]["discovery.explorer"][0]["model"], "m1");
    assert_eq!(route["routes"]["discovery.explorer"][0]["thinking"], "low");
    assert_eq!(
        route["routes"]["discovery.explorer"]
            .as_array()
            .unwrap()
            .len(),
        1
    );
    assert!(command(&["profile", "activate", "work"]).status.success());
    assert_eq!(
        fs::read_to_string(root.join(".xper/active-profile")).unwrap(),
        "work\n"
    );
    assert!(
        command(&["profile", "inspect", "--resolved"])
            .status
            .success()
    );
    assert!(
        !command(&["profile", "activate", "missing"])
            .status
            .success()
    );
    assert_eq!(
        fs::read_to_string(path).unwrap(),
        serde_json::to_string_pretty(&configuration).unwrap()
    );
    fs::remove_dir_all(root).unwrap();
}
