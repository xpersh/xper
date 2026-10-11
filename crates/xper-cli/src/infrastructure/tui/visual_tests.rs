//! Presentation regressions use synthetic state and inspect terminal cells directly.

use super::{
    catalog::{Model, Role},
    model::{Action, App, NameKind, Section, Stage},
    view::{self, Theme},
};
use crossterm::event::{KeyCode, KeyEvent, KeyModifiers};
use ratatui::{
    Terminal,
    backend::TestBackend,
    buffer::Buffer,
    style::{Color, Modifier},
};
use serde_json::{Value, json};
use std::collections::BTreeMap;
use xper_application::configuration::{
    ConfigurationChange, ConfigurationDocument, ConfigurationPreview, ConfigurationScope as Scope,
    ConfigurationSnapshot,
};

const SIZES: [(u16, u16); 4] = [(140, 40), (80, 24), (60, 24), (48, 12)];

fn configured() -> App {
    let mut app = App::new("/synthetic/project".into());
    let value = json!({
        "contexts": {"company": {"allowed_providers": ["example"]}},
        "profiles": {
            "personal": {"context": "company", "roles": {}},
            "work": {"context": "company", "roles": {
                "design.designer": {"provider": "example", "model": "synthetic-model", "thinking": "off"}
            }}
        },
        "profile": "work"
    });
    let scopes = [Scope::Global, Scope::Project, Scope::Local];
    app.configuration_loaded(ConfigurationSnapshot {
        documents: scopes
            .iter()
            .map(|scope| ConfigurationDocument {
                scope: *scope,
                path: format!("/synthetic/{scope:?}.yaml"),
                source: (*scope == Scope::Project).then(|| value.to_string()),
                value: (*scope == Scope::Project).then(|| value.clone()),
                error: None,
            })
            .collect(),
        effective: Some(value.clone()),
        scoped: scopes
            .iter()
            .map(|scope| {
                (
                    *scope,
                    if *scope >= Scope::Project {
                        value.clone()
                    } else {
                        json!({})
                    },
                )
            })
            .collect(),
        origins: BTreeMap::new(),
        default_profile: Some("work".into()),
        active_profile: None,
        effective_profile: Some("work".into()),
        diagnostics: vec![],
        revision: 1,
    });
    app.editor.profile = "work".into();
    app.editor.context = "company".into();
    app.roles = vec![Role {
        id: "design.designer".into(),
        label: "Designer".into(),
        guidance: "Choose a model for design.".into(),
    }];
    app.models = vec![Model {
        provider: "example".into(),
        model: "synthetic-model".into(),
        reasoning: false,
    }];
    app.matches = app.models.clone();
    app.notice = "Ready.".into();
    app
}

fn profiles(app: &mut App) {
    app.section = Section::Profiles;
    app.editor.section = Section::Profiles;
    app.editor.stage = Stage::Profiles;
    app.editor.cursor = 1;
}

fn recorded() -> App {
    use xper_application::{events::RecordedEvent, read_models::replay, use_cases::get_run_status};

    let events = vec![RecordedEvent {
        schema_version: 1,
        event_id: "synthetic-start".into(),
        run_id: "recording-one".into(),
        occurred_at: 1_000,
        event_type: "run.started".into(),
        data: serde_json::Map::new(),
    }];
    let run = replay("synthetic-session", &events).unwrap();
    let mut app = configured();
    app.runs = vec![run.clone()];
    app.detail = get_run_status::Outcome {
        run: Some(run),
        timeline: events,
    };
    app
}

fn draft_state(app: &App) -> Value {
    json!({
        "draft": app.editor.draft,
        "changes": format!("{:?}", app.editor.changes),
        "stage": format!("{:?}", app.editor.stage),
        "name": app.editor.name,
        "query": app.editor.query,
        "cursor": app.editor.cursor,
        "roleCursor": app.editor.role_cursor,
        "reviewScroll": app.editor.preview_scroll,
        "dirty": app.dirty(),
    })
}

