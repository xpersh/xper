//! Fixture-backed setup and diagnostic process tests.
#![cfg(unix)]

use std::fs;
use std::path::{Path, PathBuf};
use std::process::{Command, Output};
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{SystemTime, UNIX_EPOCH};

use serde_json::Value;

struct Workspace {
    root: PathBuf,
    bin: PathBuf,
}
static NEXT_WORKSPACE: AtomicU64 = AtomicU64::new(0);

impl Workspace {
    fn fixture(name: &str, pi_version: Option<&str>) -> Self {
        let unique = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let sequence = NEXT_WORKSPACE.fetch_add(1, Ordering::Relaxed);
        let root = std::env::temp_dir().join(format!(
            "xper-setup-{}-{unique}-{sequence}",
            std::process::id()
        ));
        let fixture = Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("../../fixtures/installations")
            .join(name);
        copy_tree(&fixture, &root);
        let bin = root.join("bin");
        fs::create_dir_all(&bin).unwrap();
        if let Some(version) = pi_version {
            let script = bin.join("pi");
            fs::write(&script, format!("#!/bin/sh\nprintf '%s\\n' '{version}'\n")).unwrap();
            use std::os::unix::fs::PermissionsExt;
            fs::set_permissions(&script, fs::Permissions::from_mode(0o755)).unwrap();
        }
        fs::create_dir_all(root.join("home")).unwrap();
        Self { root, bin }
    }
    fn command(&self, args: &[&str]) -> Output {
        Command::new(env!("CARGO_BIN_EXE_xper"))
            .args(args)
            .current_dir(&self.root)
            .env("HOME", self.root.join("home"))
            .env("PI_CODING_AGENT_DIR", self.root.join("home/.pi/agent"))
            .env("XDG_CONFIG_HOME", self.root.join("home/.config"))
            .env("PATH", &self.bin)
            .output()
            .unwrap()
    }
}
impl Drop for Workspace {
    fn drop(&mut self) {
        fs::remove_dir_all(&self.root).unwrap();
    }
}

fn copy_tree(source: &Path, target: &Path) {
    fs::create_dir_all(target).unwrap();
    for entry in fs::read_dir(source).unwrap() {
        let entry = entry.unwrap();
        let destination = target.join(entry.file_name());
        if entry.file_type().unwrap().is_dir() {
            copy_tree(&entry.path(), &destination);
        } else {
            fs::copy(entry.path(), destination).unwrap();
        }
    }
}

fn report(output: &Output) -> Value {
    serde_json::from_slice(&output.stdout).unwrap()
}
fn status(report: &Value, id: &str) -> Option<String> {
    report["checks"]
        .as_array()
        .unwrap()
        .iter()
        .find(|c| c["id"] == id)
        .and_then(|c| c["status"].as_str())
        .map(str::to_owned)
}
fn snapshot(root: &Path) -> Vec<(PathBuf, Vec<u8>)> {
    fn walk(path: &Path, out: &mut Vec<(PathBuf, Vec<u8>)>) {
        for entry in fs::read_dir(path).unwrap() {
            let entry = entry.unwrap();
            if entry.file_type().unwrap().is_dir() {
                walk(&entry.path(), out);
            } else {
                out.push((entry.path(), fs::read(entry.path()).unwrap()));
            }
        }
    }
    let mut result = Vec::new();
    walk(root, &mut result);
    result.sort_by(|a, b| a.0.cmp(&b.0));
    result
}

#[test]
fn valid_doctor_is_read_only_and_has_stable_ids() {
    let workspace = Workspace::fixture("valid", Some("0.85.1"));
    let before = snapshot(&workspace.root);
    let output = workspace.command(&["doctor", "--json"]);
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    let json = report(&output);
    assert_eq!(json["schemaVersion"], 1);
    for id in [
        "PI_VERSION",
        "OPEN_AGENTS_VERSION",
        "AGENT_CONFLICT",
        "PACKAGE_DECLARATION",
        "PRIMARY_AGENT",
        "ADAPTER",
        "CONFIG",
    ] {
        assert_eq!(status(&json, id).as_deref(), Some("PASS"), "{id}: {json}");
    }
    assert_eq!(snapshot(&workspace.root), before);
}

