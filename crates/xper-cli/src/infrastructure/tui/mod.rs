//! Full-screen infrastructure; application operations run on background workers.

mod catalog;
mod inventory;
mod model;
mod view;
mod worker;

use crossterm::event::{self, Event as TerminalEvent, KeyCode, KeyEventKind, KeyModifiers};
use model::{Action, App, Effect, Section, Stage, scope_label};
use std::{
    io,
    path::PathBuf,
    time::{Duration, Instant},
};
use worker::{CatalogRequest, DataRequest, Event, Workers};
use xper_application::{read_models::RunPage, use_cases::get_run_status};

pub(crate) fn run(root: PathBuf, ascii: bool) -> io::Result<bool> {
    let mut app = App::new(root.display().to_string());
    let mut workers = Workers::new(root);
    dispatch(
        &mut workers,
        vec![
            Effect::LoadConfig,
            Effect::History {
                after: None,
                selected: None,
            },
        ],
    );
    let theme = view::Theme {
        color: std::env::var_os("NO_COLOR").is_none_or(|v| v.is_empty()),
        ascii,
    };
    ratatui::run(|terminal| -> io::Result<bool> {
        let mut dirty = true;
        let mut refresh = Instant::now();
        let mut search = Instant::now();
        while !app.quit {
            while let Ok(event) = workers.events.try_recv() {
                apply_event(&mut app, event);
                dirty = true;
            }
            if matches!(app.section, Section::Status | Section::Metrics)
                && refresh.elapsed() >= Duration::from_secs(2)
                && !app.history_loading
            {
                refresh = Instant::now();
                app.history_loading = true;
                dispatch(
                    &mut workers,
                    vec![Effect::History {
                        after: None,
                        selected: app.selected_run(),
                    }],
                );
            }
            if app.section.authoring()
                && app.editor.stage == Stage::Picker
                && app.search_pending
                && search.elapsed() >= Duration::from_millis(150)
            {
                let effect = app.search_effect();
                dispatch(&mut workers, vec![effect]);
                dirty = true;
            }
            if dirty {
                terminal.draw(|frame| view::draw(frame, &app, theme))?;
                dirty = false;
            }
            if event::poll(Duration::from_millis(40))? {
                match event::read()? {
                    TerminalEvent::Key(key) if key.kind == KeyEventKind::Press => {
                        let size = terminal.size()?;
                        if (size.width < 48 || size.height < 12)
                            && !(key.code == KeyCode::Char('c')
                                && key.modifiers.contains(KeyModifiers::CONTROL))
                        {
                            continue;
                        }
                        let effects = app.handle(key);
                        dispatch(&mut workers, effects);
                        search = Instant::now();
                        dirty = true;
                    }
                    TerminalEvent::Resize(_, _) => dirty = true,
                    _ => {}
                }
            }
        }
        workers.catalog(CatalogRequest::Close);
        Ok(true)
    })
}

fn dispatch(workers: &mut Workers, effects: Vec<Effect>) {
    for effect in effects {
        let request = match effect {
            Effect::OpenCatalog => {
                workers.catalog(CatalogRequest::Open);
                continue;
            }
            Effect::CloseCatalog => {
                workers.catalog(CatalogRequest::Close);
                continue;
            }
            Effect::RefreshCatalog => {
                workers.catalog(CatalogRequest::Refresh);
                continue;
            }
            Effect::Search {
                sequence,
                query,
                provider,
            } => {
                workers.catalog(CatalogRequest::Search {
                    sequence,
                    query,
                    provider,
                });
                continue;
            }
            Effect::LoadConfig => DataRequest::LoadConfig,
            Effect::History { after, selected } => DataRequest::History { after, selected },
            Effect::Detail(id) => DataRequest::Detail { id },
            Effect::Preview {
                snapshot,
                scope,
                changes,
                integrate_global,
            } => DataRequest::Preview {
                snapshot: *snapshot,
                scope,
                changes,
                integrate_global,
            },
            Effect::Save {
                snapshot,
                scope,
                changes,
                integration,
            } => DataRequest::Save {
                snapshot: *snapshot,
                scope,
                changes,
                integration,
            },
            Effect::Activate(name) => DataRequest::Activate(name),
        };
        let _ = workers.data.send(request);
    }
}

