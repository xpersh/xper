//! Background inspection, authoring and catalog work. Rendering never waits on I/O.

use std::{
    path::{Path, PathBuf},
    sync::{
        Arc, Mutex,
        atomic::{AtomicBool, AtomicU64, Ordering},
        mpsc::{self, Receiver, Sender},
    },
    thread,
};

use serde_json::json;
use xper_application::{
    configuration::{
        ConfigurationChange, ConfigurationPreview, ConfigurationScope, ConfigurationSnapshot,
    },
    installation::CheckStatus,
    read_models::RunPage,
    use_cases::{
        activate_profile, get_run_status, initialize_workspace, inspect_configuration,
        inspect_installation, list_runs, preview_configuration, save_configuration,
    },
};

use super::catalog::{self, Catalog, Model, Role};
use crate::{
    composition::{configuration_repository, inspection_store},
    infrastructure::{
        configuration::{AvailableModel, validate_models},
        installation::LocalInstallation,
        pi_integration::GlobalIntegration,
    },
};

type ModelSnapshot = Arc<Mutex<Option<Vec<AvailableModel>>>>;

pub(super) enum DataRequest {
    LoadConfig,
    History {
        after: Option<String>,
        selected: Option<String>,
    },
    Detail {
        id: String,
    },
    Preview {
        snapshot: ConfigurationSnapshot,
        scope: ConfigurationScope,
        changes: Vec<ConfigurationChange>,
        integrate_global: bool,
    },
    Save {
        snapshot: ConfigurationSnapshot,
        scope: ConfigurationScope,
        changes: Vec<ConfigurationChange>,
        integration: Option<GlobalIntegration>,
    },
    Activate(Option<String>),
}

pub(super) enum CatalogRequest {
    Open,
    Search {
        sequence: u64,
        query: String,
        provider: Option<String>,
    },
    Refresh,
    Close,
}

pub(super) enum Event {
    Configuration(Result<ConfigurationSnapshot, String>),
    History {
        after: Option<String>,
        selected: Option<String>,
        result: Result<(RunPage, get_run_status::Outcome), String>,
    },
    Detail {
        id: String,
        result: Result<get_run_status::Outcome, String>,
    },
    Preview(Result<(ConfigurationPreview, Option<GlobalIntegration>), String>),
    Saved(Result<ConfigurationSnapshot, String>),
    Activated(Result<ConfigurationSnapshot, String>),
    CatalogRoles(Result<Vec<Role>, String>),
    CatalogOpened(Result<(Vec<Role>, Vec<Model>), String>),
    CatalogSearch {
        sequence: u64,
        result: Result<Vec<Model>, String>,
    },
    CatalogRefreshed(Result<Vec<Model>, String>),
}

enum CatalogCommand {
    Request {
        request: CatalogRequest,
        active: Arc<AtomicBool>,
    },
    Shutdown,
}

pub(super) struct Workers {
    pub data: Sender<DataRequest>,
    pub events: Receiver<Event>,
    catalog: Sender<CatalogCommand>,
    catalog_active: Arc<AtomicBool>,
    latest_search: Arc<AtomicU64>,
    data_active: Arc<AtomicBool>,
    catalog_thread: Option<thread::JoinHandle<()>>,
}

impl Workers {
    pub fn new(root: PathBuf) -> Self {
        let (events, receiver) = mpsc::channel();
        let (data, requests) = mpsc::channel();
        let data_root = root.clone();
        let data_events = events.clone();
        let data_active = Arc::new(AtomicBool::new(true));
        let active = Arc::clone(&data_active);
        let model_snapshot: ModelSnapshot = Arc::new(Mutex::new(None));
        let data_models = Arc::clone(&model_snapshot);
        thread::spawn(move || {
            for request in requests {
                if !active.load(Ordering::Relaxed) {
                    break;
                }
                let response = data_request(&data_root, request, &data_models);
                if data_events.send(response).is_err() {
                    break;
                }
            }
        });
        let (catalog, requests) = mpsc::channel();
        let latest_search = Arc::new(AtomicU64::new(0));
        let sequence = Arc::clone(&latest_search);
        let catalog_thread = thread::spawn(move || {
            catalog_worker(&root, requests, &events, &sequence, &model_snapshot)
        });
        Self {
            data,
            events: receiver,
            catalog,
            catalog_active: Arc::new(AtomicBool::new(false)),
            latest_search,
            data_active,
            catalog_thread: Some(catalog_thread),
        }
    }

