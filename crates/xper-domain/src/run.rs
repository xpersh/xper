use std::{collections::BTreeMap, error::Error, fmt};

use crate::{
    Clock, EventId, Gate, GateEvaluation, GateId, GateResult, IdGenerator, Phase, PhaseVisit,
    PhaseVisitId, RequestId, RunId, RunState, Timestamp,
};

/// A value produced by an accepted domain change together with its events.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Change<T> {
    value: T,
    events: Vec<DomainEvent>,
}

impl<T> Change<T> {
    /// Returns the changed value.
    #[must_use]
    pub const fn value(&self) -> &T {
        &self.value
    }

    /// Returns the events produced by the change.
    #[must_use]
    pub fn events(&self) -> &[DomainEvent] {
        &self.events
    }

    /// Consumes the change and returns the value and events.
    #[must_use]
    pub fn into_parts(self) -> (T, Vec<DomainEvent>) {
        (self.value, self.events)
    }
}

/// A deterministic request to enter another workflow phase.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct TransitionRequest {
    request_id: RequestId,
    target: Phase,
    gate: GateEvaluation,
}

impl TransitionRequest {
    /// Creates a transition request with an idempotency identity.
    #[must_use]
    pub const fn new(request_id: RequestId, target: Phase, gate: GateEvaluation) -> Self {
        Self {
            request_id,
            target,
            gate,
        }
    }

    /// Returns the request identity.
    #[must_use]
    pub const fn request_id(&self) -> &RequestId {
        &self.request_id
    }

    /// Returns the requested target phase.
    #[must_use]
    pub const fn target(&self) -> Phase {
        self.target
    }

    /// Returns the gate evaluation authorizing the transition.
    #[must_use]
    pub const fn gate(&self) -> &GateEvaluation {
        &self.gate
    }
}

/// Result of an accepted phase transition.
///
/// Replaying an identical [`TransitionRequest`] returns the same receipt,
/// including the same event identifiers, without consuming the injected clock
/// or identifier generator again.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct TransitionReceipt {
    request_id: RequestId,
    from_visit_id: PhaseVisitId,
    to_visit_id: PhaseVisitId,
    events: Vec<DomainEvent>,
}

impl TransitionReceipt {
    /// Returns the request that identifies this transition.
    #[must_use]
    pub const fn request_id(&self) -> &RequestId {
        &self.request_id
    }

    /// Returns the visit that was exited.
    #[must_use]
    pub const fn from_visit_id(&self) -> &PhaseVisitId {
        &self.from_visit_id
    }

    /// Returns the visit that was entered.
    #[must_use]
    pub const fn to_visit_id(&self) -> &PhaseVisitId {
        &self.to_visit_id
    }

    /// Returns the domain events emitted by the transition.
    #[must_use]
    pub fn events(&self) -> &[DomainEvent] {
        &self.events
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
struct AppliedTransition {
    request: TransitionRequest,
    receipt: TransitionReceipt,
}

/// A complete domain run and its accepted phase history.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Run {
    id: RunId,
    objective: String,
    state: RunState,
    phase_visits: Vec<PhaseVisit>,
    gates: Vec<Gate>,
    applied_transitions: BTreeMap<RequestId, AppliedTransition>,
}

impl Run {
    /// Starts a run in Intake and emits `run.started` and `phase.entered`.
    #[must_use]
    pub fn start(
        objective: impl Into<String>,
        clock: &mut impl Clock,
        ids: &mut impl IdGenerator,
    ) -> Change<Self> {
        let objective = objective.into();
        let occurred_at = clock.now();
        let run_id = RunId::from(ids.next_id());
        let visit_id = PhaseVisitId::from(ids.next_id());
        let visit = PhaseVisit::enter(visit_id.clone(), Phase::Intake, 1, occurred_at);

        let events = vec![
            DomainEvent::new(
                EventId::from(ids.next_id()),
                occurred_at,
                run_id.clone(),
                DomainEventKind::RunStarted {
                    objective: objective.clone(),
                    phase_visit_id: visit_id.clone(),
                },
            ),
            DomainEvent::new(
                EventId::from(ids.next_id()),
                occurred_at,
                run_id.clone(),
                DomainEventKind::PhaseEntered {
                    phase_visit_id: visit_id,
                    phase: Phase::Intake,
                    visit_number: 1,
                },
            ),
        ];

        Change {
            value: Self {
                id: run_id,
                objective,
                state: RunState::Active,
                phase_visits: vec![visit],
                gates: Vec::new(),
                applied_transitions: BTreeMap::new(),
            },
            events,
        }
    }

