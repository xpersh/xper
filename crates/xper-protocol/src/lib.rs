//! Version 1 of the language-neutral JSON-RPC boundary.

use std::io::{self, BufRead};

use serde_json::{Value, json};

/// Stable package identity.
pub const PACKAGE_NAME: &str = env!("CARGO_PKG_NAME");
/// The only version supported by this bridge.
pub const PROTOCOL_VERSION: &str = "1";
/// Maximum size of one JSONL frame, excluding its LF terminator.
pub const MAX_FRAME_BYTES: usize = 65_536;

/// Outcome of reading one bounded JSONL frame.
#[derive(Debug, PartialEq)]
pub enum FrameRead {
    /// A complete frame without its LF terminator.
    Data(Vec<u8>),
    /// No bytes remain.
    Eof,
    /// A frame exceeded the limit and was drained through its LF.
    TooLarge,
    /// The stream ended with an incomplete frame.
    Truncated,
}

/// Read one frame without allocating more than the maximum frame size.
pub fn read_frame(reader: &mut impl BufRead) -> io::Result<FrameRead> {
    let mut frame = Vec::new();
    let mut too_large = false;
    loop {
        let available = reader.fill_buf()?;
        if available.is_empty() {
            return Ok(if too_large {
                FrameRead::TooLarge
            } else if frame.is_empty() {
                FrameRead::Eof
            } else {
                FrameRead::Truncated
            });
        }
        let count = available.iter().position(|byte| *byte == b'\n');
        let consumed = count.map_or(available.len(), |position| position + 1);
        let payload = count.unwrap_or(consumed);
        if !too_large {
            if frame.len() + payload > MAX_FRAME_BYTES {
                too_large = true;
                frame.clear();
            } else {
                frame.extend_from_slice(&available[..payload]);
            }
        }
        reader.consume(consumed);
        if count.is_some() {
            return Ok(if too_large {
                FrameRead::TooLarge
            } else {
                FrameRead::Data(frame)
            });
        }
    }
}

/// JSON-RPC and transport error codes shared with TypeScript.
pub mod code {
    /// The frame is not JSON.
    pub const PARSE_ERROR: i64 = -32700;
    /// The JSON value is not a protocol message.
    pub const INVALID_REQUEST: i64 = -32600;
    /// No handler exists for the requested method.
    pub const METHOD_NOT_FOUND: i64 = -32601;
    /// A method received invalid arguments.
    pub const INVALID_PARAMS: i64 = -32602;
    /// An unexpected server error occurred.
    pub const INTERNAL_ERROR: i64 = -32603;
    /// The peer requested a protocol version we cannot speak.
    pub const INCOMPATIBLE_VERSION: i64 = -32001;
    /// A method requires a completed initialization.
    pub const NOT_INITIALIZED: i64 = -32002;
    /// A JSONL frame exceeded the size limit.
    pub const FRAME_TOO_LARGE: i64 = -32003;
    /// A request or handshake took too long.
    pub const TIMEOUT: i64 = -32004;
    /// The peer closed before a response arrived.
    pub const CONNECTION_CLOSED: i64 = -32005;
}

/// Structured protocol error.
#[derive(Clone, Debug, PartialEq)]
pub struct RpcError {
    /// Stable numeric error code.
    pub code: i64,
    /// Human-readable diagnostic.
    pub message: String,
    /// Optional machine-readable details.
    pub data: Option<Value>,
}

impl RpcError {
    /// Construct an error without additional data.
    pub fn new(code: i64, message: impl Into<String>) -> Self {
        Self {
            code,
            message: message.into(),
            data: None,
        }
    }

    /// Convert to the wire error object.
    pub fn to_value(&self) -> Value {
        let mut value = json!({ "code": self.code, "message": self.message });
        if let Some(data) = &self.data {
            value["data"] = data.clone();
        }
        value
    }
}

/// A decoded JSON-RPC message. All request IDs are nonempty strings.
#[derive(Clone, Debug, PartialEq)]
pub enum Message {
    /// A request from either peer.
    Request {
        /// Correlation ID.
        id: String,
        /// Method name.
        method: String,
        /// Method arguments.
        params: Value,
    },
    /// A successful response.
    Response {
        /// Correlation ID.
        id: String,
        /// Method result.
        result: Value,
    },
    /// A failed response. A null ID is used when the request ID could not be read.
    Error {
        /// Correlation ID, when available.
        id: Option<String>,
        /// Error details.
        error: RpcError,
    },
}

