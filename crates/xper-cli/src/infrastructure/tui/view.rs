//! Infrastructure presentation of application snapshots and adapter metadata.

use ratatui::{
    Frame,
    layout::{Constraint, Layout, Rect},
    style::{Color, Modifier, Style},
    text::{Line, Span, Text},
    widgets::{Clear, List, ListItem, ListState, Paragraph, Tabs, Wrap},
};
use serde_json::Value;

use super::model::{Action, App, METRIC_FIXED_ROWS, NameKind, SCOPES, Section, Stage, scope_label};

#[derive(Clone, Copy)]
pub(super) struct Theme {
    pub color: bool,
    pub ascii: bool,
}
impl Theme {
    fn accent(self) -> Style {
        if self.color {
            Style::default()
                .fg(Color::Cyan)
                .add_modifier(Modifier::BOLD)
        } else {
            Style::default().add_modifier(Modifier::BOLD)
        }
    }
    fn muted(self) -> Style {
        Style::default().add_modifier(Modifier::DIM)
    }
    fn selected(self) -> Style {
        Style::default().add_modifier(Modifier::REVERSED | Modifier::BOLD)
    }
}

fn clean(value: &str) -> String {
    value.chars().filter(|c| !c.is_control()).collect()
}
fn line(value: impl Into<String>) -> Line<'static> {
    Line::from(clean(&value.into()))
}
fn paragraph(frame: &mut Frame, area: Rect, lines: Vec<Line<'static>>) {
    frame.render_widget(Paragraph::new(lines).wrap(Wrap { trim: false }), area);
}
fn list(frame: &mut Frame, area: Rect, rows: Vec<String>, selected: usize, theme: Theme) {
    let items: Vec<ListItem> = rows.into_iter().map(|s| ListItem::new(clean(&s))).collect();
    let mut state = ListState::default().with_selected((!items.is_empty()).then_some(selected));
    frame.render_stateful_widget(
        List::new(items)
            .highlight_style(theme.selected())
            .highlight_symbol(if theme.ascii { "> " } else { "› " }),
        area,
        &mut state,
    );
}