fn apply_event(app: &mut App, event: Event) {
    match event {
        Event::CatalogRoles(result) => {
            if app.section.authoring() {
                match result {
                    Ok(roles) => app.roles = roles,
                    Err(error) => app.catalog_error = Some(error),
                }
            }
        }
        Event::Configuration(result) => {
            app.busy = false;
            match result {
                Ok(snapshot) => {
                    app.configuration_loaded(snapshot);
                    app.editor.preview = None;
                    app.editor.integration = None;
                    app.notice = if app.dirty() {
                        "Files reloaded. Review your draft again before saving.".into()
                    } else {
                        "Ready. Enter opens Profiles; Tab changes section.".into()
                    };
                }
                Err(error) => app.notice = error,
            }
        }
        Event::History {
            after,
            selected,
            result,
        } => {
            app.history_loading = false;
            match result {
                Ok((page, outcome)) => {
                    apply_history(app, after.as_deref(), selected.as_deref(), page, outcome);
                }
                Err(error) => app.notice = format!("History unavailable: {error}"),
            }
        }
        Event::Detail { id, result } => match result {
            Ok(outcome) => {
                update_summary(app, &outcome);
                if app.selected_run().as_deref() == Some(&id) {
                    app.detail = outcome;
                }
            }
            Err(error) if app.selected_run().as_deref() == Some(&id) => app.notice = error,
            Err(_) => {}
        },
        Event::Preview(result) => {
            app.busy = false;
            match result {
                Ok((preview, integration)) => {
                    if preview.scope != app.editor.scope
                        || preview.changes != app.editor.changes
                        || integration.is_some()
                            != (app.editor.action == Action::ActivateProfile
                                && app.editor.scope
                                    == xper_application::configuration::ConfigurationScope::Global)
                        || app
                            .snapshot
                            .as_ref()
                            .is_none_or(|snapshot| snapshot.revision != preview.revision)
                    {
                        app.editor.preview = None;
                        app.notice = "Configuration changed while preparing this preview. Review the draft again before saving.".into();
                        return;
                    }
                    if app.editor.stage != Stage::Review {
                        app.editor.draft = preview.authoring.clone();
                    }
                    app.notice = if preview.diagnostics.is_empty() {
                        "Draft validated. Review the destination and changes before saving.".into()
                    } else {
                        preview.diagnostics.join("; ")
                    };
                    app.editor.preview = Some(preview);
                    app.editor.integration = integration;
                }
                Err(error) => {
                    app.editor.preview = None;
                    app.editor.integration = None;
                    app.notice = format!("Cannot save: {error}");
                }
            }
        }
        Event::Saved(result) => {
            app.busy = false;
            match result {
                Ok(snapshot) => {
                    let name = if app.editor.section == Section::Settings {
                        app.editor.context.clone()
                    } else {
                        app.editor.profile.clone()
                    };
                    let selection = snapshot
                        .effective_profile
                        .as_deref()
                        .unwrap_or("Pi defaults");
                    let notice = match app.editor.action {
                        Action::ActivateProfile if app.editor.integration.is_some() => format!(
                            "Selection saved in Global. Pi integration registered. Effective profile: {selection}. Open a new Pi session and check /xper status."
                        ),
                        Action::ActivateProfile | Action::ClearSelection => format!(
                            "Selection saved in {}. Effective profile here: {selection}. Start a new Pi session to prepare it.",
                            scope_label(app.editor.scope)
                        ),
                        Action::NewProfile | Action::EditProfile => format!(
                            "Profile '{name}' saved in {}. Activate it from its actions; changes apply to new Pi sessions.",
                            scope_label(app.editor.scope)
                        ),
                        Action::NewContext | Action::EditContext => format!(
                            "Context '{name}' saved in {}.",
                            scope_label(app.editor.scope)
                        ),
                        _ => format!(
                            "Removed '{name}' from {}. Inherited definitions may remain.",
                            scope_label(app.editor.scope)
                        ),
                    };
                    app.editor.changes.clear();
                    app.configuration_loaded(snapshot);
                    app.reset_editor();
                    app.editor.cursor = if app.editor.section == Section::Profiles {
                        app.profiles().iter().position(|p| p.name == name)
                    } else {
                        app.contexts().iter().position(|c| c.name == name)
                    }
                    .unwrap_or(0);
                    app.notice = notice;
                }
                Err(error) => {
                    app.editor.preview = None;
                    app.notice = format!(
                        "Not saved: {error}. F5 reloads files; review again before saving."
                    );
                }
            }
        }
        Event::Activated(result) => {
            app.busy = false;
            match result {
                Ok(snapshot) => {
                    let notice = format!(
                        "Legacy project override removed. Effective profile: {}. Applies to new Pi sessions.",
                        snapshot
                            .effective_profile
                            .as_deref()
                            .unwrap_or("Pi defaults")
                    );
                    app.configuration_loaded(snapshot);
                    app.reset_editor();
                    app.notice = notice;
                }
                Err(error) => app.notice = error,
            }
        }
        Event::CatalogOpened(result) => {
            if app.section.authoring() {
                app.catalog_loading = false;
                match result {
                    Ok((roles, models)) => {
                        app.roles = roles;
                        app.matches = models.clone();
                        app.models = models;
                        app.catalog_error = None;
                        if app.editor.stage == Stage::Picker {
                            app.search_pending = true;
                        }
                    }
                    Err(error) => app.catalog_error = Some(error),
                }
            }
        }
        Event::CatalogRefreshed(result) => {
            if app.section.authoring() {
                app.catalog_loading = false;
                match result {
                    Ok(models) => {
                        app.matches = models.clone();
                        app.models = models;
                        app.catalog_error = None;
                        if app.editor.stage == Stage::Picker {
                            app.search_pending = true;
                        }
                    }
                    Err(error) => app.catalog_error = Some(error),
                }
            }
        }
        Event::CatalogSearch { sequence, result } => {
            if app.section.authoring() && sequence == app.search_sequence {
                app.catalog_loading = false;
                match result {
                    Ok(models) => {
                        app.matches = models;
                        app.catalog_error = None;
                    }
                    Err(error) => {
                        app.matches.clear();
                        app.catalog_error = Some(error);
                    }
                }
            }
        }
    }
}