    /// Applies a minimal workflow transition transactionally.
    ///
    /// The supported edges are `Intake -> Discovery`, `Discovery -> Define`,
    /// and the `Define -> Discovery` revisit. Validation errors do not mutate
    /// the run or consume the injected services.
    pub fn transition(
        &mut self,
        request: TransitionRequest,
        clock: &mut impl Clock,
        ids: &mut impl IdGenerator,
    ) -> Result<TransitionReceipt, TransitionError> {
        if let Some(applied) = self.applied_transitions.get(request.request_id()) {
            if applied.request == request {
                return Ok(applied.receipt.clone());
            }
            return Err(TransitionError::IdempotencyConflict {
                request_id: request.request_id.clone(),
            });
        }

        if self.state != RunState::Active {
            return Err(TransitionError::RunNotActive);
        }

        let from = self.current_phase();
        let target = request.target;
        if !is_allowed_transition(from, target) {
            return Err(TransitionError::InvalidTransition { from, target });
        }

        if request.gate.result() != &GateResult::Passed {
            return Err(TransitionError::GateNotPassed { from, target });
        }

        let occurred_at = clock.now();
        let gate_id = GateId::from(ids.next_id());
        let to_visit_id = PhaseVisitId::from(ids.next_id());
        let from_visit_id = self.current_visit().id().clone();
        let visit_number = self.visit_count(target) + 1;
        let gate = Gate::record(
            gate_id.clone(),
            from_visit_id.clone(),
            &request.gate,
            occurred_at,
        );

        let mut events = vec![
            DomainEvent::new(
                EventId::from(ids.next_id()),
                occurred_at,
                self.id.clone(),
                DomainEventKind::GateEvaluated {
                    gate_id: gate_id.clone(),
                    phase_visit_id: from_visit_id.clone(),
                    result: GateResult::Passed,
                },
            ),
            DomainEvent::new(
                EventId::from(ids.next_id()),
                occurred_at,
                self.id.clone(),
                DomainEventKind::GatePassed {
                    gate_id: gate_id.clone(),
                    phase_visit_id: from_visit_id.clone(),
                },
            ),
            DomainEvent::new(
                EventId::from(ids.next_id()),
                occurred_at,
                self.id.clone(),
                DomainEventKind::PhaseExited {
                    phase_visit_id: from_visit_id.clone(),
                    phase: from,
                    gate_id: gate_id.clone(),
                },
            ),
        ];

        let entry_kind = if visit_number == 1 {
            DomainEventKind::PhaseEntered {
                phase_visit_id: to_visit_id.clone(),
                phase: target,
                visit_number,
            }
        } else {
            DomainEventKind::PhaseRevisited {
                phase_visit_id: to_visit_id.clone(),
                phase: target,
                visit_number,
            }
        };
        events.push(DomainEvent::new(
            EventId::from(ids.next_id()),
            occurred_at,
            self.id.clone(),
            entry_kind,
        ));

        self.phase_visits
            .last_mut()
            .expect("a run always has a current phase visit")
            .exit(occurred_at, gate_id);
        self.gates.push(gate);
        self.phase_visits.push(PhaseVisit::enter(
            to_visit_id.clone(),
            target,
            visit_number,
            occurred_at,
        ));

        let receipt = TransitionReceipt {
            request_id: request.request_id.clone(),
            from_visit_id,
            to_visit_id,
            events,
        };
        self.applied_transitions.insert(
            request.request_id.clone(),
            AppliedTransition {
                request,
                receipt: receipt.clone(),
            },
        );
        Ok(receipt)
    }

    /// Returns the run identity.
    #[must_use]
    pub const fn id(&self) -> &RunId {
        &self.id
    }

    /// Returns the run objective.
    #[must_use]
    pub fn objective(&self) -> &str {
        &self.objective
    }

    /// Returns the run lifecycle state.
    #[must_use]
    pub const fn state(&self) -> &RunState {
        &self.state
    }

    /// Returns the current phase.
    #[must_use]
    pub fn current_phase(&self) -> Phase {
        self.current_visit().phase()
    }

    /// Returns the active phase visit.
    #[must_use]
    pub fn current_visit(&self) -> &PhaseVisit {
        self.phase_visits
            .last()
            .expect("a run always has a current phase visit")
    }

    /// Returns every phase visit in chronological order.
    #[must_use]
    pub fn phase_visits(&self) -> &[PhaseVisit] {
        &self.phase_visits
    }

    /// Returns every gate recorded for accepted transitions.
    #[must_use]
    pub fn gates(&self) -> &[Gate] {
        &self.gates
    }

