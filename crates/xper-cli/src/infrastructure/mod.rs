//! Local implementations of application ports.

pub(crate) mod installation;
pub(crate) mod profile_config;

use std::{
    fs, io,
    io::Read,
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

    fn digest(&self, path: &str) -> io::Result<Option<String>> {
        use sha2::{Digest, Sha256};
        Ok(self
            .read_evidence(path)?
            .map(|bytes| format!("{:x}", Sha256::digest(bytes))))
    }

    fn read_contract(
        &self,
        path: &str,
    ) -> io::Result<Option<(xper_application::knowledge::KnowledgeArtifact, String)>> {
        use sha2::{Digest, Sha256};
        let Some(bytes) = self.read_evidence(path)? else {
            return Ok(None);
        };
        let Ok(document) = serde_json::from_slice(&bytes) else {
            return Ok(None);
        };
        Ok(Some((document, format!("{:x}", Sha256::digest(bytes)))))
    }

    fn is_available(&self, path: &str) -> io::Result<bool> {
        let path = self.0.join(path);
        if !path.is_file() {
            return Ok(false);
        }
        Ok(fs::metadata(path)?.len() > 0)
    }
}

impl WorkspaceArtifacts {
    fn read_evidence(&self, relative: &str) -> io::Result<Option<Vec<u8>>> {
        let path = self.0.join(relative);
        if !path.is_file() {
            return Ok(None);
        }
        let root = self.0.canonicalize()?.join(".xper/artifacts");
        let canonical = path.canonicalize()?;
        if !canonical.starts_with(root) {
            return Err(io::Error::other("artifact escapes evidence directory"));
        }
        let mut bytes = Vec::new();
        fs::File::open(canonical)?
            .take(1_048_577)
            .read_to_end(&mut bytes)?;
        if bytes.is_empty() || bytes.len() > 1_048_576 {
            return Err(io::Error::other("artifact must contain 1 to 1048576 bytes"));
        }
        Ok(Some(bytes))
    }
}

#[cfg(test)]
mod knowledge_tests {
    use xper_application::knowledge::KnowledgeArtifact;

    #[test]
    fn shared_artifacts_deserialize_and_preserve_the_public_contract() {
        let fixtures: serde_json::Value =
            serde_json::from_str(include_str!("../../../../fixtures/knowledge-v1.json")).unwrap();
        for fixture in fixtures.as_array().unwrap() {
            let artifact: KnowledgeArtifact =
                serde_json::from_value(fixture["artifact"].clone()).unwrap();
            assert_eq!(artifact.schema_version, 1);
            artifact.output.validate().unwrap();
            assert_eq!(serde_json::to_value(artifact).unwrap(), fixture["artifact"]);
        }
    }
}
