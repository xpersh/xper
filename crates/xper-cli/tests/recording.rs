//! Real bridge tests for the passive boundary, without a harness or model.

use serde_json::{Value, json};
use std::{
    fs,
    io::{BufRead, BufReader, Write},
    path::PathBuf,
    process::{Child, ChildStdin, ChildStdout, Command, Stdio},
    sync::atomic::{AtomicU64, Ordering},
    time::{SystemTime, UNIX_EPOCH},
};

struct Project(PathBuf);
static NEXT_PROJECT: AtomicU64 = AtomicU64::new(0);
impl Project {
    fn new() -> Self {
        let nonce = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let root = std::env::temp_dir().join(format!(
            "xper-recording-{}-{nonce}-{}",
            std::process::id(),
            NEXT_PROJECT.fetch_add(1, Ordering::Relaxed)
        ));
        fs::create_dir_all(root.join(".xper")).unwrap();
        fs::create_dir_all(root.join("home")).unwrap();
        Self(root)
    }
    fn command(&self) -> Command {
        let mut command = Command::new(env!("CARGO_BIN_EXE_xper"));
        command
            .current_dir(&self.0)
            .env("HOME", self.0.join("home"))
            .env("XDG_CONFIG_HOME", self.0.join("home/.config"));
        command
    }
}
impl Drop for Project {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}
struct Bridge {
    child: Child,
    input: ChildStdin,
    output: BufReader<ChildStdout>,
    next: u32,
}
impl Bridge {
    fn new(project: &Project, session: &str) -> Self {
        let mut child = project
            .command()
            .args(["bridge", "--stdio"])
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .spawn()
            .unwrap();
        let input = child.stdin.take().unwrap();
        let output = BufReader::new(child.stdout.take().unwrap());
        let mut bridge = Self {
            child,
            input,
            output,
            next: 0,
        };
        let init = bridge.request(
            "initialize",
            json!({"adapter":"test","adapterVersion":"1","capabilities":{}}),
        );
        assert_eq!(init["result"]["protocolVersion"], "1");
        let request = bridge.read();
        bridge.write(json!({"jsonrpc":"2.0","protocolVersion":"1","id":request["id"],"result":{"capabilities":{}}}));
        let capabilities = bridge.request("capabilities", json!({}));
        assert_eq!(
            capabilities["result"]["capabilities"]["eventRecording"],
            true
        );
        let attached = bridge.request(
            "session.attach",
            json!({"sessionId":session,"cwd":project.0,"mode":"test"}),
        );
        assert_eq!(attached["result"]["attached"], true, "{attached}");
        bridge
    }
    fn write(&mut self, value: Value) {
        writeln!(self.input, "{value}").unwrap();
        self.input.flush().unwrap();
    }
    fn read(&mut self) -> Value {
        let mut line = String::new();
        assert!(self.output.read_line(&mut line).unwrap() > 0);
        assert!(line.len() <= 65_537, "response exceeded framing limit");
        serde_json::from_str(&line).unwrap()
    }
    fn request(&mut self, method: &str, params: Value) -> Value {
        self.next += 1;
        self.write(json!({"jsonrpc":"2.0","protocolVersion":"1","id":self.next.to_string(),"method":method,"params":params}));
        self.read()
    }
}
impl Drop for Bridge {
    fn drop(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}
fn event(id: &str, kind: &str, data: Value) -> Value {
    json!({"schemaVersion":1,"eventId":id,"runId":"observed-run","occurredAt":100,"type":kind,"data":data})
}

#[test]
fn bridge_records_arbitrary_workflow_facts_and_never_authorizes_transitions() {
    let project = Project::new();
    let mut bridge = Bridge::new(&project, "session-a");
    for method in [
        "run.start",
        "assignment.start",
        "attempt.finish",
        "run.advance",
    ] {
        assert_eq!(bridge.request(method, json!({}))["error"]["code"], -32601);
    }
    let events = json!([
        event("1", "run.started", json!({})),
        event("2", "phase.entered", json!({"phase":"ship-immediately"})),
        event("3", "phase.entered", json!({"phase":"custom.research"})),
        event("4", "attempt.started", json!({"attemptId":"a"})),
        event(
            "5",
            "attempt.finished",
            json!({"attemptId":"a","outcome":"custom.verdict"})
        ),
        event(
            "6",
            "adapter.state",
            json!({"state":{"arbitrary":"opaque"}})
        ),
    ]);
    let appended = bridge.request("event.append", json!({"events":events}));
    assert_eq!(appended["result"]["accepted"], 6, "{appended}");
    assert_eq!(
        bridge.request("event.append", json!({"events":events}))["result"]["accepted"],
        0
    );
    let mut conflict = events[0].clone();
    conflict["data"] = json!({"changed":true});
    assert_eq!(
        bridge.request("event.append", json!({"events":[conflict]}))["error"]["code"],
        -32602
    );
    let status = bridge.request("run.status", json!({}));
    assert_eq!(status["result"]["run"]["phase"], "custom.research");
    assert_eq!(status["result"]["run"]["metrics"]["attemptsFinished"], 1);
    assert_eq!(
        status["result"]["run"]["metrics"]["costMicros"],
        Value::Null
    );
    drop(bridge);
    let mut reopened = Bridge::new(&project, "session-a");
    assert_eq!(
        reopened.request("run.status", json!({}))["result"]["timeline"],
        events
    );
    let mut other = Bridge::new(&project, "session-b");
    assert_eq!(
        other.request("run.status", json!({}))["result"]["run"],
        Value::Null
    );
    assert_eq!(
        other.request(
            "event.append",
            json!({"events":[event("7","anything",json!({}))]})
        )["error"]["code"],
        -32602
    );
    let output = project
        .command()
        .args(["status", "--json"])
        .output()
        .unwrap();
    assert!(output.status.success());
    let cli: Value = serde_json::from_slice(&output.stdout).unwrap();
    assert_eq!(cli["timeline"], events);
    let missing = project
        .command()
        .args(["status", "--run", "absent", "--json"])
        .output()
        .unwrap();
    assert!(!missing.status.success());
    assert!(String::from_utf8_lossy(&missing.stderr).contains("unknown run ID"));
}

#[test]
fn configuration_queries_resolve_models_and_deliver_adapter_policy_without_interpreting_it() {
    let project = Project::new();
    let mut configuration = json!({
        "profile":"local",
        "contexts":{"personal":{"allowed_providers":["local"]}},
        "profiles":{"local":{"context":"personal","roles":{"researcher":{"provider":"local","model":"small","thinking":"off"}}}},
        "workflow":{"knowledge":{"humanGates":["unknown-to-rust"],"customRule":true}}
    });
    let path = project.0.join(".xper/config.yaml");
    fs::write(&path, configuration.to_string()).unwrap();
    let mut bridge = Bridge::new(&project, "config-session");
    assert_eq!(
        bridge.request("configuration.resolve", json!({}))["error"]["code"],
        -32602
    );
    let catalog = json!({"models":[{"provider":"local","model":"small","reasoning":false}]});
    let result = bridge.request("configuration.resolve", catalog.clone());
    assert_eq!(result["result"]["adapterConfig"]["customRule"], true);
    assert_eq!(
        result["result"]["routing"]["routes"]["researcher"][0]["model"],
        "small"
    );
    configuration["profiles"]["local"]["roles"]["researcher"]["thinking"] = json!("high");
    fs::write(&path, configuration.to_string()).unwrap();
    assert_eq!(
        bridge.request("configuration.resolve", catalog)["error"]["code"],
        -32602
    );
    assert_eq!(
        bridge.request("run.status", json!({}))["result"]["run"],
        Value::Null
    );
}

#[test]
fn recorded_history_is_paged_with_stable_event_cursors() {
    let project = Project::new();
    let mut bridge = Bridge::new(&project, "large-history");
    for i in 0..12 {
        let appended=bridge.request("event.append",json!({"events":[event(&format!("event-{i}"),"custom.data",json!({"text":"x".repeat(12_000)}))]}));
        assert_eq!(appended["result"]["accepted"], 1, "{appended}");
    }
    let mut after = Value::Null;
    let mut ids = Vec::new();
    loop {
        let mut params = json!({"runId":"observed-run","limit":3});
        if !after.is_null() {
            params["after"] = after;
        }
        let page = bridge.request("run.status", params);
        let timeline = page["result"]["timeline"].as_array().unwrap();
        assert!(timeline.len() <= 3);
        ids.extend(
            timeline
                .iter()
                .map(|item| item["eventId"].as_str().unwrap().to_owned()),
        );
        after = page["result"]["nextCursor"].clone();
        if after.is_null() {
            break;
        }
    }
    assert_eq!(
        ids,
        (0..12).map(|i| format!("event-{i}")).collect::<Vec<_>>()
    );
    assert_eq!(
        bridge.request("run.status", json!({"after":"absent"}))["error"]["code"],
        -32602
    );
    assert_eq!(
        bridge.request(
            "event.append",
            json!({"events":[event("large","custom.data",json!({"text":"x".repeat(42_000)}))]})
        )["error"]["code"],
        -32602
    );
}

#[test]
fn large_payloads_never_produce_invalid_frames_or_block_history_paging() {
    let project = Project::new();
    let mut bridge = Bridge::new(&project, "bounded-messages");
    let oversized_id = event(&"x".repeat(34_000), "custom", json!({}));
    assert_eq!(
        bridge.request("event.append", json!({"events":[oversized_id]}))["error"]["code"],
        -32602
    );
    let long_phase = event(
        "large-label",
        "phase.entered",
        json!({"phase":"x".repeat(38_000)}),
    );
    assert_eq!(
        bridge.request("event.append", json!({"events":[long_phase.clone()]}))["result"]["accepted"],
        1
    );
    let status = bridge.request("run.status", json!({}));
    assert_eq!(status["result"]["timeline"], json!([long_phase]));
    assert_eq!(status["result"]["run"]["phase"], Value::Null);
    fs::write(
        project.0.join(".xper/config.yaml"),
        json!({"workflow":{"knowledge":{"opaque":"z".repeat(70_000)}}}).to_string(),
    )
    .unwrap();
    assert_eq!(
        bridge.request("configuration.resolve", json!({}))["error"]["code"],
        -32003
    );
    assert_eq!(bridge.request("ping", json!({}))["result"]["pong"], true);
}

#[cfg(unix)]
#[test]
fn read_only_workspace_can_resolve_configuration_and_acknowledge_volatile_recording() {
    use std::os::unix::fs::PermissionsExt;
    let project = Project::new();
    fs::remove_dir(project.0.join(".xper")).unwrap();
    fs::set_permissions(&project.0, fs::Permissions::from_mode(0o555)).unwrap();
    let mut bridge = Bridge::new(&project, "read-only");
    let config = bridge.request("configuration.resolve", json!({}));
    let recorded = bridge.request(
        "event.append",
        json!({"events":[event("volatile","custom",json!({}))]}),
    );
    // Restore before assertions so failed checks still leave a removable fixture.
    fs::set_permissions(&project.0, fs::Permissions::from_mode(0o755)).unwrap();
    assert_eq!(config["result"]["routing"], Value::Null, "{config}");
    assert!(config["result"].is_object(), "{config}");
    assert_eq!(recorded["result"]["durability"], "volatile", "{recorded}");
    assert!(!project.0.join(".xper/events.sqlite").exists());
}
