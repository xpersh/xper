//! JSONL transport, handshake and adapter session lifecycle.

mod recording;

use std::io::{self, BufReader, Write};
use std::path::Path;
use std::sync::mpsc::{self, Receiver};
use std::time::{Duration, Instant};

use crate::composition::RecordingRuntime;
use serde_json::{Value, json};
use xper_protocol::{FrameRead, Message, RpcError, code};

const HANDSHAKE_TIMEOUT: Duration = Duration::from_secs(5);
const HEARTBEAT_INTERVAL: Duration = Duration::from_secs(5);
type Incoming = Result<FrameRead, io::Error>;

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
    let frame = message.to_frame();
    if frame.len() > xper_protocol::MAX_FRAME_BYTES + 1 {
        let id = match message {
            Message::Response { id, .. } | Message::Request { id, .. } => Some(id),
            Message::Error { id, .. } => id,
        }
        .filter(|id| id.len() <= 256);
        writer.write_all(&Message::Error {
            id,
            error: RpcError::new(code::FRAME_TOO_LARGE, "response exceeds the frame limit; reduce configuration size or inspect history with the CLI"),
        }.to_frame())?;
    } else {
        writer.write_all(&frame)?;
    }
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
    adapter_name: Option<String>,
    adapter_version: Option<String>,
    recording: Option<RecordingRuntime>,
}

impl BridgeState {
    fn new() -> Self {
        Self {
            initialized: false,
            declared_capabilities: None,
            pending_capabilities: None,
            session_id: None,
            adapter_name: None,
            adapter_version: None,
            recording: None,
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
            self.adapter_name = adapter.map(str::to_owned);
            self.adapter_version = version.map(str::to_owned);
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
                        "capabilities": { "bidirectionalRequests": true, "eventRecording": true, "configurationResolution": true },
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
                if let (Some(session_id), Some(cwd), Some(_)) = (session_id, cwd, mode) {
                    match RecordingRuntime::attach(Path::new(cwd), session_id) {
                        Ok(recording) => self.recording = Some(recording),
                        Err(error) => {
                            reject(
                                writer,
                                Some(id),
                                RpcError::new(code::INTERNAL_ERROR, error.to_string()),
                            )?;
                            return Ok(true);
                        }
                    }
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
                    self.recording = None;
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
            "event.append" | "run.status" | "profile.inspect" | "configuration.resolve" => {
                let Some(recording) = self.recording.as_mut() else {
                    invalid_params(writer, id)?;
                    return Ok(true);
                };
                let result = recording::handle(recording, method, params, &id);
                match result {
                    Ok(value) => respond(writer, id, value)?,
                    Err(error) => reject(
                        writer,
                        Some(id),
                        RpcError::new(
                            if matches!(error, xper_application::ApplicationError::InvalidInput(_))
                            {
                                code::INVALID_PARAMS
                            } else {
                                code::INTERNAL_ERROR
                            },
                            error.to_string(),
                        ),
                    )?,
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

pub(crate) fn run() -> io::Result<()> {
    let receiver = reader_channel();
    let stdout = io::stdout();
    let mut writer = stdout.lock();
    let mut state = BridgeState::new();
    loop {
        let wait = state.deadline().map_or(HEARTBEAT_INTERVAL, |deadline| {
            deadline.min(HEARTBEAT_INTERVAL)
        });
        let incoming = match receiver.recv_timeout(wait) {
            Ok(incoming) => incoming?,
            Err(mpsc::RecvTimeoutError::Timeout) => {
                if state
                    .deadline()
                    .is_some_and(|remaining| remaining.is_zero())
                {
                    return Err(io::Error::new(
                        io::ErrorKind::TimedOut,
                        "adapter capabilities request timed out",
                    ));
                }
                continue;
            }
            Err(mpsc::RecvTimeoutError::Disconnected) => {
                return Err(io::Error::new(
                    io::ErrorKind::UnexpectedEof,
                    "stdin reader stopped",
                ));
            }
        };
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