pub(super) fn draw(frame: &mut Frame, app: &App, theme: Theme) {
    let area = frame.area();
    if area.width < 48 || area.height < 12 {
        paragraph(
            frame,
            area,
            vec![
                line("Terminal too small"),
                line("Resize to at least 48 columns x 12 rows."),
                line("Your configuration draft is retained. Ctrl+C exits."),
            ],
        );
        return;
    }
    let rows = Layout::vertical([
        Constraint::Length(1),
        Constraint::Length(if area.width >= 120 { 0 } else { 2 }),
        Constraint::Min(1),
        Constraint::Length(2),
        Constraint::Length(1),
    ])
    .split(area);
    frame.render_widget(
        Paragraph::new(Line::from(vec![
            Span::styled("xper  ", theme.accent()),
            Span::raw(clean(&app.root)),
        ])),
        rows[0],
    );
    let selected = Section::ALL
        .iter()
        .position(|s| *s == app.section)
        .unwrap_or(0);
    if area.width < 80 {
        frame.render_widget(
            Paragraph::new(format!(
                "{} {}  |  Tab / 1-5: sections",
                selected + 1,
                app.section.label()
            ))
            .style(theme.accent()),
            rows[1],
        );
    } else if area.width < 120 {
        frame.render_widget(
            Tabs::new(
                Section::ALL
                    .iter()
                    .enumerate()
                    .map(|(i, s)| format!("{} {}", i + 1, s.label())),
            )
            .select(selected)
            .highlight_style(theme.selected())
            .divider("  "),
            rows[1],
        );
    }
    let content = if area.width >= 120 {
        let cols = Layout::horizontal([Constraint::Length(19), Constraint::Min(1)]).split(rows[2]);
        list(
            frame,
            cols[0],
            Section::ALL
                .iter()
                .enumerate()
                .map(|(i, s)| format!("{} {}", i + 1, s.label()))
                .collect(),
            selected,
            theme,
        );
        cols[1]
    } else {
        rows[2]
    };
    match app.section {
        Section::Home => home(frame, content, app, theme),
        Section::Profiles | Section::Settings => configuration(frame, content, app, theme),
        Section::Status | Section::Metrics => history(frame, content, app, theme),
    }
    let mut notice = app.notice.clone();
    if app.busy {
        notice = "Working... You can still interrupt with Ctrl+C.".into();
    }
    frame.render_widget(
        Paragraph::new(clean(&notice)).wrap(Wrap { trim: false }),
        rows[3],
    );
    frame.render_widget(Paragraph::new(hints(app)).style(theme.muted()), rows[4]);
    if app.help {
        overlay(
            frame,
            area,
            "Keyboard help",
            vec![
                "Tab / Shift+Tab or 1-5   Change section",
                "Arrows / j,k              Navigate lists",
                "Enter                    Open, choose or confirm",
                "Esc                      Back; keep or discard draft",
                "n                        New context/profile; next history page",
                "e / Space                Edit context / toggle provider",
                "Enter on a profile       Activate, edit, delete or clear selection",
                "a on profiles / roles    Activate / assign model to all roles",
                "t / c on roles           Thinking / choose context",
                "Delete                   Remove selected scope override",
                "F5 in Profiles/Settings  Reload files after external edits",
                "v on roles               Review profile before saving",
                "F4 in model search       Change provider filter",
                "r                        Refresh data or Pi model catalog",
                "u on profiles            Review removal of legacy local override",
                "q                        Quit (confirm unsaved changes)",
                "Ctrl+C                   Interrupt and exit without saving",
                "? / Enter / Esc          Close this help",
            ],
            theme,
        );
    }
    if let Some(kind) = app.editor.naming {
        let context = format!("Context: {}", app.editor.context);
        let body = if kind == NameKind::Context {
            vec![
                "Context name:",
                &app.editor.name,
                "",
                "A context defines which providers are allowed.",
                if app.editor.action == Action::NewProfile {
                    "Next: choose providers, then name the profile."
                } else {
                    "Next: choose providers, then review and save."
                },
                "Enter continues. Esc cancels.",
            ]
        } else {
            vec![
                "Profile name:",
                &app.editor.name,
                "",
                &context,
                "Next: choose a model for each role, then review and save.",
                "Enter creates a draft. Esc returns to contexts.",
            ]
        };
        overlay(
            frame,
            area,
            if kind == NameKind::Context {
                "New context"
            } else {
                "New profile"
            },
            body,
            theme,
        );
    }
    if app.confirm_discard {
        overlay(
            frame,
            area,
            "Unsaved configuration",
            vec![
                "Discard this draft?",
                "",
                "y / Enter  Discard     n / Esc  Keep editing",
            ],
            theme,
        );
    }
    if app.confirm_repair {
        overlay(
            frame,
            area,
            "Repair invalid configuration",
            vec![
                "This file cannot be edited as a structured document.",
                "Start a replacement draft for this scope?",
                "The original file stays untouched until you review and save.",
                "Other scopes are preserved.",
                "",
                "y / Enter  Start draft     n / Esc  Cancel",
            ],
            theme,
        );
    }
}

fn overlay(frame: &mut Frame, area: Rect, title: &str, body: Vec<&str>, theme: Theme) {
    let width = area.width.saturating_sub(4).min(76);
    let height = (body.len() as u16 + 3).min(area.height.saturating_sub(2));
    let rect = Rect::new(
        area.x + (area.width - width) / 2,
        area.y + (area.height - height) / 2,
        width,
        height,
    );
    frame.render_widget(Clear, rect);
    let mut lines = vec![Line::styled(clean(title), theme.accent()), line("")];
    lines.extend(body.into_iter().map(line));
    paragraph(frame, rect, lines);
}

fn home(frame: &mut Frame, area: Rect, app: &App, theme: Theme) {
    let mut lines = vec![Line::styled("Project overview", theme.accent()), line("")];
    if let Some(snapshot) = &app.snapshot {
        lines.push(line(format!(
            "Effective profile: {}",
            snapshot
                .effective_profile
                .as_deref()
                .unwrap_or("Pi defaults")
        )));
        lines.push(line(format!(
            "Legacy project override: {}",
            snapshot.active_profile.as_deref().unwrap_or("none")
        )));
        lines.push(line(""));
        lines.push(line(format!(
            "{} profiles  |  {} contexts",
            app.profiles().len(),
            app.contexts().len()
        )));
        lines.push(line("Enter: manage Profiles    5: Settings and contexts"));
        lines.extend(snapshot.diagnostics.iter().map(|s| line(s.clone())));
        if snapshot.documents.iter().all(|d| d.source.is_none()) {
            lines.push(line(""));
            lines.push(Line::styled(
                "Get started: Enter opens Profiles; n creates your first profile.",
                theme.accent(),
            ));
        }
    } else {
        lines.push(line("Loading configuration..."));
    }
    lines.push(line(""));
    if let Some(run) = app.runs.first() {
        lines.push(line(format!("Latest recording: {}", run.run_id)));
        lines.push(line(format!(
            "{}  |  phase {}  |  {} / {} attempts finished",
            run.status,
            run.phase.as_deref().unwrap_or("unknown"),
            run.metrics.attempts_finished,
            run.metrics.attempts_started
        )));
    } else {
        lines.push(line("No recorded runs in this project."));
    }
    lines.push(line(""));
    lines.push(line("Configure here; start and execute workflows in Pi."));
    lines.push(line("Recorded history can lag the live Pi workflow."));
    paragraph(frame, area, lines);
}