    /// Cancellation is synchronous; the catalog's blocking read observes it
    /// before the worker reaches the queued Close command.
    pub fn catalog(&mut self, request: CatalogRequest) {
        match &request {
            CatalogRequest::Open => {
                self.catalog_active.store(false, Ordering::Relaxed);
                self.catalog_active = Arc::new(AtomicBool::new(true));
            }
            CatalogRequest::Close => self.catalog_active.store(false, Ordering::Relaxed),
            CatalogRequest::Search { sequence, .. } => {
                self.latest_search.store(*sequence, Ordering::Relaxed);
            }
            CatalogRequest::Refresh => {}
        }
        let _ = self.catalog.send(CatalogCommand::Request {
            request,
            active: Arc::clone(&self.catalog_active),
        });
    }
}

impl Drop for Workers {
    fn drop(&mut self) {
        self.data_active.store(false, Ordering::Relaxed);
        self.catalog_active.store(false, Ordering::Relaxed);
        let _ = self.catalog.send(CatalogCommand::Shutdown);
        // Teardown runs after the UI loop exits. Reap the helper before main
        // can terminate its owning worker; ordinary screen Close remains async.
        if let Some(worker) = self.catalog_thread.take() {
            let _ = worker.join();
        }
        // The data thread remains detached: a slow filesystem or SQLite query
        // must not delay terminal restoration or process exit.
    }
}

fn data_request(root: &Path, request: DataRequest, models: &ModelSnapshot) -> Event {
    match request {
        DataRequest::LoadConfig => Event::Configuration(
            configuration_repository(root)
                .map_err(|error| error.to_string())
                .and_then(|repository| {
                    inspect_configuration::execute(&repository).map_err(|error| error.to_string())
                }),
        ),
        DataRequest::History { after, selected } => {
            let result = history(root, after.as_deref(), selected.as_deref());
            Event::History {
                after,
                selected,
                result,
            }
        }
        DataRequest::Detail { id } => {
            let result = inspection_store(root)
                .map_err(|error| error.to_string())
                .and_then(|store| match store {
                    Some(store) => get_run_status::execute(&store, get_run_status::Query::Run(&id))
                        .map_err(|error| error.to_string()),
                    None => Ok(get_run_status::Outcome::default()),
                });
            Event::Detail { id, result }
        }
        DataRequest::Preview {
            snapshot,
            scope,
            changes,
            integrate_global,
        } => Event::Preview(
            configuration_repository(root)
                .map_err(|error| error.to_string())
                .and_then(|repository| {
                    preview_configuration::execute(&repository, &snapshot, scope, &changes)
                        .map_err(|error| error.to_string())
                        .and_then(|mut preview| {
                            if !validate_snapshot(&preview, &changes, models)? {
                                preview.diagnostics.push(
                                    "Model catalog unavailable; model availability was not checked"
                                        .into(),
                                );
                            }
                            let integration = if integrate_global {
                                let plan = GlobalIntegration::plan(root)
                                    .map_err(|error| error.to_string())?;
                                global_preflight()?;
                                preview.diagnostics.push(plan.describe());
                                Some(plan)
                            } else {
                                None
                            };
                            Ok((preview, integration))
                        })
                }),
        ),
        DataRequest::Save {
            snapshot,
            scope,
            changes,
            integration,
        } => Event::Saved(save(root, &snapshot, scope, &changes, models, integration)),
        DataRequest::Activate(name) => Event::Activated(
            configuration_repository(root)
                .map_err(|error| error.to_string())
                .and_then(|mut repository| {
                    activate_profile::execute(&mut repository, name.as_deref())
                        .map_err(|error| error.to_string())
                }),
        ),
    }
}

fn history(
    root: &Path,
    after: Option<&str>,
    selected: Option<&str>,
) -> Result<(RunPage, get_run_status::Outcome), String> {
    let Some(store) = inspection_store(root).map_err(|error| error.to_string())? else {
        return Ok((RunPage::default(), get_run_status::Outcome::default()));
    };
    let page = list_runs::execute(
        &store,
        list_runs::Query {
            after,
            ..list_runs::Query::default()
        },
    )
    .map_err(|error| error.to_string())?;
    let selected = selected.or_else(|| page.runs.first().map(|run| run.run_id.as_str()));
    let outcome = selected
        .map(|id| get_run_status::execute(&store, get_run_status::Query::Run(id)))
        .transpose()
        .map_err(|error| error.to_string())?
        .unwrap_or_default();
    Ok((page, outcome))
}