#[test]
fn partial_init_is_idempotent_and_preserves_user_configuration() {
    let workspace = Workspace::fixture("partial", Some("0.85.1"));
    let first = workspace.command(&["init", "--yes"]);
    assert!(
        first.status.success(),
        "{}",
        String::from_utf8_lossy(&first.stderr)
    );
    let config = workspace.root.join(".xper/config.yaml");
    let agent = workspace.root.join(".pi/agents/xper.md");
    fs::write(&config, "harness:\n  adapter: pi\nprofile: custom\n").unwrap();
    fs::write(
        &agent,
        "---\nname: xper\nmode: primary\n---\nUser instructions.\n",
    )
    .unwrap();
    let before = snapshot(&workspace.root);
    let second = workspace.command(&["init", "--yes"]);
    assert!(
        second.status.success(),
        "{}",
        String::from_utf8_lossy(&second.stderr)
    );
    assert_eq!(snapshot(&workspace.root), before);
    let settings: Value =
        serde_json::from_slice(&fs::read(workspace.root.join(".pi/settings.json")).unwrap())
            .unwrap();
    assert_eq!(settings["theme"], "dark");
    assert_eq!(settings["packages"][0], "npm:pi-open-agents@0.1.22");
}

#[test]
fn incompatible_and_missing_dependencies_report_actions_without_writes() {
    let incompatible = Workspace::fixture("incompatible", Some("0.85.1"));
    let before = snapshot(&incompatible.root);
    let output = incompatible.command(&["doctor", "--json"]);
    assert!(!output.status.success());
    let json = report(&output);
    assert_eq!(
        status(&json, "OPEN_AGENTS_VERSION").as_deref(),
        Some("FAIL")
    );
    assert_eq!(status(&json, "AGENT_CONFLICT").as_deref(), Some("FAIL"));
    assert_eq!(
        status(&json, "PACKAGE_DECLARATION").as_deref(),
        Some("FAIL")
    );
    assert_eq!(snapshot(&incompatible.root), before);

    let missing = Workspace::fixture("partial", None);
    let before = snapshot(&missing.root);
    let output = missing.command(&["init", "--yes"]);
    assert!(!output.status.success());
    assert!(
        String::from_utf8_lossy(&output.stdout)
            .contains("npm install -g @mariozechner/pi-coding-agent")
    );
    assert_eq!(snapshot(&missing.root), before);

    fs::remove_file(
        missing
            .root
            .join(".pi/npm/node_modules/pi-open-agents/package.json"),
    )
    .unwrap();
    let output = missing.command(&["doctor", "--json"]);
    let json = report(&output);
    assert_eq!(
        status(&json, "OPEN_AGENTS_MISSING").as_deref(),
        Some("FAIL")
    );
    assert!(
        output
            .stdout
            .windows(b"pi install npm:pi-open-agents".len())
            .any(|window| window == b"pi install npm:pi-open-agents")
    );
}

#[test]
fn noninteractive_agent_repair_requires_confirmation() {
    let workspace = Workspace::fixture("incompatible", Some("0.85.1"));
    // Make the dependency compatible so the agent check is the only fatal preflight item.
    fs::write(
        workspace
            .root
            .join(".pi/npm/node_modules/pi-open-agents/package.json"),
        "{\"version\":\"0.1.22\"}",
    )
    .unwrap();
    fs::write(
        workspace.root.join(".pi/settings.json"),
        "{\"packages\":[\"npm:pi-open-agents@0.1.22\"]}",
    )
    .unwrap();
    let before = snapshot(&workspace.root);
    let output = workspace.command(&["init"]);
    assert!(!output.status.success());
    assert_eq!(snapshot(&workspace.root), before);
    assert!(String::from_utf8_lossy(&output.stderr).contains("--yes"));
}

#[test]
fn global_init_writes_only_global_scope_and_is_idempotent() {
    let workspace = Workspace::fixture("partial", Some("0.85.1"));
    let global_package = workspace
        .root
        .join("home/.pi/agent/npm/node_modules/pi-open-agents/package.json");
    fs::create_dir_all(global_package.parent().unwrap()).unwrap();
    fs::write(&global_package, "{\"version\":\"0.1.22\"}").unwrap();
    let first = workspace.command(&["init", "--global", "--yes"]);
    assert!(
        first.status.success(),
        "{}",
        String::from_utf8_lossy(&first.stderr)
    );
    assert!(
        workspace
            .root
            .join("home/.config/xper/config.yaml")
            .is_file()
    );
    assert!(
        workspace
            .root
            .join("home/.pi/agent/agents/xper.md")
            .is_file()
    );
    assert!(!workspace.root.join(".xper/config.yaml").exists());
    let before = snapshot(&workspace.root);
    let second = workspace.command(&["init", "--yes", "--global"]);
    assert!(second.status.success());
    assert_eq!(snapshot(&workspace.root), before);
}