fn configuration(frame: &mut Frame, area: Rect, app: &App, theme: Theme) {
    let editor = &app.editor;
    let rows = Layout::vertical([
        Constraint::Length(3),
        Constraint::Min(1),
        Constraint::Length(4),
    ])
    .split(area);
    let title = match editor.stage {
        Stage::Scope => "Choose destination scope",
        Stage::ContextList => "Settings / Contexts",
        Stage::Actions => "Profile actions",
        Stage::LegacyOverride => "Remove legacy project override",
        Stage::Contexts => "Choose a context",
        Stage::Providers => "Allowed providers",
        Stage::Profiles => "Profiles",
        Stage::Roles => "Models by role",
        Stage::Picker => "Choose a model from Pi",
        Stage::Review => "Review configuration",
    };
    let title = if editor.stage == Stage::Actions {
        format!(
            "{}: {}",
            if editor.section == Section::Settings {
                "Context actions"
            } else {
                title
            },
            if editor.section == Section::Settings {
                &editor.context
            } else {
                &editor.profile
            }
        )
    } else if editor.stage == Stage::Scope {
        format!("{title}: {}", editor.action.label())
    } else {
        title.to_owned()
    };
    frame.render_widget(
        Paragraph::new(format!(
            "{}{}\n{}",
            title,
            if app.dirty() {
                "  [unsaved changes]"
            } else {
                ""
            },
            hints(app),
        ))
        .style(theme.accent()),
        rows[0],
    );
    let mut help = vec![];
    match editor.stage {
        Stage::Scope => {
            let entries = SCOPES
                .iter()
                .map(|scope| {
                    let purpose = match scope {
                        xper_application::configuration::ConfigurationScope::Global => {
                            "All projects for this user"
                        }
                        xper_application::configuration::ConfigurationScope::Project => {
                            "This project, shared configuration"
                        }
                        xper_application::configuration::ConfigurationScope::Local => {
                            "This project, private to this checkout"
                        }
                    };
                    format!("{:<16} {purpose}", scope_label(*scope))
                })
                .collect();
            list(frame, rows[1], entries, editor.cursor, theme);
            let name = if editor.section == Section::Settings {
                &editor.context
            } else {
                &editor.profile
            };
            help.push(line(format!(
                "{}: {}",
                editor.action.label(),
                if name.is_empty() { "new item" } else { name }
            )));
            help.push(line(
                "Precedence: Global < Project < Local. Review before saving.",
            ));
            help.push(line(
                "Activating a profile selects its name; it does not copy models between scopes.",
            ));
        }
        Stage::Actions => {
            let name = if editor.section == Section::Settings {
                &editor.context
            } else {
                &editor.profile
            };
            list(
                frame,
                rows[1],
                app.actions().iter().map(|a| a.label().to_owned()).collect(),
                editor.cursor,
                theme,
            );
            help.push(line(format!("Selected: {name}")));
            help.push(line(
                "Choose an action, then its scope. Changes are reviewed before saving.",
            ));
            help.push(line(
                "Deleting removes one scope's definition or override; inherited values can remain.",
            ));
        }
        Stage::LegacyOverride => {
            let name = app
                .snapshot
                .as_ref()
                .and_then(|s| s.active_profile.as_deref())
                .unwrap_or("none");
            paragraph(
                frame,
                rows[1],
                vec![
                    line(format!("Current legacy override: {name}")),
                    line(""),
                    line("This project override takes priority over all scoped selections."),
                    line("Enter removes it so Global / Project / Local selections can apply."),
                    line("Esc keeps it. Existing runs retain their frozen models."),
                ],
            );
        }
        Stage::ContextList => {
            let contexts = app.contexts();
            if app.snapshot.is_none() {
                paragraph(frame, rows[1], vec![line("Loading contexts...")]);
            } else if contexts.is_empty() {
                paragraph(
                    frame,
                    rows[1],
                    vec![
                        line("No contexts yet. Enter or n creates one."),
                        line("Contexts define which providers profiles may use."),
                    ],
                );
            } else {
                list(
                    frame,
                    rows[1],
                    contexts
                        .iter()
                        .map(|c| format!("{}  [{}]", c.name, c.source_label()))
                        .collect(),
                    editor.cursor,
                    theme,
                );
                if let Some(context) = contexts.get(editor.cursor) {
                    let providers = context
                        .value
                        .get("allowed_providers")
                        .and_then(Value::as_array)
                        .map(|a| {
                            a.iter()
                                .filter_map(Value::as_str)
                                .collect::<Vec<_>>()
                                .join(", ")
                        })
                        .unwrap_or_else(|| "not configured".into());
                    help.push(line(format!("Allowed providers: {providers}")));
                }
            }
            help.push(line(
                "Enter opens Edit / Delete. n creates a context independently of profiles.",
            ));
            help.push(line(
                "Provider credentials remain in Pi. Manage model roles under Profiles.",
            ));
        }
        Stage::Contexts => {
            let names = app.names("contexts");
            if names.is_empty() {
                paragraph(
                    frame,
                    rows[1],
                    vec![line("No contexts yet. Press n to create one.")],
                );
            } else {
                list(frame, rows[1], names, editor.cursor, theme);
            }
            help.push(line(format!("Destination: {}", scope_label(editor.scope))));
            help.push(line(
                "A context limits providers. Credentials remain in Pi.",
            ));
        }
        Stage::Providers => {
            let providers = app.providers();
            if providers.is_empty() {
                paragraph(
                    frame,
                    rows[1],
                    vec![line(
                        "No providers available. Refresh the Pi catalog to retry.",
                    )],
                );
            } else {
                list(
                    frame,
                    rows[1],
                    providers
                        .iter()
                        .map(|p| {
                            format!(
                                "[{}] {p}",
                                if editor.allowed.contains(p) { "x" } else { " " }
                            )
                        })
                        .collect(),
                    editor.cursor,
                    theme,
                );
            }
            help.push(line(format!("Context: {}", editor.context)));
            help.push(line(
                "Space toggles providers. Enter continues to review or profile naming.",
            ));
        }
        Stage::Profiles => {
            let profiles = app.profiles();
            if app.snapshot.is_none() {
                paragraph(frame, rows[1], vec![line("Loading profiles...")]);
            } else if profiles.is_empty() {
                paragraph(
                    frame,
                    rows[1],
                    vec![
                        line("No profiles yet. Enter or n creates one."),
                        line("Choose a scope, a context and the models for each role."),
                    ],
                );
            } else {
                list(
                    frame,
                    rows[1],
                    profiles
                        .iter()
                        .map(|p| {
                            format!(
                                "{}  [{}]{}",
                                p.name,
                                p.source_label(),
                                if p.effective_active { "  ACTIVE" } else { "" }
                            )
                        })
                        .collect(),
                    editor.cursor,
                    theme,
                );
                if let Some(profile) = profiles.get(editor.cursor) {
                    help.push(line(format!(
                        "Context: {}  |  Created in: {}",
                        profile
                            .value
                            .get("context")
                            .and_then(Value::as_str)
                            .unwrap_or("not configured"),
                        scope_label(profile.origin)
                    )));
                }
            }
            if let Some(snapshot) = &app.snapshot {
                let selections = snapshot
                    .documents
                    .iter()
                    .filter_map(|d| {
                        d.value
                            .as_ref()
                            .and_then(|v| v.get("profile"))
                            .and_then(Value::as_str)
                            .map(|name| format!("{}: {name}", scope_label(d.scope)))
                    })
                    .collect::<Vec<_>>()
                    .join(" | ");
                help.push(line(if selections.is_empty() {
                    "No scoped activation. Enter a profile to activate it.".into()
                } else {
                    selections
                }));
                if let Some(name) = &snapshot.active_profile {
                    help.push(line(format!(
                        "Legacy override: {name}. u reviews its removal."
                    )));
                }
            }
            help.push(line(
                "Enter: Activate / Edit / Delete / Remove activation. n: New profile.",
            ));
        }
        Stage::Roles => {
            let ids = app.role_ids();
            let entries = ids
                .iter()
                .map(|id| {
                    let label = app
                        .roles
                        .iter()
                        .find(|r| r.id == *id)
                        .map(|r| r.label.as_str())
                        .unwrap_or(id);
                    let route = app.route(id);
                    let provider = route
                        .and_then(|r| r.get("provider"))
                        .and_then(Value::as_str);
                    let model = route.and_then(|r| r.get("model")).and_then(Value::as_str);
                    let thinking = route
                        .and_then(|r| r.get("thinking"))
                        .and_then(Value::as_str)
                        .unwrap_or("off");
                    match (provider, model) {
                        (Some(p), Some(m)) => format!("{label:<15} {p}/{m}  ({thinking})"),
                        _ => format!("{label:<15} Unconfigured - execution stops at this role"),
                    }
                })
                .collect();
            list(frame, rows[1], entries, editor.cursor, theme);
            if let Some(id) = ids.get(editor.cursor) {
                if let Some(role) = app.roles.iter().find(|r| r.id == *id) {
                    help.push(line(role.guidance.clone()));
                }
                let origin = model_source(app, id);
                help.push(line(format!(
                    "Model source: {origin}; edits are saved to {}",
                    scope_label(editor.scope)
                )));
            }
            help.push(line(format!(
                "Profile: {}  |  context: {}",
                editor.profile,
                editor.draft["profiles"][&editor.profile]["context"]
                    .as_str()
                    .unwrap_or("unknown")
            )));
        }
        Stage::Picker => {
            let panes =
                Layout::vertical([Constraint::Length(2), Constraint::Min(1)]).split(rows[1]);
            paragraph(
                frame,
                panes[0],
                vec![
                    line(format!("Search: {}_", editor.query)),
                    line(format!(
                        "Provider: {}  [F4]{}",
                        editor.provider.as_deref().unwrap_or("all allowed"),
                        if editor.apply_all {
                            "  Apply selection to every role"
                        } else {
                            ""
                        }
                    )),
                ],
            );
            let matches = app.filtered_matches();
            if app.catalog_loading || app.search_pending {
                paragraph(frame, panes[1], vec![line("Searching Pi catalog...")]);
            } else if matches.is_empty() {
                paragraph(
                    frame,
                    panes[1],
                    vec![line(if app.models.is_empty() {
                        "Pi has no available models. Configure a provider in Pi and refresh."
                    } else {
                        "No matching models allowed by this context."
                    })],
                );
            } else {
                list(
                    frame,
                    panes[1],
                    matches
                        .iter()
                        .map(|m| {
                            format!(
                                "{} / {}{}",
                                m.provider,
                                m.model,
                                if m.reasoning { "  [reasoning]" } else { "" }
                            )
                        })
                        .collect(),
                    editor.cursor,
                    theme,
                );
            }
            help.push(line("Type to search using Pi's native fuzzy matching."));
            help.push(line(
                "Enter selects the highlighted exact identifier; Esc keeps the previous model.",
            ));
        }
        Stage::Review => {
            if let Some(preview) = &editor.preview {
                let mut lines = vec![
                    Line::styled(
                        format!("{} in {}", editor.action.label(), scope_label(editor.scope)),
                        theme.accent(),
                    ),
                    line(format!(
                        "{}{}",
                        if editor.section == Section::Settings {
                            "Context: "
                        } else {
                            "Profile: "
                        },
                        if editor.section == Section::Settings {
                            &editor.context
                        } else {
                            &editor.profile
                        }
                    )),
                    line(format!(
                        "Effective profile after save: {}",
                        app.snapshot
                            .as_ref()
                            .and_then(|s| s.active_profile.as_deref())
                            .or_else(|| preview.effective.get("profile").and_then(Value::as_str))
                            .unwrap_or("Pi defaults")
                    )),
                    line("Applies to new Pi sessions; existing runs retain their models."),
                    line(format!("Destination: {}", preview.path)),
                    line(format!(
                        "{} draft changes; {}",
                        editor.changes.len(),
                        if preview.changed {
                            "file will change"
                        } else {
                            "no file changes"
                        }
                    )),
                    line(""),
                ];
                lines.extend(preview.diagnostics.iter().map(|s| line(s.clone())));
                lines.push(line(""));
                if let Some(doc) = app
                    .snapshot
                    .as_ref()
                    .and_then(|s| s.documents.iter().find(|d| d.scope == editor.scope))
                {
                    lines.push(Line::styled("Before", theme.muted()));
                    lines.extend(
                        doc.source
                            .as_deref()
                            .unwrap_or("(new file)")
                            .lines()
                            .map(line),
                    );
                    lines.push(line(""));
                }
                lines.push(Line::styled("After", theme.accent()));
                lines.extend(preview.source.lines().map(line));
                lines.push(line(format!(
                    "Effective default: {}",
                    preview
                        .effective
                        .get("profile")
                        .and_then(Value::as_str)
                        .unwrap_or("none (Pi defaults)")
                )));
                lines.push(line(format!(
                    "Legacy project override: {}",
                    app.snapshot
                        .as_ref()
                        .and_then(|s| s.active_profile.as_deref())
                        .unwrap_or("none")
                )));
                lines.push(line(""));
                lines.extend(preview.diagnostics.iter().map(|s| line(s.clone())));
                frame.render_widget(
                    Paragraph::new(Text::from(lines))
                        .wrap(Wrap { trim: false })
                        .scroll((editor.preview_scroll, 0)),
                    rows[1],
                );
                help.push(line(
                    "Enter confirms this change. Esc returns without saving.",
                ));
                help.push(line("Creating or editing a profile does not activate it. Use its Activate action after saving."));
            } else {
                paragraph(
                    frame,
                    rows[1],
                    vec![line(if app.busy {
                        "Validating draft..."
                    } else {
                        "Preview unavailable. Esc returns to editing; v retries validation."
                    })],
                );
            }
        }
    }
    if let Some(error) = &app.catalog_error {
        help.insert(0, line(error.clone()));
    } else if app.catalog_loading && editor.stage != Stage::Picker {
        help.insert(0, line("Loading Pi catalog..."));
    }
    paragraph(frame, rows[2], help);
}