fn save(
    root: &Path,
    snapshot: &ConfigurationSnapshot,
    scope: ConfigurationScope,
    changes: &[ConfigurationChange],
    models: &ModelSnapshot,
    integration: Option<GlobalIntegration>,
) -> Result<ConfigurationSnapshot, String> {
    let mut repository = configuration_repository(root).map_err(|error| error.to_string())?;
    // Validate the proposed configuration before the installation checks, which
    // intentionally inspect the old document and must not reject a repair.
    let preview = preview_configuration::execute(&repository, snapshot, scope, changes)
        .map_err(|error| error.to_string())?;
    validate_snapshot(&preview, changes, models)?;
    if snapshot
        .documents
        .iter()
        .all(|document| document.source.is_none())
    {
        let installation = LocalInstallation::current(scope == ConfigurationScope::Global)
            .map_err(|error| error.to_string())?;
        let checks = inspect_installation::execute(&installation).checks;
        let failures = checks
            .iter()
            .filter(|check| check.status == CheckStatus::Fail && check.id != "CONFIG")
            .map(|check| match &check.action {
                Some(action) => format!("{}: {}. {}", check.id, check.evidence, action),
                None => format!("{}: {}", check.id, check.evidence),
            })
            .collect::<Vec<_>>();
        if !failures.is_empty() {
            return Err(format!(
                "Initialization preflight failed: {}",
                failures.join("; ")
            ));
        }
    }
    if let Some(mut plan) = integration {
        let current =
            inspect_configuration::execute(&repository).map_err(|error| error.to_string())?;
        if current.revision != snapshot.revision {
            return Err(
                "Configuration changed outside this editor. Reload and review before preparing Pi."
                    .into(),
            );
        }
        global_preflight()?;
        match initialize_workspace::execute(&mut plan, |_| {}).map_err(|error| error.to_string())? {
            initialize_workspace::Outcome::Blocked => {
                return Err("Global Pi integration changed. Review again before saving.".into());
            }
            initialize_workspace::Outcome::Completed { .. } => {}
        }
        return save_configuration::execute(&mut repository, snapshot, scope, changes)
            .map_err(|error| format!("Global Pi integration is prepared, but the profile was not saved: {error}. Reload and review again."));
    }
    save_configuration::execute(&mut repository, snapshot, scope, changes)
        .map_err(|error| error.to_string())
}

fn global_preflight() -> Result<(), String> {
    let installation = LocalInstallation::current(true).map_err(|error| error.to_string())?;
    let failures = inspect_installation::execute(&installation)
        .checks
        .into_iter()
        // The configuration preview and reviewed integration plan validate
        // their proposed replacements, including repair of existing files.
        .filter(|check| {
            check.status == CheckStatus::Fail && !matches!(check.id, "CONFIG" | "ADAPTER")
        })
        .map(|check| format!("{}: {}", check.id, check.evidence))
        .collect::<Vec<_>>();
    if failures.is_empty() {
        Ok(())
    } else {
        Err(format!(
            "Global Pi preflight failed: {}",
            failures.join("; ")
        ))
    }
}

fn validate_snapshot(
    preview: &ConfigurationPreview,
    changes: &[ConfigurationChange],
    models: &ModelSnapshot,
) -> Result<bool, String> {
    let snapshot = models
        .lock()
        .map_err(|_| "Model catalog cache is unavailable".to_owned())?
        .clone();
    if let Some(models) = snapshot {
        validate_models(preview, &models, changes).map_err(|error| error.to_string())?;
        return Ok(true);
    }
    Ok(false)
}

