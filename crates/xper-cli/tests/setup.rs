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
    assert_eq!(json["checks"].as_array().unwrap().len(), 4);
    for id in ["PI_VERSION", "PI_SETTINGS", "ADAPTER", "CONFIG"] {
        assert_eq!(status(&json, id).as_deref(), Some("PASS"), "{id}: {json}");
    }
    assert_eq!(snapshot(&workspace.root), before);
}

#[test]
fn doctor_accepts_stable_pi_versions_within_the_inclusive_numeric_range() {
    for version in ["0.85.1", "0.85.10", "0.86.0", "0.87.0", "0.87.1"] {
        let workspace = Workspace::fixture("valid", Some(version));
        let before = snapshot(&workspace.root);
        let output = workspace.command(&["doctor", "--json"]);
        let json = report(&output);
        assert!(output.status.success(), "Pi {version}: {json}");
        assert_eq!(
            status(&json, "PI_VERSION").as_deref(),
            Some("PASS"),
            "Pi {version}: {json}"
        );
        assert_eq!(snapshot(&workspace.root), before, "Pi {version}");
    }
}

#[test]
fn doctor_rejects_unsupported_and_noncanonical_pi_versions_without_writes() {
    for version in [
        "0.85.0",
        "0.87.2",
        "0.100.0",
        "1.0.0",
        "",
        "0.87",
        "0.87.1.0",
        "v0.87.1",
        "0.87.1-rc.1",
        "0.87.1+build.1",
        "00.87.1",
        "0.087.1",
        "0.87.01",
        "+0.87.1",
        "0.87.-1",
        "0.８７.1",
        "0.87.18446744073709551616",
        "0.87.1\nunexpected output",
    ] {
        let workspace = Workspace::fixture("valid", Some(version));
        let before = snapshot(&workspace.root);
        let output = workspace.command(&["doctor", "--json"]);
        let json = report(&output);
        assert!(!output.status.success(), "Pi {version:?}: {json}");
        assert_eq!(
            status(&json, "PI_VERSION").as_deref(),
            Some("FAIL"),
            "Pi {version:?}: {json}"
        );
        let check = json["checks"]
            .as_array()
            .unwrap()
            .iter()
            .find(|check| check["id"] == "PI_VERSION")
            .unwrap();
        let evidence = check["evidence"].as_str().unwrap();
        let action = check["action"].as_str().unwrap();
        for bound in ["0.85.1", "0.87.1"] {
            assert!(evidence.contains(bound), "Pi {version:?}: {check}");
            assert!(action.contains(bound), "Pi {version:?}: {check}");
        }
        assert_eq!(snapshot(&workspace.root), before, "Pi {version:?}");
    }
}

#[test]
fn init_accepts_the_latest_supported_pi_version() {
    let workspace = Workspace::fixture("partial", Some("0.87.1"));
    let output = workspace.command(&["init", "--yes"]);
    assert!(
        output.status.success(),
        "stdout: {}\nstderr: {}",
        String::from_utf8_lossy(&output.stdout),
        String::from_utf8_lossy(&output.stderr)
    );
    assert!(workspace.root.join(".xper/config.yaml").is_file());
    assert!(!workspace.root.join(".pi/agents/xper.md").exists());
}

#[test]
fn init_rejects_pi_versions_outside_the_supported_range_without_writes() {
    for version in ["0.85.0", "0.87.2"] {
        let workspace = Workspace::fixture("partial", Some(version));
        let before = snapshot(&workspace.root);
        let output = workspace.command(&["init", "--yes"]);
        assert!(!output.status.success(), "Pi {version}");
        let stdout = String::from_utf8_lossy(&output.stdout);
        let version_check = stdout
            .lines()
            .find(|line| line.contains("PI_VERSION"))
            .unwrap();
        assert!(version_check.starts_with("FAIL"), "{stdout}");
        for bound in ["0.85.1", "0.87.1"] {
            assert!(version_check.contains(bound), "{stdout}");
        }
        assert_eq!(snapshot(&workspace.root), before, "Pi {version}");
    }
}

#[test]
fn partial_init_is_idempotent_and_preserves_user_configuration() {
    let workspace = Workspace::fixture("partial", Some("0.85.1"));
    let pi_before = snapshot(&workspace.root.join(".pi"));
    let first = workspace.command(&["init"]);
    assert!(
        first.status.success(),
        "{}",
        String::from_utf8_lossy(&first.stderr)
    );
    let config = workspace.root.join(".xper/config.yaml");
    assert_eq!(
        fs::read_to_string(&config).unwrap(),
        "harness:\n  adapter: pi\n"
    );
    assert_eq!(snapshot(&workspace.root.join(".pi")), pi_before);
    fs::write(&config, "harness:\n  adapter: pi\nprofile: custom\n").unwrap();
    let before = snapshot(&workspace.root);
    let second = workspace.command(&["init", "--yes"]);
    assert!(second.status.success());
    assert_eq!(snapshot(&workspace.root), before);
    assert_eq!(
        fs::read_to_string(workspace.root.join(".gitignore")).unwrap(),
        "/.xper/config.local.yaml\n"
    );
}