fn model_source<'a>(app: &'a App, id: &str) -> &'a str {
    let path = [
        "profiles",
        app.editor.profile.as_str(),
        "roles",
        id,
        "model",
    ];
    if app.editor.changes.iter().any(|change| {
        let changed = match change {
            xper_application::configuration::ConfigurationChange::Set { path, .. }
            | xper_application::configuration::ConfigurationChange::Remove { path } => path,
        };
        changed.len() <= path.len() && changed.iter().zip(path).all(|(a, b)| a == b)
    }) {
        return "draft";
    }
    app.snapshot
        .as_ref()
        .and_then(|snapshot| {
            snapshot
                .documents
                .iter()
                .rev()
                .filter(|document| document.scope <= app.editor.scope)
                .find(|document| {
                    document
                        .value
                        .as_ref()
                        .and_then(|root| path.iter().try_fold(root, |value, key| value.get(*key)))
                        .is_some()
                })
                .map(|document| scope_label(document.scope))
        })
        .unwrap_or("unconfigured")
}

fn history(frame: &mut Frame, area: Rect, app: &App, theme: Theme) {
    if app.runs.is_empty() {
        paragraph(
            frame,
            area,
            vec![
                line(if app.history_loading {
                    "Loading recorded runs..."
                } else {
                    "No recorded runs in this project."
                }),
                line("Workflows execute in Pi. This dashboard reads reported history."),
            ],
        );
        return;
    }
    if app.detail_open {
        detail(frame, area, app, theme);
        return;
    }
    let (list_area, detail_area) = if area.width >= 100 {
        let cols = Layout::horizontal([Constraint::Percentage(43), Constraint::Percentage(57)])
            .split(area);
        (cols[0], Some(cols[1]))
    } else {
        (area, None)
    };
    let rows = Layout::vertical([
        Constraint::Length(2),
        Constraint::Min(1),
        Constraint::Length(2),
    ])
    .split(list_area);
    frame.render_widget(
        Paragraph::new("Recorded runs").style(theme.accent()),
        rows[0],
    );
    list(
        frame,
        rows[1],
        app.runs
            .iter()
            .map(|r| {
                format!(
                    "{}{}  {}  {}",
                    r.run_id,
                    if app.pinned_run.as_deref() == Some(&r.run_id) {
                        " [pinned]"
                    } else {
                        ""
                    },
                    r.status,
                    r.phase.as_deref().unwrap_or("unknown")
                )
            })
            .collect(),
        app.run_cursor,
        theme,
    );
    paragraph(
        frame,
        rows[2],
        vec![
            line(if app.next_cursor.is_some() {
                "n  Load older runs"
            } else {
                "End of recorded history"
            }),
            line("Enter opens detail. Recorded history may lag Pi."),
        ],
    );
    if let Some(area) = detail_area {
        detail(frame, area, app, theme);
    }
}