fn catalog_worker(
    root: &Path,
    requests: Receiver<CatalogCommand>,
    events: &Sender<Event>,
    latest_search: &AtomicU64,
    model_snapshot: &ModelSnapshot,
) {
    let mut helper = None;
    for command in requests {
        let CatalogCommand::Request { request, active } = command else {
            break;
        };
        if matches!(request, CatalogRequest::Close) {
            helper = None;
            continue;
        }
        if !active.load(Ordering::Relaxed) {
            continue;
        }
        let event = match request {
            CatalogRequest::Open => {
                helper = None;
                Event::CatalogOpened(open_catalog(root, &mut helper, &active, events))
            }
            CatalogRequest::Refresh if helper.is_none() => {
                Event::CatalogOpened(open_catalog(root, &mut helper, &active, events))
            }
            CatalogRequest::Refresh => {
                Event::CatalogRefreshed(catalog_models(&mut helper, "refresh", json!({}), &active))
            }
            CatalogRequest::Search {
                sequence,
                query,
                provider,
            } => {
                if sequence != latest_search.load(Ordering::Relaxed) {
                    continue;
                }
                let mut params = json!({"query": query});
                if let Some(provider) = provider {
                    params["provider"] = json!(provider);
                }
                let result = catalog_models(&mut helper, "search", params, &active);
                if sequence != latest_search.load(Ordering::Relaxed) {
                    continue;
                }
                Event::CatalogSearch { sequence, result }
            }
            CatalogRequest::Close => unreachable!(),
        };
        if !active.load(Ordering::Relaxed) {
            helper = None;
            continue;
        }
        let full_models = match &event {
            Event::CatalogOpened(Ok((_, models))) | Event::CatalogRefreshed(Ok(models)) => {
                Some(models)
            }
            _ => None,
        };
        if let Some(models) = full_models
            && let Ok(mut snapshot) = model_snapshot.lock()
        {
            *snapshot = Some(
                models
                    .iter()
                    .map(|model| AvailableModel {
                        provider: model.provider.clone(),
                        model: model.model.clone(),
                        reasoning: model.reasoning,
                    })
                    .collect(),
            );
        }
        if events.send(event).is_err() {
            break;
        }
    }
}

fn open_catalog(
    root: &Path,
    helper: &mut Option<Catalog>,
    active: &Arc<AtomicBool>,
    events: &Sender<Event>,
) -> Result<(Vec<Role>, Vec<Model>), String> {
    let mut catalog = Catalog::start(root).map_err(|error| error.to_string())?;
    let roles = catalog
        .request("describe", json!({}), active)
        .and_then(catalog::roles)
        .map_err(|error| error.to_string());
    if !active.load(Ordering::Relaxed) {
        return Err("Catalog request cancelled".into());
    }
    events
        .send(Event::CatalogRoles(roles.clone()))
        .map_err(|_| "Dashboard closed".to_owned())?;
    let roles = roles?;
    let models = catalog::models(
        catalog
            .request("models", json!({}), active)
            .map_err(|error| error.to_string())?,
    )
    .map_err(|error| error.to_string())?;
    *helper = Some(catalog);
    Ok((roles, models))
}

