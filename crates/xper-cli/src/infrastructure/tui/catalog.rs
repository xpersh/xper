//! Child-process client for the public, adapter-owned inspection contract.

use std::{
    fs,
    io::{self, BufRead, BufReader, Write},
    path::{Path, PathBuf},
    process::{Child, ChildStdin, Command, Stdio},
    sync::{
        Arc,
        atomic::{AtomicBool, Ordering},
        mpsc,
    },
    thread,
    time::{Duration, Instant},
};

use serde_json::{Value, json};

const FRAME_LIMIT: usize = 1_048_576;

fn read_frame(reader: &mut impl BufRead) -> io::Result<String> {
    // The contract limits payload bytes before LF, including across read chunks.
    let mut frame = Vec::new();
    loop {
        let available = reader.fill_buf()?;
        if available.is_empty() {
            return Err(io::Error::other("Pi inspection helper closed"));
        }
        let newline = available.iter().position(|b| *b == b'\n');
        let count = newline.map_or(available.len(), |i| i + 1);
        let payload_bytes = frame.len() + count - usize::from(newline.is_some());
        if payload_bytes > FRAME_LIMIT {
            return Err(io::Error::other("Pi inspection response exceeds limit"));
        }
        frame.extend_from_slice(&available[..count]);
        reader.consume(count);
        if newline.is_some() {
            return String::from_utf8(frame).map_err(io::Error::other);
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub(super) struct Role {
    pub id: String,
    pub label: String,
    pub guidance: String,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub(super) struct Model {
    pub provider: String,
    pub model: String,
    pub reasoning: bool,
}

fn text(value: &Value, key: &str) -> io::Result<String> {
    value
        .get(key)
        .and_then(Value::as_str)
        .filter(|s| !s.is_empty())
        .map(str::to_owned)
        .ok_or_else(|| io::Error::other("Invalid adapter inspection response"))
}

pub(super) fn roles(value: Value) -> io::Result<Vec<Role>> {
    if value.get("adapter").and_then(Value::as_str) != Some("pi")
        || value.get("version").and_then(Value::as_str) != Some(env!("CARGO_PKG_VERSION"))
    {
        return Err(io::Error::other(
            "Incompatible Pi inspection helper; rebuild the adapter",
        ));
    }
    value
        .get("roles")
        .and_then(Value::as_array)
        .ok_or_else(|| io::Error::other("Invalid role catalog"))?
        .iter()
        .map(|item| {
            Ok(Role {
                id: text(item, "id")?,
                label: text(item, "label")?,
                guidance: text(item, "guidance")?,
            })
        })
        .collect()
}

pub(super) fn models(value: Value) -> io::Result<Vec<Model>> {
    value
        .get("models")
        .and_then(Value::as_array)
        .ok_or_else(|| io::Error::other("Invalid model catalog"))?
        .iter()
        .map(|item| {
            Ok(Model {
                provider: text(item, "provider")?,
                model: text(item, "model")?,
                reasoning: item
                    .get("reasoning")
                    .and_then(Value::as_bool)
                    .ok_or_else(|| io::Error::other("Invalid model capability"))?,
            })
        })
        .collect()
}

fn helper_path(root: &Path) -> io::Result<PathBuf> {
    let home = std::env::var_os("PI_CODING_AGENT_DIR")
        .map(PathBuf::from)
        .or_else(|| std::env::var_os("HOME").map(|h| PathBuf::from(h).join(".pi/agent")))
        .ok_or_else(|| io::Error::other("HOME is not set"))?;
    for directory in [
        root.join("adapters/pi"),
        home.join("npm/node_modules/@xper/adapter-pi"),
    ] {
        let manifest = directory.join("package.json");
        if !manifest.exists() {
            continue;
        }
        let package: Value = serde_json::from_str(&fs::read_to_string(manifest)?)?;
        if package.get("name").and_then(Value::as_str) != Some("@xper/adapter-pi")
            || package.get("version").and_then(Value::as_str) != Some(env!("CARGO_PKG_VERSION"))
        {
            return Err(io::Error::other(
                "Incompatible Pi adapter; install the matching xper adapter",
            ));
        }
        let entry = directory.join("dist/inspection/cli.js");
        if entry.is_file() {
            return Ok(entry);
        }
        return Err(io::Error::other(
            "Pi inspection helper is not built; run npm run build --workspace @xper/adapter-pi",
        ));
    }
    Err(io::Error::other(
        "Pi adapter not found; run xper doctor for installation guidance",
    ))
}

pub(super) struct Catalog {
    child: Child,
    input: Option<ChildStdin>,
    output: mpsc::Receiver<io::Result<String>>,
    next_id: u64,
}

impl Catalog {
    pub fn start(root: &Path) -> io::Result<Self> {
        let mut command = Command::new("node");
        command.arg(helper_path(root)?).current_dir(root);
        Self::spawn(command)
    }

    fn spawn(mut command: Command) -> io::Result<Self> {
        let mut child = command
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .spawn()?;
        let input = child.stdin.take().expect("piped stdin");
        let output = child.stdout.take().expect("piped stdout");
        let (sender, receiver) = mpsc::channel();
        thread::spawn(move || {
            let mut reader = BufReader::new(output);
            loop {
                // Bound accumulation before decoding an untrusted helper frame.
                let result = read_frame(&mut reader);
                let failed = result.is_err();
                if sender.send(result).is_err() || failed {
                    break;
                }
            }
        });
        Ok(Self {
            child,
            input: Some(input),
            output: receiver,
            next_id: 0,
        })
    }

    pub fn request(
        &mut self,
        method: &str,
        params: Value,
        active: &Arc<AtomicBool>,
    ) -> io::Result<Value> {
        self.next_id += 1;
        let id = self.next_id.to_string();
        writeln!(
            self.input.as_mut().expect("open helper input"),
            "{}",
            json!({"schemaVersion":1,"id":id,"method":method,"params":params})
        )?;
        self.input.as_mut().expect("open helper input").flush()?;
        let start = Instant::now();
        loop {
            if !active.load(Ordering::Relaxed) {
                return Err(io::Error::other("Catalog request cancelled"));
            }
            if start.elapsed() > Duration::from_secs(12) {
                return Err(io::Error::new(
                    io::ErrorKind::TimedOut,
                    "Pi catalog timed out; refresh to retry",
                ));
            }
            match self.output.recv_timeout(Duration::from_millis(40)) {
                Ok(result) => {
                    let response: Value = serde_json::from_str(&result?)?;
                    if response.get("schemaVersion") != Some(&json!(1))
                        || response.get("id").and_then(Value::as_str) != Some(&id)
                    {
                        return Err(io::Error::other(
                            "Invalid adapter inspection response identity",
                        ));
                    }
                    if let Some(error) = response.get("error") {
                        return Err(io::Error::other(format!(
                            "{}: {}",
                            text(error, "code")?,
                            text(error, "message")?
                        )));
                    }
                    return response
                        .get("result")
                        .cloned()
                        .ok_or_else(|| io::Error::other("Missing adapter inspection result"));
                }
                Err(mpsc::RecvTimeoutError::Timeout) => {}
                Err(_) => return Err(io::Error::other("Pi inspection helper disconnected")),
            }
        }
    }
}

impl Drop for Catalog {
    fn drop(&mut self) {
        // Closing the screen must also reap the helper; no resident inspection process.
        drop(self.input.take());
        let deadline = Instant::now() + Duration::from_millis(250);
        while Instant::now() < deadline {
            if self.child.try_wait().ok().flatten().is_some() {
                return;
            }
            thread::sleep(Duration::from_millis(10));
        }
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn frame_limit_excludes_lf_and_bounds_unterminated_payloads() {
        let exact = format!("{}\n", "x".repeat(FRAME_LIMIT));
        let mut reader = BufReader::with_capacity(8192, exact.as_bytes());
        assert_eq!(read_frame(&mut reader).unwrap().len(), FRAME_LIMIT + 1);

        for ending in ["", "\n"] {
            let oversized = format!("{}{ending}", "x".repeat(FRAME_LIMIT + 1));
            let mut reader = BufReader::with_capacity(8192, oversized.as_bytes());
            assert!(
                read_frame(&mut reader)
                    .unwrap_err()
                    .to_string()
                    .contains("exceeds limit")
            );
        }
    }

    #[test]
    fn decodes_only_public_catalog_metadata() {
        assert_eq!(
            models(json!({"models":[{"provider":"custom","model":"model:1","reasoning":false}]}))
                .unwrap()[0]
                .model,
            "model:1"
        );
        assert!(models(json!({"models":[{"provider":"p","model":"m"}]})).is_err());
        assert!(roles(json!({"adapter":"pi","version":"future","roles":[]})).is_err());
    }
}
