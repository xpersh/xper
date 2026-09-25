//! The `xper` command-line entry point.

mod setup;

use std::io::{self, BufReader, Write};
use std::process::ExitCode;
use std::sync::mpsc::{self, Receiver};
use std::time::{Duration, Instant};

use clap::{Parser, Subcommand};
use serde_json::{Value, json};
use xper_protocol::{FrameRead, Message, RpcError, code};

const HANDSHAKE_TIMEOUT: Duration = Duration::from_secs(5);

type Incoming = Result<FrameRead, io::Error>;

#[derive(Parser)]
#[command(
    name = "xper",
    version,
    about = "Extreme Programming workflow setup and diagnostics"
)]
struct Cli {
    #[command(subcommand)]
    command: Commands,
}

#[derive(Subcommand)]
enum Commands {
    /// Run the bridge over standard input and output.
    Bridge {
        /// Use JSONL over standard input and output.
        #[arg(long, required = true)]
        stdio: bool,
    },
    /// Inspect the installation without modifying it.
    Doctor {
        /// Emit machine-readable JSON checks.
        #[arg(long)]
        json: bool,
    },
    /// Prepare xper in this project or in the global user scope.
    Init {
        /// Prepare the user-wide scope instead of this project.
        #[arg(long)]
        global: bool,
        /// Confirm agent creation or repair in non-interactive use.
        #[arg(long)]
        yes: bool,
    },
}

fn main() -> ExitCode {
    let result = match Cli::parse().command {
        Commands::Bridge { stdio: true } => run_bridge().map(|()| true),
        Commands::Bridge { stdio: false } => unreachable!("clap requires --stdio"),
        Commands::Doctor { json } => setup::doctor(json),
        Commands::Init { global, yes } => setup::init(global, yes),
    };
    match result {
        Ok(true) => ExitCode::SUCCESS,
        Ok(false) => ExitCode::FAILURE,
        Err(error) => {
            eprintln!("xper: {error}");
            ExitCode::FAILURE
        }
    }
}

fn reader_channel() -> Receiver<Incoming> {
    let (sender, receiver) = mpsc::channel();
    std::thread::spawn(move || {
        let stdin = io::stdin();
        let mut reader = BufReader::new(stdin.lock());
        loop {
            let frame = xper_protocol::read_frame(&mut reader);
            let done = !matches!(frame, Ok(FrameRead::Data(_) | FrameRead::TooLarge));
            if sender.send(frame).is_err() || done {
                break;
            }
        }
    });
    receiver
}

fn send(writer: &mut impl Write, message: Message) -> io::Result<()> {
    writer.write_all(&message.to_frame())?;
    writer.flush()
}

fn respond(writer: &mut impl Write, id: String, result: Value) -> io::Result<()> {
    send(writer, Message::Response { id, result })
}

fn reject(writer: &mut impl Write, id: Option<String>, error: RpcError) -> io::Result<()> {
    send(writer, Message::Error { id, error })
}

fn invalid_params(writer: &mut impl Write, id: String) -> io::Result<()> {
    reject(
        writer,
        Some(id),
        RpcError::new(code::INVALID_PARAMS, "invalid params"),
    )
}

fn empty_params(params: &Value) -> bool {
    params.as_object().is_some_and(serde_json::Map::is_empty)
}

fn capability_map(value: &Value) -> bool {
    value
        .as_object()
        .is_some_and(|map| map.values().all(Value::is_boolean))
}

struct BridgeState {
    initialized: bool,
    declared_capabilities: Option<Value>,
    pending_capabilities: Option<(String, Instant)>,
    session_id: Option<String>,
}

impl BridgeState {
    fn new() -> Self {
        Self {
            initialized: false,
            declared_capabilities: None,
            pending_capabilities: None,
            session_id: None,
        }
    }

    fn deadline(&self) -> Option<Duration> {
        self.pending_capabilities
            .as_ref()
            .map(|(_, sent_at)| HANDSHAKE_TIMEOUT.saturating_sub(sent_at.elapsed()))
    }

