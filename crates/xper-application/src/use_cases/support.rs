use crate::{
    ApplicationError,
    events::{Event, EventKind},
    ports::{Clock, IdGenerator, RunReader},
    read_models::{RunProjection, RunStatus},
};

pub(super) fn current(
    store: &impl RunReader,
    session_id: &str,
) -> Result<Option<RunProjection>, ApplicationError> {
    let id = store
        .session_run(session_id)
        .map_err(ApplicationError::dependency)?;
    id.map(|id| {
        let events = store
            .load_events(&id)
            .map_err(ApplicationError::dependency)?;
        crate::read_models::replay(&events)
            .map_err(|error| ApplicationError::Dependency(error.into()))
    })
    .transpose()
    .map(Option::flatten)
}

pub(super) fn active(
    store: &impl RunReader,
    session_id: &str,
) -> Result<RunProjection, ApplicationError> {
    let run =
        current(store, session_id)?.ok_or(ApplicationError::InvalidInput("start a run first"))?;
    if run.status != RunStatus::Active {
        return Err(ApplicationError::InvalidInput("run is not active"));
    }
    Ok(run)
}

pub(super) fn event(
    clock: &mut impl Clock,
    ids: &mut impl IdGenerator,
    run_id: &str,
    kind: EventKind,
) -> Event {
    Event {
        event_id: ids.next_id().as_str().to_owned(),
        run_id: run_id.into(),
        occurred_at_ms: clock.now().as_millis(),
        kind,
    }
}