    fn visit_count(&self, phase: Phase) -> u32 {
        self.phase_visits
            .iter()
            .filter(|visit| visit.phase() == phase)
            .count()
            .try_into()
            .expect("phase visit count fits in u32")
    }
}

fn is_allowed_transition(from: Phase, target: Phase) -> bool {
    matches!(
        (from, target),
        (Phase::Intake, Phase::Discovery)
            | (Phase::Discovery, Phase::Define)
            | (Phase::Define, Phase::Discovery)
    )
}

/// Stable rejection raised by a phase transition request.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum TransitionError {
    /// Only active runs can change phase.
    RunNotActive,
    /// The requested edge is not part of the minimal workflow.
    InvalidTransition {
        /// Current phase.
        from: Phase,
        /// Requested phase.
        target: Phase,
    },
    /// The current phase's exit gate did not pass.
    GateNotPassed {
        /// Current phase.
        from: Phase,
        /// Requested phase.
        target: Phase,
    },
    /// A request identity was reused with different content.
    IdempotencyConflict {
        /// Conflicting request identity.
        request_id: RequestId,
    },
}

impl TransitionError {
    /// Returns a stable machine-readable error code.
    #[must_use]
    pub const fn code(&self) -> &'static str {
        match self {
            Self::RunNotActive => "run_not_active",
            Self::InvalidTransition { .. } => "invalid_transition",
            Self::GateNotPassed { .. } => "gate_not_passed",
            Self::IdempotencyConflict { .. } => "idempotency_conflict",
        }
    }
}

impl fmt::Display for TransitionError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::RunNotActive => formatter.write_str("run is not active"),
            Self::InvalidTransition { from, target } => {
                write!(
                    formatter,
                    "transition from {from:?} to {target:?} is not allowed"
                )
            }
            Self::GateNotPassed { from, target } => write!(
                formatter,
                "gate for transition from {from:?} to {target:?} did not pass"
            ),
            Self::IdempotencyConflict { request_id } => write!(
                formatter,
                "request {request_id} was already applied with different content"
            ),
        }
    }
}

impl Error for TransitionError {}

/// A domain event produced by an accepted run change.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct DomainEvent {
    id: EventId,
    occurred_at: Timestamp,
    run_id: RunId,
    kind: DomainEventKind,
}

impl DomainEvent {
    fn new(id: EventId, occurred_at: Timestamp, run_id: RunId, kind: DomainEventKind) -> Self {
        Self {
            id,
            occurred_at,
            run_id,
            kind,
        }
    }

    /// Returns the event identity.
    #[must_use]
    pub const fn id(&self) -> &EventId {
        &self.id
    }

    /// Returns when the event occurred.
    #[must_use]
    pub const fn occurred_at(&self) -> Timestamp {
        self.occurred_at
    }

    /// Returns the run that produced the event.
    #[must_use]
    pub const fn run_id(&self) -> &RunId {
        &self.run_id
    }

    /// Returns the event payload.
    #[must_use]
    pub const fn kind(&self) -> &DomainEventKind {
        &self.kind
    }
}

/// Payload of a domain event.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum DomainEventKind {
    /// A run started with its initial Intake visit.
    RunStarted {
        /// Normalized objective supplied by the caller.
        objective: String,
        /// Initial Intake visit.
        phase_visit_id: PhaseVisitId,
    },
    /// A phase was entered for the first time.
    PhaseEntered {
        /// New visit identity.
        phase_visit_id: PhaseVisitId,
        /// Entered phase.
        phase: Phase,
        /// One-based visit number, always one for this event.
        visit_number: u32,
    },
    /// A previously visited phase was entered again.
    PhaseRevisited {
        /// New visit identity.
        phase_visit_id: PhaseVisitId,
        /// Revisited phase.
        phase: Phase,
        /// One-based visit number, greater than one.
        visit_number: u32,
    },
    /// An exit gate was evaluated.
    GateEvaluated {
        /// Recorded gate identity.
        gate_id: GateId,
        /// Evaluated phase visit.
        phase_visit_id: PhaseVisitId,
        /// Explicit gate result.
        result: GateResult,
    },
    /// An exit gate passed.
    GatePassed {
        /// Recorded gate identity.
        gate_id: GateId,
        /// Evaluated phase visit.
        phase_visit_id: PhaseVisitId,
    },
    /// A phase visit ended after a gate passed.
    PhaseExited {
        /// Exited visit identity.
        phase_visit_id: PhaseVisitId,
        /// Exited phase.
        phase: Phase,
        /// Gate that authorized the exit.
        gate_id: GateId,
    },
}