#[test]
fn existing_agent_packages_and_definitions_do_not_block_doctor_or_init() {
    let workspace = Workspace::fixture("incompatible", Some("0.85.1"));
    let pi_before = snapshot(&workspace.root.join(".pi"));
    let before = snapshot(&workspace.root);
    let output = workspace.command(&["doctor", "--json"]);
    let json = report(&output);
    assert!(output.status.success(), "{json}");
    for removed in [
        "OPEN_AGENTS_VERSION",
        "OPEN_AGENTS_MISSING",
        "AGENT_CONFLICT",
        "PACKAGE_DECLARATION",
        "PRIMARY_AGENT",
    ] {
        assert!(status(&json, removed).is_none(), "{removed}: {json}");
    }
    assert_eq!(snapshot(&workspace.root), before);
    assert!(workspace.command(&["init"]).status.success());
    assert_eq!(snapshot(&workspace.root.join(".pi")), pi_before);
    let before = snapshot(&workspace.root);
    assert!(workspace.command(&["init", "--yes"]).status.success());
    assert_eq!(snapshot(&workspace.root), before);
}

#[test]
fn missing_pi_reports_an_action_and_blocks_init_without_writes() {
    let workspace = Workspace::fixture("partial", None);
    let before = snapshot(&workspace.root);
    let output = workspace.command(&["doctor", "--json"]);
    assert!(!output.status.success());
    assert_eq!(
        status(&report(&output), "PI_MISSING").as_deref(),
        Some("FAIL")
    );
    let output = workspace.command(&["init", "--yes"]);
    assert!(!output.status.success());
    assert!(
        String::from_utf8_lossy(&output.stdout)
            .contains("npm install -g @earendil-works/pi-coding-agent")
    );
    assert_eq!(snapshot(&workspace.root), before);
}

#[test]
fn mismatched_adapter_version_still_blocks_init_without_writes() {
    let workspace = Workspace::fixture("valid", Some("0.85.1"));
    fs::write(
        workspace.root.join("adapters/pi/package.json"),
        "{\"version\":\"0.0.1\"}",
    )
    .unwrap();
    let before = snapshot(&workspace.root);
    let output = workspace.command(&["doctor", "--json"]);
    assert!(!output.status.success());
    assert_eq!(status(&report(&output), "ADAPTER").as_deref(), Some("FAIL"));
    assert!(!workspace.command(&["init"]).status.success());
    assert_eq!(snapshot(&workspace.root), before);
}

#[test]
fn global_init_writes_only_global_configuration_and_is_idempotent() {
    let workspace = Workspace::fixture("partial", Some("0.85.1"));
    let pi_before = snapshot(&workspace.root.join(".pi"));
    let first = workspace.command(&["init", "--global"]);
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
    assert!(!workspace.root.join("home/.pi").exists());
    assert!(!workspace.root.join(".xper/config.yaml").exists());
    assert!(!workspace.root.join(".gitignore").exists());
    assert_eq!(snapshot(&workspace.root.join(".pi")), pi_before);
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
fn malformed_or_unsupported_configuration_blocks_init_without_writes() {
    for content in ["harness:\n\tadapter: pi\n", "harness:\n  adapter: other\n"] {
        let workspace = Workspace::fixture("partial", Some("0.85.1"));
        let config = workspace.root.join(".xper/config.yaml");
        fs::create_dir_all(config.parent().unwrap()).unwrap();
        fs::write(&config, content).unwrap();
        let before = snapshot(&workspace.root);
        let output = workspace.command(&["doctor", "--json"]);
        assert!(!output.status.success());
        assert_eq!(status(&report(&output), "CONFIG").as_deref(), Some("FAIL"));
        assert!(!workspace.command(&["init"]).status.success());
        assert_eq!(snapshot(&workspace.root), before);
    }
}

#[test]
fn init_does_not_create_pi_settings_agents_or_packages() {
    let workspace = Workspace::fixture("partial", Some("0.85.1"));
    fs::remove_file(workspace.root.join(".pi/settings.json")).unwrap();
    let output = workspace.command(&["init"]);
    assert!(output.status.success());
    assert!(workspace.root.join(".xper/config.yaml").is_file());
    assert!(snapshot(&workspace.root.join(".pi")).is_empty());
}

#[test]
fn global_agent_packages_and_existing_backups_are_preserved() {
    let workspace = Workspace::fixture("valid", Some("0.85.1"));
    let pi_home = workspace.root.join("home/.pi/agent");
    fs::create_dir_all(pi_home.join("agents")).unwrap();
    fs::write(
        pi_home.join("settings.json"),
        r#"{"packages":["npm:pi-open-agents@0.2.0",{"source":"npm:other-agent-manager@1.0.0","extensions":[]}]}"#,
    )
    .unwrap();
    fs::write(pi_home.join("agents/xper.md"), "Existing user agent").unwrap();
    fs::write(pi_home.join("agents/xper.md.bak"), "Existing backup").unwrap();
    let pi_before = snapshot(&pi_home);
    let output = workspace.command(&["doctor", "--json"]);
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stdout)
    );
    assert!(
        workspace
            .command(&["init", "--global", "--yes"])
            .status
            .success()
    );
    assert_eq!(snapshot(&pi_home), pi_before);
}

#[test]
fn global_init_ignores_invalid_project_config() {
    let workspace = Workspace::fixture("partial", Some("0.85.1"));
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
fn malformed_pi_settings_fail_in_the_selected_scope_without_writes() {
    for (settings_path, args) in [
        (".pi/settings.json", vec!["init"]),
        ("home/.pi/agent/settings.json", vec!["init", "--global"]),
    ] {
        for content in ["{invalid", "[]"] {
            let workspace = Workspace::fixture("partial", Some("0.85.1"));
            let settings = workspace.root.join(settings_path);
            fs::create_dir_all(settings.parent().unwrap()).unwrap();
            fs::write(&settings, content).unwrap();
            let before = snapshot(&workspace.root);
            let output = workspace.command(&args);
            assert!(!output.status.success());
            assert!(String::from_utf8_lossy(&output.stdout).contains("PI_SETTINGS"));
            assert_eq!(snapshot(&workspace.root), before);
        }
    }
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