impl Message {
    /// Convert a message to a JSON value for transport.
    pub fn to_value(&self) -> Value {
        match self {
            Self::Request { id, method, params } => json!({
                "jsonrpc": "2.0", "protocolVersion": PROTOCOL_VERSION,
                "id": id, "method": method, "params": params
            }),
            Self::Response { id, result } => json!({
                "jsonrpc": "2.0", "protocolVersion": PROTOCOL_VERSION,
                "id": id, "result": result
            }),
            Self::Error { id, error } => json!({
                "jsonrpc": "2.0", "protocolVersion": PROTOCOL_VERSION,
                "id": id, "error": error.to_value()
            }),
        }
    }

    /// Serialize as one LF-terminated JSONL frame.
    pub fn to_frame(&self) -> Vec<u8> {
        let mut frame = serde_json::to_vec(&self.to_value()).expect("protocol values serialize");
        frame.push(b'\n');
        frame
    }
}

/// A malformed incoming frame, with its recoverable correlation ID.
#[derive(Clone, Debug, PartialEq)]
pub struct DecodeError {
    /// Recoverable request ID, if any.
    pub id: Option<String>,
    /// Error to return to the peer.
    pub error: RpcError,
}

impl DecodeError {
    fn new(id: Option<String>, code: i64, message: impl Into<String>) -> Self {
        Self {
            id,
            error: RpcError::new(code, message),
        }
    }

    /// Convert to a protocol error response.
    pub fn response(self) -> Message {
        Message::Error {
            id: self.id,
            error: self.error,
        }
    }
}

/// Parse and validate one JSONL payload (without the LF).
pub fn decode_frame(frame: &[u8]) -> Result<Message, DecodeError> {
    if frame.len() > MAX_FRAME_BYTES {
        return Err(DecodeError::new(
            None,
            code::FRAME_TOO_LARGE,
            "frame too large",
        ));
    }
    let value: Value = serde_json::from_slice(frame)
        .map_err(|_| DecodeError::new(None, code::PARSE_ERROR, "invalid JSON"))?;
    decode_value(&value)
}