fn number(value: Option<u64>) -> String {
    value
        .map(|n| n.to_string())
        .unwrap_or_else(|| "unknown".into())
}
fn detail(frame: &mut Frame, area: Rect, app: &App, theme: Theme) {
    let Some(run) = &app.detail.run else {
        paragraph(frame, area, vec![line("Loading selected recording...")]);
        return;
    };
    if app.selected_run().as_deref() != Some(&run.run_id) {
        paragraph(frame, area, vec![line("Loading selected recording...")]);
        return;
    }
    let mut lines = vec![
        Line::styled(clean(&run.run_id), theme.accent()),
        line(format!(
            "{} | phase {}",
            run.status,
            run.phase.as_deref().unwrap_or("unknown")
        )),
        line(format!("Last report: {}", timestamp(run.last_event_at))),
        line(""),
    ];
    if app.section == Section::Metrics {
        let rows = Layout::vertical([Constraint::Length(4), Constraint::Min(1)]).split(area);
        paragraph(frame, rows[0], std::mem::take(&mut lines));
        let m = &run.metrics;
        lines.extend([
            line(format!("Formula version    {}", m.formula_version)),
            line(format!("Events             {}", m.event_count)),
            line(format!("Attempts started   {}", m.attempts_started)),
            line(format!("Attempts finished  {}", m.attempts_finished)),
            line(format!("Usage reports      {}", m.usage_reports)),
            line(format!("Input tokens       {}", number(m.input_tokens))),
            line(format!("Output tokens      {}", number(m.output_tokens))),
            line(format!(
                "Reported cost      {}",
                m.cost_micros
                    .map(|n| format!("${}.{:06}", n / 1_000_000, n % 1_000_000))
                    .unwrap_or_else(|| "unknown".into())
            )),
        ]);
        let sources: std::collections::BTreeSet<&str> = app
            .detail
            .timeline
            .iter()
            .filter(|e| e.event_type == "model.usage")
            .map(|e| {
                e.data
                    .get("costSource")
                    .and_then(Value::as_str)
                    .unwrap_or("unknown")
            })
            .collect();
        lines.push(line(format!(
            "Cost provenance    {}",
            if sources.is_empty() {
                "unknown".into()
            } else {
                sources.into_iter().collect::<Vec<_>>().join(", ")
            }
        )));
        if let Some(outcomes) = &m.outcomes {
            for (outcome, count) in outcomes {
                lines.push(line(format!("Outcome {outcome}: {count}")));
            }
        } else {
            lines.push(line("Outcome counts: unknown"));
        }
        lines.push(line(""));
        lines.push(line(
            "Reported totals only; Pi estimates are not provider invoices.",
        ));
        lines.push(line("Missing measurements remain unknown."));
        debug_assert_eq!(
            lines.len(),
            METRIC_FIXED_ROWS + m.outcomes.as_ref().map_or(1, |outcomes| outcomes.len())
        );
        // Scroll logical metric rows before wrapping, independently of how many
        // events produced them. The run identity and last report remain visible.
        frame.render_widget(
            Paragraph::new(
                lines
                    .into_iter()
                    .skip(app.timeline_cursor)
                    .collect::<Vec<_>>(),
            )
            .wrap(Wrap { trim: false }),
            rows[1],
        );
    } else {
        let rows = Layout::vertical([Constraint::Length(6), Constraint::Min(1)]).split(area);
        lines.push(line(format!(
            "Attempts finished  {} / {}",
            run.metrics.attempts_finished, run.metrics.attempts_started
        )));
        paragraph(frame, rows[0], lines);
        list(
            frame,
            rows[1],
            app.detail
                .timeline
                .iter()
                .map(|e| {
                    format!(
                        "{}  {}  {}",
                        timestamp(e.occurred_at),
                        e.event_type,
                        e.event_id
                    )
                })
                .collect(),
            app.timeline_cursor,
            theme,
        );
    }
}