fn render(app: &App, width: u16, height: u16, theme: Theme) -> Buffer {
    let before = draft_state(app);
    let mut terminal = Terminal::new(TestBackend::new(width, height)).unwrap();
    terminal
        .draw(|frame| view::draw(frame, app, theme))
        .unwrap();
    assert_eq!(draft_state(app), before, "Rendering changed the draft");
    terminal.backend().buffer().clone()
}

fn rows(buffer: &Buffer) -> Vec<String> {
    (0..buffer.area.height)
        .map(|y| {
            (0..buffer.area.width)
                .map(|x| buffer[(x, y)].symbol())
                .collect()
        })
        .collect()
}

fn text(buffer: &Buffer) -> String {
    rows(buffer).join("\n")
}

fn contains(buffer: &Buffer, expected: &str) {
    let rendered = text(buffer);
    assert!(
        rendered.contains(expected),
        "Missing {expected:?} at {}x{}:\n{rendered}",
        buffer.area.width,
        buffer.area.height,
    );
}

#[test]
fn responsive_chrome_uses_optional_borders_and_preserves_terminal_colors() {
    for (width, height) in SIZES {
        for color in [false, true] {
            for ascii in [false, true] {
                let buffer = render(&configured(), width, height, Theme { color, ascii });
                contains(&buffer, "Project overview");
                contains(&buffer, "Effective profile:");
                contains(&buffer, "work");
                for cell in &buffer.content {
                    assert_eq!(
                        cell.bg,
                        Color::Reset,
                        "Terminal background must be inherited"
                    );
                    assert!(!cell.modifier.contains(Modifier::REVERSED));
                    assert!(matches!(cell.fg, Color::Reset | Color::Cyan));
                    if !color {
                        assert_eq!(cell.fg, Color::Reset);
                    }
                }
                let rendered = text(&buffer);
                assert!(!rendered.contains('\u{1b}'));
                if ascii {
                    assert!(
                        rendered.is_ascii(),
                        "ASCII chrome introduced a Unicode glyph"
                    );
                    if height >= 24 {
                        assert!(rendered.contains('+') && rendered.contains('-'));
                    }
                } else if height >= 24 {
                    assert!(rendered.contains('╭') && rendered.contains('╯'));
                } else {
                    assert!(!rendered.contains(['╭', '╯', '│']));
                }
            }
        }
    }
}

#[test]
fn selected_profile_keeps_marker_bold_scope_and_active_label_without_color() {
    for (width, height) in SIZES {
        for color in [false, true] {
            for ascii in [false, true] {
                let mut app = configured();
                profiles(&mut app);
                let buffer = render(&app, width, height, Theme { color, ascii });
                let rendered = rows(&buffer);
                let y = rendered
                    .iter()
                    .position(|row| row.contains("work") && row.contains("ACTIVE"))
                    .unwrap_or_else(|| panic!("Selected profile is hidden:\n{}", text(&buffer)));
                assert!(rendered[y].contains("Project"));
                assert!(rendered[y].contains(if ascii { '>' } else { '›' }));
                let x = (0..width)
                    .find(|x| buffer[(*x, y as u16)].symbol() == "w")
                    .unwrap();
                assert!(buffer[(x, y as u16)].modifier.contains(Modifier::BOLD));
                contains(&buffer, "Enter");
            }
        }
    }
}

#[test]
fn compact_dialogs_keep_confirmation_and_cancel_visible_with_long_names() {
    for (width, height) in SIZES {
        for ascii in [false, true] {
            for title in [
                "New profile",
                "New context",
                "Unsaved configuration",
                "Repair invalid configuration",
                "Keyboard help",
            ] {
                let mut app = configured();
                profiles(&mut app);
                app.editor.name = format!("{}visible-tail", "long-name-".repeat(20));
                app.editor.context = "long-context-".repeat(20);
                match title {
                    "New profile" => app.editor.naming = Some(NameKind::Profile),
                    "New context" => app.editor.naming = Some(NameKind::Context),
                    "Unsaved configuration" => app.confirm_discard = true,
                    "Repair invalid configuration" => app.confirm_repair = true,
                    "Keyboard help" => app.help = true,
                    _ => unreachable!(),
                }
                let buffer = render(
                    &app,
                    width,
                    height,
                    Theme {
                        color: false,
                        ascii,
                    },
                );
                contains(&buffer, title);
                contains(&buffer, "Enter");
                contains(&buffer, "Esc");
                if app.editor.naming.is_some() {
                    contains(&buffer, "visible-tail");
                }
                if app.confirm_discard {
                    contains(&buffer, "Discard");
                    contains(&buffer, "Keep");
                }
            }
        }
    }
}