#[test]
fn secrets_in_config_stop_init_without_echo_or_writes() {
    let workspace = Workspace::fixture("partial", Some("0.85.1"));
    let config = workspace.root.join(".xper/config.yaml");
    fs::create_dir_all(config.parent().unwrap()).unwrap();
    fs::write(&config, "api_key: forbidden-value\n").unwrap();
    let before = snapshot(&workspace.root);
    let output = workspace.command(&["init", "--yes"]);
    assert!(!output.status.success());
    assert_eq!(snapshot(&workspace.root), before);
    assert!(!String::from_utf8_lossy(&output.stdout).contains("forbidden-value"));
    assert!(!String::from_utf8_lossy(&output.stderr).contains("forbidden-value"));
}

#[test]
fn missing_package_blocks_init_with_install_command() {
    let workspace = Workspace::fixture("partial", Some("0.85.1"));
    fs::remove_file(
        workspace
            .root
            .join(".pi/npm/node_modules/pi-open-agents/package.json"),
    )
    .unwrap();
    let before = snapshot(&workspace.root);
    let output = workspace.command(&["init", "--yes"]);
    assert!(!output.status.success());
    assert!(String::from_utf8_lossy(&output.stdout).contains("pi install npm:pi-open-agents"));
    assert_eq!(snapshot(&workspace.root), before);
}

#[test]
fn confirmed_repair_backs_up_previous_agent() {
    let workspace = Workspace::fixture("partial", Some("0.85.1"));
    let agent = workspace.root.join(".pi/agents/xper.md");
    fs::create_dir_all(agent.parent().unwrap()).unwrap();
    let previous = "---\nname: xper\nmode: subagent\n---\nUser instructions.\n";
    fs::write(&agent, previous).unwrap();
    let output = workspace.command(&["init", "--yes"]);
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    assert_eq!(
        fs::read_to_string(agent.with_extension("md.bak")).unwrap(),
        previous
    );
    assert!(
        fs::read_to_string(&agent)
            .unwrap()
            .contains("mode: primary")
    );
    let before = snapshot(&workspace.root);
    assert!(workspace.command(&["init", "--yes"]).status.success());
    assert_eq!(snapshot(&workspace.root), before);
}

#[test]
fn doctor_detects_global_package_conflict_in_project_scope() {
    let workspace = Workspace::fixture("valid", Some("0.85.1"));
    let settings = workspace.root.join("home/.pi/agent/settings.json");
    fs::create_dir_all(settings.parent().unwrap()).unwrap();
    fs::write(&settings, "{\"packages\":[\"npm:pi-open-agents@0.2.0\"]}").unwrap();
    let output = workspace.command(&["doctor", "--json"]);
    assert!(!output.status.success());
    assert_eq!(
        status(&report(&output), "PACKAGE_DECLARATION").as_deref(),
        Some("FAIL")
    );
}

#[test]
fn global_init_ignores_invalid_project_config() {
    let workspace = Workspace::fixture("partial", Some("0.85.1"));
    let global_package = workspace
        .root
        .join("home/.pi/agent/npm/node_modules/pi-open-agents/package.json");
    fs::create_dir_all(global_package.parent().unwrap()).unwrap();
    fs::write(&global_package, "{\"version\":\"0.1.22\"}").unwrap();
    let project_config = workspace.root.join(".xper/config.yaml");
    fs::create_dir_all(project_config.parent().unwrap()).unwrap();
    fs::write(&project_config, "api_key: forbidden-value\n").unwrap();
    let output = workspace.command(&["init", "--global", "--yes"]);
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    assert_eq!(
        fs::read_to_string(project_config).unwrap(),
        "api_key: forbidden-value\n"
    );
}

#[test]
fn credentials_in_pi_settings_stop_init_before_writes() {
    let workspace = Workspace::fixture("partial", Some("0.85.1"));
    fs::write(
        workspace.root.join(".pi/settings.json"),
        "{\"apiKey\":\"forbidden-value\"}",
    )
    .unwrap();
    let before = snapshot(&workspace.root);
    let output = workspace.command(&["init", "--yes"]);
    assert!(!output.status.success());
    assert_eq!(snapshot(&workspace.root), before);
    assert!(!String::from_utf8_lossy(&output.stdout).contains("forbidden-value"));
}

#[test]
fn clap_help_and_bridge_argument_contract() {
    let workspace = Workspace::fixture("partial", None);
    let help = workspace.command(&["--help"]);
    assert!(help.status.success());
    let text = String::from_utf8_lossy(&help.stdout);
    for command in ["bridge", "doctor", "init"] {
        assert!(text.contains(command));
    }
    let version = workspace.command(&["--version"]);
    assert!(version.status.success());
    assert!(String::from_utf8_lossy(&version.stdout).contains("0.1.0"));
    let missing_stdio = workspace.command(&["bridge"]);
    assert!(!missing_stdio.status.success());
    assert!(String::from_utf8_lossy(&missing_stdio.stderr).contains("--stdio"));
}
