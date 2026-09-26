//! The first persisted workflow boundary, independent of the Pi adapter.

use std::{
    collections::BTreeMap,
    fs, io,
    path::{Path, PathBuf},
    sync::atomic::{AtomicU64, Ordering},
    time::{SystemTime, UNIX_EPOCH},
};

use serde_json::{Value, json};
use xper_application::events::{
    AdapterMetadata, Event, EventKind, GateOutcome, RunProjection, RunStatus, WorkOutcome,
};
use xper_domain::{
    Clock, GateEvaluation, GateResult, IdGenerator, Identifier, Phase, Run, Timestamp,
    TransitionRequest,
};
use xper_store_sqlite::SqliteEventStore;

static NEXT_ID: AtomicU64 = AtomicU64::new(0);

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64
}
fn fresh_id(prefix: &str) -> String {
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_nanos();
    format!(
        "{prefix}-{:x}-{:x}-{:x}",
        nanos,
        std::process::id(),
        NEXT_ID.fetch_add(1, Ordering::Relaxed)
    )
}
struct WallClock;
impl Clock for WallClock {
    fn now(&mut self) -> Timestamp {
        Timestamp::from_millis(now_ms())
    }
}
struct UniqueIds;
impl IdGenerator for UniqueIds {
    fn next_id(&mut self) -> Identifier {
        Identifier::new(fresh_id("x")).expect("generated ID")
    }
}

fn invalid(message: &str) -> io::Error {
    io::Error::new(io::ErrorKind::InvalidInput, message)
}
fn storage(error: impl std::fmt::Display) -> io::Error {
    io::Error::other(error.to_string())
}
fn require<'a>(params: &'a Value, field: &str) -> io::Result<&'a str> {
    params
        .get(field)
        .and_then(Value::as_str)
        .filter(|value| !value.trim().is_empty())
        .ok_or_else(|| invalid("missing or empty workflow parameter"))
}
fn outcome(value: &str) -> io::Result<WorkOutcome> {
    match value {
        "succeeded" => Ok(WorkOutcome::Succeeded),
        "failed" => Ok(WorkOutcome::Failed),
        "cancelled" => Ok(WorkOutcome::Cancelled),
        "timed_out" => Ok(WorkOutcome::TimedOut),
        _ => Err(invalid("unknown attempt outcome")),
    }
}
fn event(run_id: &str, kind: EventKind) -> Event {
    Event {
        event_id: fresh_id("event"),
        run_id: run_id.into(),
        occurred_at_ms: now_ms(),
        kind,
    }
}

/// One project-local workflow coordinator owned by a bridge process.
pub struct WorkspaceRun {
    root: PathBuf,
    store: SqliteEventStore,
    metadata: AdapterMetadata,
    session_id: String,
    run_id: Option<String>,
}

impl WorkspaceRun {
    /// Opens a project database, recovering any attempt left running by a crash.
    pub fn attach(
        root: &Path,
        adapter: &str,
        version: &str,
        capabilities: BTreeMap<String, bool>,
        session_id: &str,
    ) -> io::Result<Self> {
        let directory = root.join(".xper");
        fs::create_dir_all(&directory)?;
        let store =
            SqliteEventStore::open_or_volatile(directory.join("events.sqlite")).map_err(storage)?;
        let run_id = store.session_run(session_id).map_err(storage)?;
        Ok(Self {
            root: root.to_path_buf(),
            store,
            metadata: AdapterMetadata {
                adapter: adapter.into(),
                version: version.into(),
                capabilities,
            },
            session_id: session_id.into(),
            run_id,
        })
    }

    /// Keeps this bridge's active attempts owned while it is connected.
    pub fn heartbeat(&mut self) -> io::Result<()> {
        self.store.heartbeat().map_err(storage)
    }

    /// Explicitly shares an existing active run with this Pi session.
    pub fn join(&mut self, run_id: &str) -> io::Result<Value> {
        if self.store.has_active_attempts().map_err(storage)? {
            return Err(invalid(
                "finish running attempts before joining another run",
            ));
        }
        let run = self
            .store
            .load_run(run_id)
            .map_err(storage)?
            .ok_or_else(|| invalid("unknown run ID"))?;
        if run.status != RunStatus::Active {
            return Err(invalid("run is not active"));
        }
        self.store
            .bind_session(&self.session_id, run_id)
            .map_err(storage)?;
        self.run_id = Some(run_id.into());
        Ok(
            json!({"runId":run_id,"phase":run.visits.last().map(|v| v.phase.as_str()),"joined":true}),
        )
    }