#[test]
fn compact_modal_clears_underlying_text_from_the_screen_edges() {
    let mut app = configured();
    profiles(&mut app);
    app.editor.naming = Some(NameKind::Profile);
    app.editor.name = "new-profile".into();
    for ascii in [false, true] {
        let mut terminal = Terminal::new(TestBackend::new(48, 12)).unwrap();
        terminal
            .draw(|frame| {
                frame.render_widget(
                    ratatui::widgets::Paragraph::new(vec!["X".repeat(48); 12].join("\n")),
                    frame.area(),
                );
                view::draw(
                    frame,
                    &app,
                    Theme {
                        color: false,
                        ascii,
                    },
                );
            })
            .unwrap();
        let buffer = terminal.backend().buffer();
        contains(buffer, "New profile");
        contains(buffer, "Enter");
        contains(buffer, "Esc");
        for y in 0..12 {
            assert_eq!(
                buffer[(0, y)].symbol(),
                " ",
                "Left edge leaked background text"
            );
            assert_eq!(
                buffer[(47, y)].symbol(),
                " ",
                "Right edge leaked background text"
            );
        }
        for x in 0..48 {
            assert_eq!(
                buffer[(x, 0)].symbol(),
                " ",
                "Header leaked through the modal"
            );
            assert_eq!(
                buffer[(x, 11)].symbol(),
                " ",
                "Footer leaked through the modal"
            );
        }
    }
}

#[test]
fn model_search_retains_query_tail_and_actions_with_wide_user_text() {
    for (width, height) in SIZES {
        let mut app = configured();
        profiles(&mut app);
        app.editor.cursor = 0;
        app.editor.stage = Stage::Picker;
        app.editor.query = format!("{}visible-tail", "界e\u{301}".repeat(40));
        let buffer = render(
            &app,
            width,
            height,
            Theme {
                color: true,
                ascii: false,
            },
        );
        contains(&buffer, "Choose a model");
        contains(&buffer, "visible-tail");
        contains(&buffer, "Enter");
        contains(&buffer, "Esc");
        contains(&buffer, "synthetic-model");
    }
}

#[test]
fn loading_empty_and_error_messages_remain_readable_in_compact_layouts() {
    for (width, height) in SIZES {
        let theme = Theme {
            color: false,
            ascii: true,
        };
        let mut app = App::new("/synthetic/empty".into());
        contains(&render(&app, width, height, theme), "Loading configuration");
        app.section = Section::Status;
        app.history_loading = true;
        contains(&render(&app, width, height, theme), "Loading recorded runs");
        app.history_loading = false;
        contains(&render(&app, width, height, theme), "No recorded runs");
        app.notice = "History unavailable: synthetic failure".into();
        contains(&render(&app, width, height, theme), "History unavailable:");
        let mut app = configured();
        profiles(&mut app);
        app.catalog_error = Some("Pi executable is missing".into());
        contains(
            &render(&app, width, height, theme),
            "Pi executable is missing",
        );
        app.catalog_error = None;
        app.catalog_loading = true;
        contains(&render(&app, width, height, theme), "Loading Pi catalog");
    }
}

