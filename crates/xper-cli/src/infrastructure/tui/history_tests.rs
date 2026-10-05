//! History refreshes preserve identity without hiding gaps between loaded pages.

use super::{apply_event, model::App, worker::Event};
use xper_application::{
    read_models::{RunMetrics, RunPage, RunProjection},
    use_cases::get_run_status,
};

fn run(number: u64) -> RunProjection {
    RunProjection {
        run_id: number.to_string(),
        session_id: Some("synthetic-session".into()),
        status: "running".into(),
        phase: None,
        started_at: number,
        last_event_at: number,
        metrics: RunMetrics::default(),
    }
}

fn page(first: u64, last: u64, next: Option<&str>) -> RunPage {
    RunPage {
        runs: (last..=first).rev().map(run).collect(),
        next_cursor: next.map(str::to_owned),
    }
}

fn observed(mut run: RunProjection, status: &str) -> get_run_status::Outcome {
    run.status = status.into();
    get_run_status::Outcome {
        run: Some(run),
        timeline: vec![],
    }
}

fn history(app: &mut App, after: Option<&str>, page: RunPage, selected: Option<&str>) {
    let outcome = selected
        .map(|id| observed(run(id.parse().unwrap()), "refreshed"))
        .unwrap_or_default();
    apply_event(
        app,
        Event::History {
            after: after.map(str::to_owned),
            selected: selected.map(str::to_owned),
            result: Ok((page, outcome)),
        },
    );
}

#[test]
fn disjoint_refresh_reopens_pagination_and_retains_selected_run_until_gap_is_loaded() {
    let mut app = App::new("/synthetic/project".into());
    app.runs = page(60, 1, None).runs;
    app.run_cursor = 59;
    app.next_cursor = None;

    // More than one whole page arrived after the previous complete listing.
    history(&mut app, None, page(160, 111, Some("111")), Some("1"));
    assert_eq!(app.runs.len(), 51);
    assert_eq!(app.runs[0].run_id, "160");
    assert_eq!(app.runs.last().unwrap().run_id, "1");
    assert_eq!(app.pinned_run.as_deref(), Some("1"));
    assert_eq!(app.selected_run().as_deref(), Some("1"));
    assert_eq!(app.next_cursor.as_deref(), Some("111"));
    assert!(app.notice.contains("intervening history"));

    history(&mut app, Some("111"), page(110, 61, Some("61")), Some("1"));
    assert_eq!(app.runs.len(), 101);
    assert_eq!(app.runs[99].run_id, "61");
    assert_eq!(app.runs[100].run_id, "1");
    assert_eq!(app.pinned_run.as_deref(), Some("1"));
    history(&mut app, Some("61"), page(60, 11, Some("11")), Some("1"));
    history(&mut app, Some("11"), page(10, 1, None), Some("1"));

    assert_eq!(app.runs.len(), 160);
    assert_eq!(app.pinned_run, None);
    assert_eq!(app.next_cursor, None);
    assert_eq!(app.selected_run().as_deref(), Some("1"));
    assert_eq!(
        app.runs
            .iter()
            .map(|run| run.run_id.clone())
            .collect::<Vec<_>>(),
        (1..=160)
            .rev()
            .map(|number| number.to_string())
            .collect::<Vec<_>>()
    );
}

#[test]
fn overlapping_refresh_retains_loaded_tail_and_updates_older_selected_summary() {
    let mut app = App::new("/synthetic/project".into());
    app.runs = page(10, 1, None).runs;
    app.run_cursor = 9;
    app.next_cursor = None;
    history(&mut app, None, page(11, 7, Some("7")), Some("1"));
    assert_eq!(app.runs.len(), 11);
    assert_eq!(app.next_cursor, None);
    assert_eq!(app.pinned_run, None);
    assert_eq!(app.selected_run().as_deref(), Some("1"));
    assert_eq!(app.runs[10].status, "refreshed");
    assert_eq!(app.detail.run.as_ref().unwrap().status, "refreshed");

    apply_event(
        &mut app,
        Event::Detail {
            id: "1".into(),
            result: Ok(observed(run(1), "finished")),
        },
    );
    assert_eq!(app.runs[10].status, "finished");
    assert_eq!(app.detail.run.as_ref().unwrap().status, "finished");
}

#[test]
fn old_page_response_cannot_overwrite_the_reset_windows_cursor_or_order() {
    let mut app = App::new("/synthetic/project".into());
    app.runs = page(10, 6, Some("6")).runs;
    app.next_cursor = Some("6".into());
    history(&mut app, None, page(100, 51, Some("51")), Some("10"));
    let before = app.runs.clone();
    history(&mut app, Some("6"), page(5, 1, None), Some("10"));
    assert_eq!(app.runs, before);
    assert_eq!(app.next_cursor.as_deref(), Some("51"));
    assert_eq!(app.selected_run().as_deref(), Some("10"));
}

#[test]
fn selection_changes_discard_unneeded_pin_and_late_detail_does_not_replace_current_detail() {
    let mut app = App::new("/synthetic/project".into());
    app.runs = page(100, 51, Some("51")).runs;
    app.runs.push(run(1));
    app.pinned_run = Some("1".into());
    app.next_cursor = Some("51".into());
    app.run_cursor = 0;
    app.detail = observed(run(100), "current");
    apply_event(
        &mut app,
        Event::Detail {
            id: "1".into(),
            result: Ok(observed(run(1), "finished")),
        },
    );
    assert_eq!(app.runs.last().unwrap().status, "finished");
    assert_eq!(app.detail.run.as_ref().unwrap().run_id, "100");
    history(&mut app, None, page(100, 51, Some("51")), Some("100"));
    assert_eq!(app.pinned_run, None);
    assert_eq!(app.runs.len(), 50);
    assert_eq!(app.selected_run().as_deref(), Some("100"));
}