fn catalog_models(
    helper: &mut Option<Catalog>,
    method: &str,
    params: serde_json::Value,
    active: &Arc<AtomicBool>,
) -> Result<Vec<Model>, String> {
    let result = helper
        .as_mut()
        .ok_or_else(|| "Pi catalog is unavailable; refresh to retry".to_owned())
        .and_then(|catalog| {
            catalog
                .request(method, params, active)
                .map_err(|error| error.to_string())
        })
        .and_then(|value| catalog::models(value).map_err(|error| error.to_string()));
    if result.is_err() {
        // A timed-out response may arrive later. A fresh process prevents it
        // from being mistaken for the next request's reply.
        *helper = None;
    }
    result
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::{
        fs,
        time::{SystemTime, UNIX_EPOCH},
    };
    use xper_application::{events::RecordedEvent, use_cases::append_events};
    use xper_store_sqlite::SqliteEventStore;

    struct Directory(PathBuf);
    impl Directory {
        fn new() -> Self {
            Self(std::env::temp_dir().join(format!(
                "xper-dashboard-history-{}-{}",
                std::process::id(),
                SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_nanos()
            )))
        }
    }
    impl Drop for Directory {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    #[test]
    fn history_refresh_preserves_selection_and_does_not_create_missing_storage() {
        let root = Directory::new();
        let (page, selected) = history(&root.0, None, None).unwrap();
        assert!(page.runs.is_empty());
        assert!(selected.run.is_none());
        assert!(!root.0.exists());
        fs::create_dir_all(root.0.join(".xper")).unwrap();
        let mut store = SqliteEventStore::open(root.0.join(".xper/events.sqlite")).unwrap();
        for id in ["old", "new"] {
            append_events::execute(
                &mut store,
                append_events::Request {
                    session_id: "session",
                    events: &[RecordedEvent {
                        schema_version: 1,
                        event_id: id.into(),
                        run_id: id.into(),
                        occurred_at: 100,
                        event_type: "run.started".into(),
                        data: serde_json::Map::new(),
                    }],
                },
            )
            .unwrap();
        }
        let (page, selected) = history(&root.0, None, Some("old")).unwrap();
        assert_eq!(page.runs[0].run_id, "new");
        assert_eq!(selected.run.unwrap().run_id, "old");
        let (_, selected) = history(&root.0, None, None).unwrap();
        assert_eq!(selected.run.unwrap().run_id, "new");
    }

    #[test]
    fn close_and_reopen_cannot_revive_the_previous_catalog_request() {
        let (data, _) = mpsc::channel();
        let (_, events) = mpsc::channel();
        let (catalog, requests) = mpsc::channel();
        let mut workers = Workers {
            data,
            events,
            catalog,
            catalog_active: Arc::new(AtomicBool::new(false)),
            latest_search: Arc::new(AtomicU64::new(0)),
            data_active: Arc::new(AtomicBool::new(true)),
            catalog_thread: None,
        };
        workers.catalog(CatalogRequest::Open);
        let CatalogCommand::Request { active: first, .. } = requests.recv().unwrap() else {
            panic!("expected an open request");
        };
        assert!(first.load(Ordering::Relaxed));
        workers.catalog(CatalogRequest::Close);
        workers.catalog(CatalogRequest::Open);
        assert!(!first.load(Ordering::Relaxed));
        let CatalogCommand::Request { active: closed, .. } = requests.recv().unwrap() else {
            panic!("expected a close request");
        };
        let CatalogCommand::Request {
            active: reopened, ..
        } = requests.recv().unwrap()
        else {
            panic!("expected a new open request");
        };
        assert!(!closed.load(Ordering::Relaxed));
        assert!(reopened.load(Ordering::Relaxed));
    }

    #[test]
    fn cancelled_open_and_obsolete_search_do_not_start_a_helper_or_emit_results() {
        let (commands, requests) = mpsc::channel();
        let (events, responses) = mpsc::channel();
        commands
            .send(CatalogCommand::Request {
                request: CatalogRequest::Open,
                active: Arc::new(AtomicBool::new(false)),
            })
            .unwrap();
        commands
            .send(CatalogCommand::Request {
                request: CatalogRequest::Search {
                    sequence: 1,
                    query: "old".into(),
                    provider: None,
                },
                active: Arc::new(AtomicBool::new(true)),
            })
            .unwrap();
        drop(commands);
        catalog_worker(
            Path::new("/does-not-exist"),
            requests,
            &events,
            &AtomicU64::new(2),
            &Arc::new(Mutex::new(None)),
        );
        assert!(responses.try_recv().is_err());
    }

    #[test]
    fn role_guidance_is_emitted_before_model_discovery_can_fail() {
        let root = Directory::new();
        let adapter = root.0.join("adapters/pi");
        fs::create_dir_all(adapter.join("dist/inspection")).unwrap();
        fs::write(adapter.join("dist/extension.js"), "// Synthetic adapter").unwrap();
        fs::write(
            adapter.join("package.json"),
            json!({"name":"@xper/adapter-pi","version":env!("CARGO_PKG_VERSION")}).to_string(),
        )
        .unwrap();
        fs::write(
            adapter.join("dist/inspection/cli.js"),
            r#"const readline = require("node:readline");
readline.createInterface({input:process.stdin}).on("line", line => {
  const request = JSON.parse(line);
  const response = {schemaVersion:1,id:request.id};
  if (request.method === "describe") response.result = {
    adapter:"pi",version:"TEST_VERSION",roles:[
      {id:"design",label:"Design",guidance:"Consider a frontier model"}
    ]
  };
  else response.error = {code:"CATALOG_UNAVAILABLE",message:"Synthetic model lookup failure"};
  process.stdout.write(JSON.stringify(response) + "\n");
});"#
                .replace("TEST_VERSION", env!("CARGO_PKG_VERSION")),
        )
        .unwrap();
        let (events, responses) = mpsc::channel();
        let mut helper = None;
        let result = open_catalog(
            &root.0,
            &mut helper,
            &Arc::new(AtomicBool::new(true)),
            &events,
        );
        assert!(
            result
                .unwrap_err()
                .contains("Synthetic model lookup failure")
        );
        let Event::CatalogRoles(Ok(roles)) = responses.try_recv().unwrap() else {
            panic!("role guidance must arrive independently of model discovery");
        };
        assert_eq!(roles[0].id, "design");
        assert_eq!(roles[0].guidance, "Consider a frontier model");
        assert!(helper.is_none());
    }
}