fn apply_history(
    app: &mut App,
    after: Option<&str>,
    requested_selection: Option<&str>,
    page: RunPage,
    outcome: get_run_status::Outcome,
) {
    // A refresh can replace the paging window while an older next-page request
    // is queued. That response no longer extends the displayed window.
    if after.is_some() && after != app.next_cursor.as_deref() {
        return;
    }
    let current = app.selected_run();
    let selected_run = current
        .as_ref()
        .and_then(|id| app.runs.iter().find(|run| &run.run_id == id))
        .cloned();
    let previous_pin = app.pinned_run.take();
    let mut prior = std::mem::take(&mut app.runs);
    prior.retain(|run| Some(&run.run_id) != previous_pin.as_ref());
    let overlaps = page
        .runs
        .iter()
        .any(|fresh| prior.iter().any(|old| old.run_id == fresh.run_id));

    if after.is_some() {
        app.runs = prior;
        for run in page.runs {
            if let Some(old) = app.runs.iter_mut().find(|old| old.run_id == run.run_id) {
                *old = run;
            } else {
                app.runs.push(run);
            }
        }
        app.next_cursor = page.next_cursor;
    } else if overlaps {
        app.runs = page.runs;
        let mut retained_tail = false;
        for run in prior {
            if !app.runs.iter().any(|fresh| fresh.run_id == run.run_id) {
                app.runs.push(run);
                retained_tail = true;
            }
        }
        if !retained_tail {
            app.next_cursor = page.next_cursor;
        }
    } else {
        if !prior.is_empty() {
            app.notice = "History advanced beyond the loaded window. The selected older run is pinned; n loads intervening history.".into();
        }
        app.runs = page.runs;
        app.next_cursor = page.next_cursor;
    }

    if let Some(run) = selected_run
        && !app.runs.iter().any(|fresh| fresh.run_id == run.run_id)
    {
        app.pinned_run = Some(run.run_id.clone());
        app.runs.push(run);
    }
    app.run_cursor = current
        .as_ref()
        .and_then(|id| app.runs.iter().position(|run| &run.run_id == id))
        .unwrap_or(0);
    update_summary(app, &outcome);
    if current.as_deref() == requested_selection || current.is_none() {
        app.detail = outcome;
    }
}

fn update_summary(app: &mut App, outcome: &get_run_status::Outcome) {
    if let Some(run) = &outcome.run
        && let Some(row) = app.runs.iter_mut().find(|row| row.run_id == run.run_id)
    {
        *row = run.clone();
    }
}

#[cfg(test)]
mod tests;

#[cfg(test)]
mod history_tests;