pub(super) fn hints(app: &App) -> &'static str {
    if app.editor.naming.is_some() && app.section.authoring() {
        return "Enter: create draft  Esc: cancel";
    }
    if app.section.authoring() {
        return match app.editor.stage {
            Stage::Scope => "Enter: choose scope  Esc: back  ?: help",
            Stage::ContextList => "Enter: actions  n: new context  F5: reload  ?: help",
            Stage::Actions => "Up/Down: choose action  Enter: continue  Esc: back",
            Stage::LegacyOverride => "Enter: remove override  Esc: cancel",
            Stage::Contexts => "Enter: choose context  n: new context  Esc: back",
            Stage::Providers => "Space: toggle  Enter: continue  r: refresh  Esc: back",
            Stage::Profiles
                if app
                    .snapshot
                    .as_ref()
                    .is_some_and(|s| s.active_profile.is_some()) =>
            {
                "Enter: actions  n: new  u: legacy override  F5: reload"
            }
            Stage::Profiles => "Enter: actions  n: new profile  F5: reload  ?: help",
            Stage::Roles => "Enter: model  a: all  t: thinking  v: review  ?: help",
            Stage::Picker => "Type: search  F4: provider  Enter: select  Esc: back",
            Stage::Review => "Enter: confirm and save  Up/Down: scroll  Esc: back",
        };
    }
    if matches!(app.section, Section::Status | Section::Metrics) {
        "Enter: detail  Esc: back  r: refresh  Tab: section  ?: help"
    } else {
        "Enter: Profiles  5: Settings  Tab: section  ?: help"
    }
}