    fn current(&self) -> io::Result<Option<RunProjection>> {
        self.run_id
            .as_deref()
            .map(|id| self.store.load_run(id).map_err(storage))
            .transpose()
            .map(Option::flatten)
    }
    fn active(&self) -> io::Result<RunProjection> {
        let run = self
            .current()?
            .ok_or_else(|| invalid("start a run first with /xper start"))?;
        if run.status != RunStatus::Active {
            return Err(invalid("run is not active"));
        }
        Ok(run)
    }
    fn commit(&mut self, events: &[Event]) -> io::Result<()> {
        self.store.append_boundary(events).map_err(storage)?;
        Ok(())
    }
    /// Starts in Intake and enters Discovery atomically, or resumes the latest active run.
    pub fn start(&mut self, objective: &str) -> io::Result<Value> {
        if let Some(run) = self.current()?
            && run.status == RunStatus::Active
        {
            return Ok(
                json!({"runId":run.run_id,"phase":run.visits.last().map(|v| v.phase.as_str()),"resumed":true}),
            );
        }
        let mut clock = WallClock;
        let mut ids = UniqueIds;
        let (mut run, mut domain_events) = Run::start(objective, &mut clock, &mut ids).into_parts();
        let transition = run
            .transition(
                TransitionRequest::new(
                    Identifier::new(fresh_id("request"))
                        .expect("generated ID")
                        .into(),
                    Phase::Discovery,
                    GateEvaluation::new("intake.ready", GateResult::Passed, vec![]),
                ),
                &mut clock,
                &mut ids,
            )
            .map_err(storage)?;
        domain_events.extend_from_slice(transition.events());
        let events: Vec<_> = domain_events
            .iter()
            .map(|item| Event::from_domain(item, &self.metadata))
            .collect();
        let run_id = run.id().as_str().to_owned();
        self.store
            .append_boundary_and_bind_session(&events, &self.session_id, &run_id)
            .map_err(storage)?;
        self.run_id = Some(run_id.clone());
        Ok(json!({"runId":run_id,"phase":"discovery","resumed":false}))
    }
    /// Starts one Discovery assignment and its attempt, returning xper IDs.
    pub fn delegate(&mut self, retry_assignment_id: Option<&str>) -> io::Result<Value> {
        let run = self.active()?;
        let visit = run
            .visits
            .last()
            .ok_or_else(|| invalid("run has no visit"))?;
        if visit.phase != "discovery" {
            return Err(invalid("Discovery is not active"));
        }
        let pending = retry_assignment_id
            .map(|id| {
                run.assignments
                    .get(id)
                    .filter(|assignment| {
                        assignment.visit_id == visit.visit_id && assignment.outcome.is_none()
                    })
                    .ok_or_else(|| invalid("assignment is not pending in this Discovery visit"))
            })
            .transpose()?;
        if let Some(assignment) = pending
            && run.attempts.values().any(|attempt| {
                attempt.assignment_id == assignment.assignment_id && attempt.outcome.is_none()
            })
        {
            return Err(invalid("assignment already has a running attempt"));
        }
        let assignment_id = pending.map_or_else(
            || fresh_id("assignment"),
            |assignment| assignment.assignment_id.clone(),
        );
        let attempt_id = fresh_id("attempt");
        let mut events = Vec::new();
        if pending.is_none() {
            events.push(event(
                &run.run_id,
                EventKind::AssignmentCreated {
                    assignment_id: assignment_id.clone(),
                    visit_id: visit.visit_id.clone(),
                    role: "discovery.explorer".into(),
                },
            ));
        }
        events.push(event(
            &run.run_id,
            EventKind::AttemptStarted {
                attempt_id: attempt_id.clone(),
                assignment_id: assignment_id.clone(),
            },
        ));
        self.commit(&events)?;
        Ok(
            json!({"runId":run.run_id,"assignmentId":assignment_id,"attemptId":attempt_id,"role":"discovery.explorer"}),
        )
    }
    /// Settles an attempt and registers a nonempty Discovery Brief on success.
    pub fn settle(&mut self, params: &Value) -> io::Result<Value> {
        let attempt_id = require(params, "attemptId")?;
        let result = outcome(require(params, "outcome")?)?;
        let run = self.active()?;
        let attempt = run
            .attempts
            .get(attempt_id)
            .ok_or_else(|| invalid("unknown attempt"))?;
        if let Some(existing) = attempt.outcome {
            if existing == result {
                return Ok(json!({"attemptId":attempt_id,"outcome":result,"replayed":true}));
            }
            return Err(invalid("attempt already settled differently"));
        }
        let mut events = vec![event(
            &run.run_id,
            EventKind::AttemptFinished {
                attempt_id: attempt_id.into(),
                outcome: result,
            },
        )];
        let artifact = if result == WorkOutcome::Succeeded {
            let relative = require(params, "artifactPath")?;
            let expected = format!(".xper/artifacts/discovery-brief-{attempt_id}.md");
            if relative != expected {
                return Err(invalid("unexpected Discovery Brief path"));
            }
            let path = self.root.join(relative);
            if !path.is_file() || fs::metadata(&path)?.len() == 0 {
                return Err(invalid("Discovery Brief is missing or empty"));
            }
            let artifact_id = fresh_id("artifact");
            events.push(event(
                &run.run_id,
                EventKind::ArtifactRegistered {
                    artifact_id: artifact_id.clone(),
                    attempt_id: attempt_id.into(),
                    kind: "discovery_brief".into(),
                    path: relative.into(),
                    version: 1,
                },
            ));
            Some(artifact_id)
        } else {
            None
        };
        events.push(event(
            &run.run_id,
            EventKind::AssignmentCompleted {
                assignment_id: attempt.assignment_id.clone(),
                outcome: result,
            },
        ));
        self.commit(&events)?;
        Ok(json!({"attemptId":attempt_id,"outcome":result,"artifactId":artifact}))
    }
    /// Evaluates the Discovery gate and enters Define only with durable evidence.
    pub fn advance(&mut self) -> io::Result<Value> {
        let run = self.active()?;
        let visit = run
            .visits
            .last()
            .ok_or_else(|| invalid("run has no visit"))?;
        if visit.phase == "define" {
            return Ok(json!({"advanced":true,"phase":"define","resumed":true}));
        }
        if visit.phase != "discovery" {
            return Err(invalid("Discovery is not active"));
        }
        let valid = xper_application::slice::discovery_ready(&run, |path| {
            let path = self.root.join(path);
            path.is_file() && fs::metadata(path).is_ok_and(|meta| meta.len() > 0)
        });
        let gate_id = fresh_id("gate");
        let evaluation = event(
            &run.run_id,
            EventKind::GateEvaluated {
                gate_id: gate_id.clone(),
                visit_id: visit.visit_id.clone(),
                outcome: if valid {
                    GateOutcome::Passed
                } else {
                    GateOutcome::Failed
                },
            },
        );
        if !valid {
            self.commit(&[evaluation])?;
            let reason = if run.assignments.values().any(|assignment| {
                assignment.visit_id == visit.visit_id && assignment.outcome.is_none()
            }) {
                "Discovery assignments are still running"
            } else {
                "Discovery Brief from a successful explorer assignment is required"
            };
            return Ok(json!({"advanced":false,"phase":"discovery","reason":reason}));
        }
        let target_visit = fresh_id("visit");
        self.commit(&[
            evaluation,
            event(
                &run.run_id,
                EventKind::GatePassed {
                    gate_id: gate_id.clone(),
                    visit_id: visit.visit_id.clone(),
                },
            ),
            event(
                &run.run_id,
                EventKind::PhaseExited {
                    visit_id: visit.visit_id.clone(),
                    phase: "discovery".into(),
                    gate_id,
                },
            ),
            event(
                &run.run_id,
                EventKind::PhaseEntered {
                    visit_id: target_visit,
                    phase: "define".into(),
                    visit_number: 1,
                },
            ),
        ])?;
        Ok(json!({"advanced":true,"phase":"define"}))
    }
    /// Returns projected state and a timeline built only from persisted events.
    pub fn status(&self) -> io::Result<Value> {
        let Some(run) = self.current()? else {
            return Ok(
                json!({"run":null,"timeline":[],"durability":format!("{:?}",self.store.durability()).to_lowercase()}),
            );
        };
        let timeline = self.store.load_events(&run.run_id).map_err(storage)?;
        Ok(
            json!({"run":run,"timeline":timeline,"durability":format!("{:?}",self.store.durability()).to_lowercase(),"degradedReason":self.store.degraded_reason()}),
        )
    }
}

/// Reads one run, or the latest run in the project, for `xper status`.
pub fn cli_status(root: &Path, run_id: Option<&str>) -> io::Result<Value> {
    let path = root.join(".xper/events.sqlite");
    if !path.exists() {
        if run_id.is_some() {
            return Err(invalid("unknown run ID"));
        }
        return Ok(json!({"run":null,"timeline":[]}));
    }
    let store = SqliteEventStore::inspect(path).map_err(storage)?;
    let run = match run_id {
        Some(id) => store.load_run(id).map_err(storage)?,
        None => store.latest_run().map_err(storage)?,
    };
    let Some(run) = run else {
        if run_id.is_some() {
            return Err(invalid("unknown run ID"));
        }
        return Ok(json!({"run":null,"timeline":[]}));
    };
    let timeline = store.load_events(&run.run_id).map_err(storage)?;
    Ok(json!({"run":run,"timeline":timeline}))
}
