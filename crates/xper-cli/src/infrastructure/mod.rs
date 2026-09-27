//! Local implementations of application ports.

pub(crate) mod installation;
pub(crate) mod profile_config;

use std::{
    fs, io,
    path::PathBuf,
    sync::atomic::{AtomicU64, Ordering},
    time::{SystemTime, UNIX_EPOCH},
};

use xper_application::ports::{ArtifactReader, Clock, IdGenerator};
use xper_domain::{Identifier, Timestamp};

static NEXT_ID: AtomicU64 = AtomicU64::new(0);

pub(crate) struct WallClock;

impl Clock for WallClock {
    fn now(&mut self) -> Timestamp {
        Timestamp::from_millis(
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap_or_default()
                .as_millis() as u64,
        )
    }
}

pub(crate) struct UniqueIds;

impl IdGenerator for UniqueIds {
    fn next_id(&mut self) -> Identifier {
        let nanos = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_nanos();
        Identifier::new(format!(
            "x-{nanos:x}-{:x}-{:x}",
            std::process::id(),
            NEXT_ID.fetch_add(1, Ordering::Relaxed),
        ))
        .expect("generated ID")
    }
}

pub(crate) struct WorkspaceArtifacts(pub(crate) PathBuf);

impl ArtifactReader for WorkspaceArtifacts {
    type Error = io::Error;

    fn is_available(&self, path: &str) -> io::Result<bool> {
        let path = self.0.join(path);
        if !path.is_file() {
            return Ok(false);
        }
        Ok(fs::metadata(path)?.len() > 0)
    }
}