#[test]
fn recorded_details_and_settings_preserve_identity_and_unknown_measurements() {
    for (width, height) in SIZES {
        for color in [false, true] {
            let theme = Theme {
                color,
                ascii: !color,
            };
            let mut app = recorded();
            app.section = Section::Status;
            contains(&render(&app, width, height, theme), "recording-one");
            app.detail_open = true;
            let buffer = render(&app, width, height, theme);
            contains(&buffer, "recording-one");
            contains(&buffer, "Last report:");
            app.section = Section::Metrics;
            for _ in 0..30 {
                app.handle(KeyEvent::new(KeyCode::Down, KeyModifiers::NONE));
            }
            let buffer = render(&app, width, height, theme);
            contains(&buffer, "recording-one");
            contains(&buffer, "Missing measurements remain unknown.");
            app.section = Section::Settings;
            app.editor.section = Section::Settings;
            app.editor.stage = Stage::ContextList;
            let buffer = render(&app, width, height, theme);
            contains(&buffer, "Settings / Contexts");
            contains(&buffer, "company");
        }
    }
}

#[test]
fn home_keeps_recording_summary_visible_when_identity_and_phase_wrap() {
    let mut app = recorded();
    let run = &mut app.runs[0];
    run.run_id = format!("{}recording-tail", "r".repeat(88));
    run.phase = Some(format!("{}phase-tail", "p".repeat(40)));
    run.metrics.attempts_finished = 7;
    run.metrics.attempts_started = 9;
    for (width, height) in [(60, 24), (80, 24), (140, 40)] {
        for ascii in [false, true] {
            let buffer = render(
                &app,
                width,
                height,
                Theme {
                    color: !ascii,
                    ascii,
                },
            );
            for expected in [
                "Project overview",
                "Effective profile:",
                "Latest recording",
                "recording-tail",
                "running",
                "phase-tail",
                "attempts finished",
            ] {
                contains(&buffer, expected);
            }
            // The count can wrap across rows; joining interior cells preserves
            // its readable order without treating a panel border as content.
            let summary = rows(&buffer)
                .iter()
                .map(|row| row.trim_matches([' ', '|', '│']))
                .collect::<Vec<_>>()
                .join(" ");
            let summary = summary.split_whitespace().collect::<Vec<_>>().join(" ");
            assert!(summary.contains("7 / 9 attempts finished"), "{summary}");
        }
    }
}

fn review() -> App {
    let mut app = configured();
    profiles(&mut app);
    app.editor.stage = Stage::Review;
    app.editor.action = Action::ActivateProfile;
    app.editor.changes.push(ConfigurationChange::Set {
        path: vec!["profile".into()],
        value: json!("work"),
    });
    app.editor.preview = Some(ConfigurationPreview {
        revision: 1,
        changes: app.editor.changes.clone(),
        scope: Scope::Project,
        path: "/synthetic/project.yaml".into(),
        source: "profile: work\n".into(),
        effective: app.editor.draft.clone(),
        authoring: app.editor.draft.clone(),
        changed: true,
        diagnostics: vec!["A higher scope may mask this selection.".into()],
    });
    app
}

#[test]
fn review_retains_scope_and_confirmation_while_content_scrolls() {
    for (width, height) in SIZES {
        let mut app = review();
        let theme = Theme {
            color: false,
            ascii: true,
        };
        let buffer = render(&app, width, height, theme);
        contains(&buffer, "Review configuration");
        contains(&buffer, "Project");
        contains(&buffer, "Enter");
        contains(&buffer, "Esc");
        app.editor.preview_scroll = 6;
        let buffer = render(&app, width, height, theme);
        contains(&buffer, "Review configuration");
        contains(&buffer, "Enter");
        contains(&buffer, "Esc");
    }
}

#[test]
fn resize_message_preserves_pending_draft_and_replaces_hidden_actions() {
    let mut app = review();
    app.confirm_discard = true;
    for (width, height) in [(47, 12), (48, 11), (40, 10)] {
        let buffer = render(
            &app,
            width,
            height,
            Theme {
                color: false,
                ascii: true,
            },
        );
        contains(&buffer, "Terminal too small");
        contains(&buffer, "Ctrl+C");
        assert!(!text(&buffer).contains("Discard"));
        assert!(app.dirty());
    }
}

