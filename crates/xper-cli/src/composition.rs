//! Composition root: opens resources and wires concrete port implementations.

use std::{collections::BTreeMap, fs, io, path::Path};

use xper_application::events::{AdapterMetadata, RoutingSnapshot};
use xper_store_sqlite::SqliteEventStore;

use crate::infrastructure::{UniqueIds, WallClock, WorkspaceArtifacts, profile_config};

/// Resources owned by one bridge session; workflow decisions live in use cases.
pub(crate) struct WorkflowRuntime {
    pub(crate) store: SqliteEventStore,
    pub(crate) artifacts: WorkspaceArtifacts,
    pub(crate) clock: WallClock,
    pub(crate) ids: UniqueIds,
    pub(crate) metadata: AdapterMetadata,
    pub(crate) routing: Option<RoutingSnapshot>,
    pub(crate) session_id: String,
}

impl WorkflowRuntime {
    pub(crate) fn attach(
        root: &Path,
        adapter: &str,
        version: &str,
        capabilities: BTreeMap<String, bool>,
        session_id: &str,
    ) -> io::Result<Self> {
        let directory = root.join(".xper");
        fs::create_dir_all(&directory)?;
        let store = SqliteEventStore::open_or_volatile(directory.join("events.sqlite"))
            .map_err(io::Error::other)?;
        let routing = profile_config::resolved_active(root)?;
        Ok(Self {
            store,
            artifacts: WorkspaceArtifacts(root.to_path_buf()),
            clock: WallClock,
            ids: UniqueIds,
            metadata: AdapterMetadata {
                adapter: adapter.into(),
                version: version.into(),
                capabilities,
            },
            routing,
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