/// Validate a decoded JSON value against the envelope contract.
pub fn decode_value(value: &Value) -> Result<Message, DecodeError> {
    let object = value.as_object().ok_or_else(|| {
        DecodeError::new(None, code::INVALID_REQUEST, "message must be an object")
    })?;
    let id = object
        .get("id")
        .and_then(Value::as_str)
        .filter(|id| !id.is_empty())
        .map(str::to_owned);
    if object.get("jsonrpc").and_then(Value::as_str) != Some("2.0") {
        return Err(DecodeError::new(
            id,
            code::INVALID_REQUEST,
            "expected jsonrpc 2.0",
        ));
    }
    match object.get("protocolVersion").and_then(Value::as_str) {
        Some(PROTOCOL_VERSION) => {}
        Some(other) => {
            let mut error = DecodeError::new(
                id,
                code::INCOMPATIBLE_VERSION,
                "incompatible protocol version",
            );
            error.error.data = Some(json!({ "received": other, "supported": [PROTOCOL_VERSION] }));
            return Err(error);
        }
        None => {
            return Err(DecodeError::new(
                id,
                code::INVALID_REQUEST,
                "missing protocolVersion",
            ));
        }
    }
    if let Some(method) = object.get("method") {
        let id = id.ok_or_else(|| {
            DecodeError::new(
                None,
                code::INVALID_REQUEST,
                "request requires a nonempty string id",
            )
        })?;
        if object.contains_key("result") || object.contains_key("error") {
            return Err(DecodeError::new(
                Some(id),
                code::INVALID_REQUEST,
                "request cannot contain a response",
            ));
        }
        let method = method
            .as_str()
            .filter(|method| !method.is_empty())
            .ok_or_else(|| {
                DecodeError::new(
                    Some(id.clone()),
                    code::INVALID_REQUEST,
                    "method must be a nonempty string",
                )
            })?;
        let params = object
            .get("params")
            .filter(|value| value.is_object())
            .ok_or_else(|| {
                DecodeError::new(
                    Some(id.clone()),
                    code::INVALID_REQUEST,
                    "params must be an object",
                )
            })?;
        return Ok(Message::Request {
            id,
            method: method.to_owned(),
            params: params.clone(),
        });
    }
    if object.contains_key("result") == object.contains_key("error") {
        return Err(DecodeError::new(
            id,
            code::INVALID_REQUEST,
            "response requires exactly one of result or error",
        ));
    }
    if let Some(result) = object.get("result") {
        let id = id.ok_or_else(|| {
            DecodeError::new(
                None,
                code::INVALID_REQUEST,
                "response requires a nonempty string id",
            )
        })?;
        if !result.is_object() {
            return Err(DecodeError::new(
                Some(id),
                code::INVALID_REQUEST,
                "result must be an object",
            ));
        }
        return Ok(Message::Response {
            id,
            result: result.clone(),
        });
    }
    let error_value = object.get("error").expect("error response has error");
    let error_object = error_value.as_object().ok_or_else(|| {
        DecodeError::new(id.clone(), code::INVALID_REQUEST, "error must be an object")
    })?;
    let error_code = error_object
        .get("code")
        .and_then(Value::as_i64)
        .ok_or_else(|| {
            DecodeError::new(
                id.clone(),
                code::INVALID_REQUEST,
                "error code must be an integer",
            )
        })?;
    let message = error_object
        .get("message")
        .and_then(Value::as_str)
        .ok_or_else(|| {
            DecodeError::new(
                id.clone(),
                code::INVALID_REQUEST,
                "error message must be a string",
            )
        })?;
    if object.get("id") != Some(&Value::Null) && id.is_none() {
        return Err(DecodeError::new(
            None,
            code::INVALID_REQUEST,
            "error id must be a string or null",
        ));
    }
    if error_object
        .get("data")
        .is_some_and(|data| !data.is_object())
    {
        return Err(DecodeError::new(
            id,
            code::INVALID_REQUEST,
            "error data must be an object",
        ));
    }
    Ok(Message::Error {
        id,
        error: RpcError {
            code: error_code,
            message: message.to_owned(),
            data: error_object.get("data").cloned(),
        },
    })
}

#[cfg(test)]
mod tests {
    use super::{Message, code, decode_value};
    use serde_json::Value;

    #[test]
    fn shared_contract_fixtures() {
        let fixtures: Value =
            serde_json::from_str(include_str!("../../../fixtures/protocol-v1.json"))
                .expect("valid fixture file");
        for case in fixtures.as_array().expect("fixture array") {
            let result = decode_value(&case["message"]);
            let name = case["name"].as_str().expect("case name");
            match case["errorCode"].as_i64() {
                Some(expected) => assert_eq!(result.unwrap_err().error.code, expected, "{name}"),
                None => {
                    let message = result.unwrap_or_else(|error| panic!("{name}: {error:?}"));
                    assert_eq!(message.to_value(), case["message"], "{name}");
                }
            }
        }
    }

    #[test]
    fn invalid_json_and_large_frames_have_stable_codes() {
        assert_eq!(
            super::decode_frame(b"{").unwrap_err().error.code,
            code::PARSE_ERROR
        );
        assert_eq!(
            super::decode_frame(&vec![b'x'; super::MAX_FRAME_BYTES + 1])
                .unwrap_err()
                .error
                .code,
            code::FRAME_TOO_LARGE
        );
        let frame = Message::Response {
            id: "1".into(),
            result: serde_json::json!({}),
        }
        .to_frame();
        assert!(frame.ends_with(b"\n"));
    }

    #[test]
    fn bounded_reader_drains_large_frame_and_keeps_next() {
        let mut input = vec![b'x'; super::MAX_FRAME_BYTES + 1];
        input.extend_from_slice(b"\n{}\n");
        let mut reader = std::io::BufReader::new(input.as_slice());
        assert_eq!(
            super::read_frame(&mut reader).unwrap(),
            super::FrameRead::TooLarge
        );
        assert_eq!(
            super::read_frame(&mut reader).unwrap(),
            super::FrameRead::Data(b"{}".to_vec())
        );
    }
}