    fn handle(&mut self, message: Message, writer: &mut impl Write) -> io::Result<bool> {
        match message {
            Message::Request { id, method, params } => {
                self.handle_request(id, &method, &params, writer)
            }
            Message::Response { id, result } => {
                self.handle_peer_capabilities(&id, &result)?;
                Ok(true)
            }
            Message::Error { id, error } => {
                if self
                    .pending_capabilities
                    .as_ref()
                    .map(|(expected, _)| expected.as_str())
                    == id.as_deref()
                {
                    return Err(io::Error::other(format!(
                        "adapter rejected capabilities request: {} ({})",
                        error.message, error.code
                    )));
                }
                eprintln!("bridge: unexpected error response: {}", error.message);
                Ok(true)
            }
        }
    }

    fn handle_peer_capabilities(&mut self, id: &str, result: &Value) -> io::Result<()> {
        if self
            .pending_capabilities
            .as_ref()
            .map(|(expected, _)| expected.as_str())
            != Some(id)
        {
            eprintln!("bridge: unexpected response id {id}");
            return Ok(());
        }
        if result.get("capabilities") != self.declared_capabilities.as_ref() {
            return Err(io::Error::other(
                "adapter capabilities changed during handshake",
            ));
        }
        self.pending_capabilities = None;
        Ok(())
    }

    fn handle_request(
        &mut self,
        id: String,
        method: &str,
        params: &Value,
        writer: &mut impl Write,
    ) -> io::Result<bool> {
        if method == "shutdown" {
            if !empty_params(params) {
                invalid_params(writer, id)?;
                return Ok(true);
            }
            respond(writer, id, json!({ "ok": true }))?;
            return Ok(false);
        }
        if method == "initialize" {
            if self.initialized {
                respond(
                    writer,
                    id,
                    json!({
                        "protocolVersion": xper_protocol::PROTOCOL_VERSION,
                        "bridgeVersion": env!("CARGO_PKG_VERSION")
                    }),
                )?;
                return Ok(true);
            }
            let adapter = params
                .get("adapter")
                .and_then(Value::as_str)
                .filter(|s| !s.is_empty());
            let version = params
                .get("adapterVersion")
                .and_then(Value::as_str)
                .filter(|s| !s.is_empty());
            let capabilities = params.get("capabilities");
            if adapter.is_none() || version.is_none() || !capabilities.is_some_and(capability_map) {
                invalid_params(writer, id)?;
                return Ok(true);
            }
            self.initialized = true;
            self.declared_capabilities = capabilities.cloned();
            respond(
                writer,
                id,
                json!({
                    "protocolVersion": xper_protocol::PROTOCOL_VERSION,
                    "bridgeVersion": env!("CARGO_PKG_VERSION")
                }),
            )?;
            let request_id = "bridge-1".to_owned();
            send(
                writer,
                Message::Request {
                    id: request_id.clone(),
                    method: "capabilities".to_owned(),
                    params: json!({}),
                },
            )?;
            self.pending_capabilities = Some((request_id, Instant::now()));
            return Ok(true);
        }
        if !self.initialized {
            reject(
                writer,
                Some(id),
                RpcError::new(code::NOT_INITIALIZED, "initialize first"),
            )?;
            return Ok(true);
        }
        match method {
            "capabilities" if empty_params(params) => {
                respond(
                    writer,
                    id,
                    json!({
                        "capabilities": { "bidirectionalRequests": true },
                        "maxFrameBytes": xper_protocol::MAX_FRAME_BYTES
                    }),
                )?;
            }
            "ping" if empty_params(params) => respond(writer, id, json!({ "pong": true }))?,
            "session.attach" => {
                let session_id = params
                    .get("sessionId")
                    .and_then(Value::as_str)
                    .filter(|s| !s.is_empty());
                let cwd = params
                    .get("cwd")
                    .and_then(Value::as_str)
                    .filter(|s| !s.is_empty());
                let mode = params
                    .get("mode")
                    .and_then(Value::as_str)
                    .filter(|s| !s.is_empty());
                if let (Some(session_id), Some(_), Some(_)) = (session_id, cwd, mode) {
                    self.session_id = Some(session_id.to_owned());
                    respond(writer, id, json!({ "attached": true }))?;
                } else {
                    invalid_params(writer, id)?;
                }
            }
            "session.detach" => {
                let session_id = params
                    .get("sessionId")
                    .and_then(Value::as_str)
                    .filter(|s| !s.is_empty());
                if session_id.is_some_and(|value| self.session_id.as_deref() == Some(value)) {
                    self.session_id = None;
                    respond(writer, id, json!({ "detached": true }))?;
                } else {
                    invalid_params(writer, id)?;
                }
            }
            "event.ingest" => {
                let session_id = params
                    .get("sessionId")
                    .and_then(Value::as_str)
                    .filter(|s| !s.is_empty());
                let kind = params
                    .get("kind")
                    .and_then(Value::as_str)
                    .filter(|s| !s.is_empty());
                let source = params
                    .get("source")
                    .and_then(Value::as_str)
                    .filter(|s| !s.is_empty());
                if session_id.is_some_and(|value| self.session_id.as_deref() == Some(value))
                    && kind == Some("error")
                    && source.is_some()
                {
                    respond(writer, id, json!({ "accepted": true }))?;
                } else {
                    invalid_params(writer, id)?;
                }
            }
            "capabilities" | "ping" => invalid_params(writer, id)?,
            _ => {
                let mut error = RpcError::new(code::METHOD_NOT_FOUND, "method not found");
                error.data = Some(json!({ "method": method }));
                reject(writer, Some(id), error)?;
            }
        }
        Ok(true)
    }
}