fn timestamp(milliseconds: u64) -> String {
    time::OffsetDateTime::from_unix_timestamp_nanos(i128::from(milliseconds) * 1_000_000)
        .ok()
        .and_then(|date| {
            date.format(&time::format_description::well_known::Rfc3339)
                .ok()
        })
        .unwrap_or_else(|| "unknown timestamp".into())
}

#[cfg(test)]
mod metrics_tests {
    use super::*;
    use crossterm::event::{KeyCode, KeyEvent, KeyModifiers};
    use ratatui::{Terminal, backend::TestBackend};
    use serde_json::json;
    use xper_application::{events::RecordedEvent, read_models::replay, use_cases::get_run_status};

    fn screen(app: &App) -> String {
        let mut terminal = Terminal::new(TestBackend::new(60, 24)).unwrap();
        terminal
            .draw(|frame| {
                draw(
                    frame,
                    app,
                    Theme {
                        color: false,
                        ascii: true,
                    },
                )
            })
            .unwrap();
        terminal
            .backend()
            .buffer()
            .content
            .iter()
            .map(|cell| cell.symbol())
            .collect()
    }

    #[test]
    fn few_recorded_events_do_not_prevent_scrolling_to_final_metrics_at_sixty_columns() {
        let events = [
            (
                "usage",
                "model.usage",
                json!({"costSource":"provider estimate with preserved source metadata; ".repeat(4)}),
            ),
            (
                "finish",
                "attempt.finished",
                json!({"attemptId":"one","outcome":"accepted"}),
            ),
        ]
        .into_iter()
        .map(|(id, kind, data)| RecordedEvent {
            schema_version: 1,
            event_id: id.into(),
            run_id: "short-recording".into(),
            occurred_at: 100,
            event_type: kind.into(),
            data: data.as_object().unwrap().clone(),
        })
        .collect::<Vec<_>>();
        let run = replay("session", &events).unwrap();
        let mut app = App::new("/synthetic/project".into());
        app.section = Section::Metrics;
        app.runs = vec![run.clone()];
        app.detail = get_run_status::Outcome {
            run: Some(run),
            timeline: events,
        };
        app.detail_open = true;
        assert!(!screen(&app).contains("Missing measurements remain unknown."));
        for _ in 0..10 {
            app.handle(KeyEvent::new(KeyCode::Down, KeyModifiers::NONE));
        }
        let rendered = screen(&app);
        assert!(app.timeline_cursor > app.detail.timeline.len());
        assert!(rendered.contains("short-recording"));
        assert!(rendered.contains("Reported totals only"));
        assert!(rendered.contains("Missing measurements remain unknown."));

        // Repeated Down stops at the final metric row rather than a blank view.
        for _ in 0..30 {
            app.handle(KeyEvent::new(KeyCode::Down, KeyModifiers::NONE));
        }
        assert!(screen(&app).contains("Missing measurements remain unknown."));
        app.handle(KeyEvent::new(KeyCode::Tab, KeyModifiers::NONE));
        assert_eq!(app.timeline_cursor, 0);
    }
}