/// Manual visual inspection aid; it never reads a user's configuration or launches Pi.
#[test]
#[ignore = "writes an optional synthetic visual gallery to the temporary directory"]
fn export_visual_gallery() {
    fn escape(value: &str) -> String {
        value
            .replace('&', "&amp;")
            .replace('<', "&lt;")
            .replace('>', "&gt;")
    }
    fn flush_run(html: &mut String, classes: &str, run: &mut String) {
        if !run.is_empty() {
            html.push_str(&format!("<span class='{classes}'>{}</span>", escape(run)));
            run.clear();
        }
    }
    let mut pages = vec![("Home", configured()), ("Review", review())];
    let mut app = configured();
    profiles(&mut app);
    pages.push(("Profiles", app));
    let mut app = configured();
    profiles(&mut app);
    app.editor.stage = Stage::Picker;
    app.editor.query = "synthetic".into();
    pages.push(("Model search", app));
    let mut app = configured();
    profiles(&mut app);
    app.editor.naming = Some(NameKind::Profile);
    app.editor.name = "new-profile".into();
    pages.push(("Name dialog", app));
    let mut app = recorded();
    app.section = Section::Status;
    pages.push(("Status", app));
    let mut app = recorded();
    app.section = Section::Metrics;
    app.detail_open = true;
    pages.push(("Metrics", app));
    let mut app = configured();
    app.section = Section::Settings;
    app.editor.section = Section::Settings;
    app.editor.stage = Stage::ContextList;
    pages.push(("Settings", app));
    let header = "<!doctype html><meta charset=utf-8><title>xper synthetic visual review</title><style>body{font-family:system-ui;margin:24px}article{overflow:auto;margin:24px 0;padding:16px;border:1px solid #888}pre{font:14px/1.35 monospace;margin:0}.dark{background:#172029;color:#e6edf3}.light{background:#fff;color:#18212b}.accent{color:#20a4ae}.bold{font-weight:700}.dim{opacity:.7}li{margin:6px 0}</style>";
    let directory = std::env::temp_dir().join("xper-tui-visual-preview");
    std::fs::create_dir_all(&directory).unwrap();
    let mut index = format!("{header}<h1>xper synthetic visual review</h1><ul>");
    let mut number = 0;
    for (width, height) in SIZES {
        for (label, app) in &pages {
            for (mode, theme) in [
                (
                    "dark",
                    Theme {
                        color: true,
                        ascii: false,
                    },
                ),
                (
                    "light",
                    Theme {
                        color: false,
                        ascii: true,
                    },
                ),
            ] {
                number += 1;
                let title = format!("{label} · {width}×{height} · {mode}");
                let filename = format!(
                    "{number:02}-{width}x{height}-{}-{mode}.html",
                    label.to_lowercase().replace(' ', "-")
                );
                index.push_str(&format!("<li><a href='{filename}'>{title}</a></li>"));
                let buffer = render(app, width, height, theme);
                let mut html = format!(
                    "{header}<a href='index.html'>All examples</a><h1>{title}</h1><article class='{mode}'><pre>"
                );
                for y in 0..height {
                    let mut previous = String::new();
                    let mut run = String::new();
                    let mut continuation = 0;
                    for x in 0..width {
                        if continuation > 0 {
                            continuation -= 1;
                            continue;
                        }
                        let cell = &buffer[(x, y)];
                        let mut classes = String::new();
                        if cell.fg == Color::Cyan {
                            classes.push_str("accent ");
                        }
                        if cell.modifier.contains(Modifier::BOLD) {
                            classes.push_str("bold ");
                        }
                        if cell.modifier.contains(Modifier::DIM) {
                            classes.push_str("dim");
                        }
                        if classes != previous {
                            flush_run(&mut html, &previous, &mut run);
                            previous = classes;
                        }
                        run.push_str(cell.symbol());
                        continuation = ratatui::text::Span::raw(cell.symbol())
                            .width()
                            .saturating_sub(1);
                    }
                    flush_run(&mut html, &previous, &mut run);
                    html.push('\n');
                }
                html.push_str("</pre></article>");
                std::fs::write(directory.join(filename), html).unwrap();
            }
        }
    }
    index.push_str("</ul>");
    let path = directory.join("index.html");
    std::fs::write(&path, index).unwrap();
    println!("Visual gallery: {}", path.display());
}