fn run_bridge() -> io::Result<()> {
    let receiver = reader_channel();
    let stdout = io::stdout();
    let mut writer = stdout.lock();
    let mut state = BridgeState::new();
    loop {
        let incoming = match state.deadline() {
            Some(deadline) => receiver
                .recv_timeout(deadline)
                .map_err(|error| match error {
                    mpsc::RecvTimeoutError::Timeout => io::Error::new(
                        io::ErrorKind::TimedOut,
                        "adapter capabilities request timed out",
                    ),
                    mpsc::RecvTimeoutError::Disconnected => {
                        io::Error::new(io::ErrorKind::UnexpectedEof, "stdin reader stopped")
                    }
                })?,
            None => receiver.recv().map_err(|_| {
                io::Error::new(io::ErrorKind::UnexpectedEof, "stdin reader stopped")
            })?,
        }?;
        match incoming {
            FrameRead::Eof => return Ok(()),
            FrameRead::TooLarge => reject(
                &mut writer,
                None,
                RpcError::new(code::FRAME_TOO_LARGE, "frame too large"),
            )?,
            FrameRead::Truncated => {
                reject(
                    &mut writer,
                    None,
                    RpcError::new(code::INVALID_REQUEST, "truncated JSONL frame"),
                )?;
                return Ok(());
            }
            FrameRead::Data(frame) => {
                let message = match xper_protocol::decode_frame(&frame) {
                    Ok(message) => message,
                    Err(error) => {
                        send(&mut writer, error.response())?;
                        continue;
                    }
                };
                if !state.handle(message, &mut writer)? {
                    return Ok(());
                }
            }
        }
    }
}

#[cfg(test)]
mod tests {
    #[test]
    fn binary_is_named_xper() {
        assert_eq!(env!("CARGO_BIN_NAME"), "xper");
        assert_eq!(xper_application::DOMAIN_PACKAGE_NAME, "xper-domain");
        assert_eq!(xper_config::PACKAGE_NAME, "xper-config");
        assert_eq!(xper_protocol::PACKAGE_NAME, "xper-protocol");
        assert_eq!(xper_store_sqlite::PACKAGE_NAME, "xper-store-sqlite");
    }
}
