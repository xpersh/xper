//! Composition root for passive recording and configuration resources.

use std::{
    fs, io,
    path::{Path, PathBuf},
};
use xper_store_sqlite::SqliteEventStore;

use crate::infrastructure::configuration::LocalConfiguration;

pub(crate) fn dashboard(ascii: bool) -> io::Result<bool> {
    crate::infrastructure::tui::run(std::env::current_dir()?, ascii)
}

pub(crate) fn configuration_repository(root: &Path) -> io::Result<LocalConfiguration> {
    let home = std::env::var_os("HOME")
        .map(PathBuf::from)
        .ok_or_else(|| io::Error::other("HOME is not set"))?;
    let xdg = std::env::var_os("XDG_CONFIG_HOME").map(PathBuf::from);
    Ok(LocalConfiguration::new(root.to_path_buf(), home, xdg))
}

pub(crate) struct RecordingRuntime {
    pub(crate) store: SqliteEventStore,
    pub(crate) root: PathBuf,
    pub(crate) session_id: String,
}

impl RecordingRuntime {
    pub(crate) fn attach(root: &Path, session_id: &str) -> io::Result<Self> {
        let directory = root.join(".xper");
        // Read-only projects may still inspect configuration and record in memory.
        // The store decides whether an open failure qualifies for volatile fallback.
        let _ = fs::create_dir_all(&directory);
        let store = SqliteEventStore::open_or_volatile(directory.join("events.sqlite"))
            .map_err(io::Error::other)?;
        Ok(Self {
            store,
            root: root.to_path_buf(),
            session_id: session_id.into(),
        })
    }
}

pub(crate) fn inspection_store(root: &Path) -> io::Result<Option<SqliteEventStore>> {
    let path = root.join(".xper/events.sqlite");
    if !path.exists() {
        return Ok(None);
    }
    SqliteEventStore::inspect(path)
        .map(Some)
        .map_err(io::Error::other)
}
