use super::{
    apply_event,
    catalog::{Model, Role},
    model::{App, Effect, Section, Stage},
    view::{self, Theme},
    worker::Event,
};
use crossterm::event::{KeyCode, KeyEvent, KeyModifiers};
use ratatui::{Terminal, backend::TestBackend};
use serde_json::json;

fn key(code: KeyCode) -> KeyEvent {
    KeyEvent::new(code, KeyModifiers::NONE)
}
fn configured() -> App {
    let mut app = App::new("/synthetic/project".into());
    app.section = Section::Configuration;
    app.roles = vec![
        Role {
            id: "one".into(),
            label: "One".into(),
            guidance: "Choose manually".into(),
        },
        Role {
            id: "two".into(),
            label: "Two".into(),
            guidance: "Independent review".into(),
        },
    ];
    app.models = vec![
        Model {
            provider: "allowed".into(),
            model: "precise:model/1".into(),
            reasoning: false,
        },
        Model {
            provider: "forbidden".into(),
            model: "other".into(),
            reasoning: true,
        },
    ];
    app.matches = app.models.clone();
    app.editor.profile = "work".into();
    app.editor.context = "company".into();
    app.editor.draft = json!({"contexts":{"company":{"allowed_providers":["allowed"]}},"profiles":{"work":{"context":"company","roles":{"one":{"provider":"allowed","model":"old","thinking":"high"}}}}});
    app
}

#[test]
fn first_context_continues_to_profile_naming_and_cancel_can_resume_with_enter() {
    use super::model::NameKind;

    let mut app = configured();
    app.editor.draft = json!({});
    app.editor.changes.clear();
    app.editor.stage = Stage::Contexts;
    app.handle(key(KeyCode::Char('n')));
    for letter in "personal".chars() {
        app.handle(key(KeyCode::Char(letter)));
    }
    app.handle(key(KeyCode::Enter));
    assert_eq!(app.editor.stage, Stage::Providers);
    app.handle(key(KeyCode::Char(' ')));
    app.handle(key(KeyCode::Enter));

    assert_eq!(app.editor.stage, Stage::Profiles);
    assert_eq!(app.editor.naming, Some(NameKind::Profile));
    assert!(app.names("profiles").is_empty());
    assert_eq!(
        app.editor.draft["contexts"]["personal"]["allowed_providers"],
        json!(["allowed"])
    );
    let context_changes = app.editor.changes.clone();
    app.handle(key(KeyCode::Esc));
    assert_eq!(app.editor.naming, None);
    assert_eq!(app.editor.changes, context_changes);
    app.handle(key(KeyCode::Enter));
    assert_eq!(app.editor.naming, Some(NameKind::Profile));

    for letter in "daily".chars() {
        app.handle(key(KeyCode::Char(letter)));
    }
    app.handle(key(KeyCode::Enter));
    assert_eq!(app.editor.stage, Stage::Roles);
    assert!(app.editor.new_profile);
    assert_eq!(app.names("profiles"), vec!["daily"]);
    assert_eq!(app.editor.draft["profiles"]["daily"]["context"], "personal");
}

#[test]
fn continuing_a_context_keeps_existing_profiles_available() {
    let mut app = configured();
    app.editor.stage = Stage::Contexts;
    app.editor.cursor = 0;
    app.handle(key(KeyCode::Enter));
    assert_eq!(app.editor.stage, Stage::Profiles);
    assert!(app.editor.naming.is_none());
    assert_eq!(app.names("profiles"), vec!["work"]);
    app.handle(key(KeyCode::Enter));
    assert_eq!(app.editor.stage, Stage::Roles);
    assert!(!app.editor.new_profile);
}

#[test]
fn manual_selection_filters_context_and_applies_all_only_on_request() {
    let mut app = configured();
    app.editor.stage = Stage::Roles;
    assert!(matches!(
        app.handle(key(KeyCode::Char('a')))[0],
        Effect::Search { .. }
    ));
    app.catalog_loading = false;
    assert_eq!(app.filtered_matches().len(), 1);
    app.handle(key(KeyCode::Enter));
    for id in ["one", "two"] {
        assert_eq!(app.route(id).unwrap()["model"], "precise:model/1");
        assert_eq!(app.route(id).unwrap()["thinking"], "off");
    }
    assert!(app.dirty());
}

#[test]
fn search_owns_printable_shortcuts_and_late_results_are_ignored() {
    let mut app = configured();
    app.editor.stage = Stage::Picker;
    for c in ['q', '1', '?', '界', '\u{301}'] {
        app.handle(key(KeyCode::Char(c)));
    }
    assert!(!app.quit);
    assert!(!app.help);
    assert_eq!(app.editor.query, "q1?界\u{301}");
    app.search_sequence = 3;
    let before = app.matches.clone();
    apply_event(
        &mut app,
        Event::CatalogSearch {
            sequence: 2,
            result: Ok(vec![]),
        },
    );
    assert_eq!(app.matches, before);
    app.handle(key(KeyCode::Esc));
    assert_eq!(app.editor.stage, Stage::Roles);
    assert!(!app.dirty());
}

#[test]
fn incomplete_new_profile_cannot_finish_and_unsaved_quit_is_explicit() {
    let mut app = configured();
    app.editor.stage = Stage::Roles;
    app.editor.new_profile = true;
    assert!(app.handle(key(KeyCode::Char('v'))).is_empty());
    assert_eq!(app.editor.stage, Stage::Roles);
    app.handle(key(KeyCode::Char('d')));
    app.handle(key(KeyCode::Char('q')));
    assert!(app.confirm_discard);
    assert!(!app.quit);
    app.handle(key(KeyCode::Esc));
    assert!(!app.confirm_discard);
    assert!(app.dirty());
}

#[test]
fn selected_scope_uses_its_own_values_and_configuration_reload_retains_a_draft() {
    use std::collections::BTreeMap;
    use xper_application::configuration::{ConfigurationScope as Scope, ConfigurationSnapshot};
    let mut app = App::new("/synthetic/project".into());
    app.section = Section::Configuration;
    let global = json!({"contexts":{"global":{"allowed_providers":["allowed"]}}});
    let project = json!({"contexts":{"project":{"allowed_providers":["allowed"]}}});
    let snapshot = ConfigurationSnapshot {
        documents: vec![],
        scoped: BTreeMap::from([(Scope::Global, global), (Scope::Project, project.clone())]),
        effective: Some(project),
        origins: BTreeMap::new(),
        default_profile: None,
        active_profile: None,
        effective_profile: None,
        diagnostics: vec![],
        revision: 1,
    };
    app.configuration_loaded(snapshot.clone());
    app.editor.cursor = 0;
    app.handle(key(KeyCode::Enter));
    assert_eq!(app.names("contexts"), vec!["global"]);
    app.editor.stage = Stage::Roles;
    app.editor.profile = "draft".into();
    app.handle(key(KeyCode::Char('d')));
    assert!(matches!(
        app.handle(key(KeyCode::F(5)))[0],
        Effect::LoadConfig
    ));
    apply_event(&mut app, Event::Configuration(Ok(snapshot)));
    assert!(app.dirty());
    assert_eq!(app.editor.draft["profile"], "draft");
    assert!(app.editor.preview.is_none());
}

#[test]
fn configuration_reload_blocks_preview_and_rejects_stale_preview_results() {
    use std::collections::BTreeMap;
    use xper_application::configuration::{
        ConfigurationPreview, ConfigurationScope as Scope, ConfigurationSnapshot,
    };
    let mut app = configured();
    let value = app.editor.draft.clone();
    let mut snapshot = ConfigurationSnapshot {
        documents: vec![],
        effective: Some(value.clone()),
        scoped: BTreeMap::from([(Scope::Project, value.clone())]),
        origins: BTreeMap::new(),
        default_profile: None,
        active_profile: None,
        effective_profile: None,
        diagnostics: vec![],
        revision: 1,
    };
    app.configuration_loaded(snapshot.clone());
    app.editor.stage = Stage::Roles;
    app.handle(key(KeyCode::Char('d')));
    app.editor.stage = Stage::Review;
    assert!(matches!(
        app.handle(key(KeyCode::F(5))).as_slice(),
        [Effect::LoadConfig]
    ));
    assert!(app.busy);
    assert!(app.handle(key(KeyCode::Char('v'))).is_empty());
    snapshot.revision = 2;
    apply_event(&mut app, Event::Configuration(Ok(snapshot)));
    assert!(!app.busy);
    assert!(
        matches!(app.handle(key(KeyCode::Char('v'))).as_slice(), [Effect::Preview { snapshot, .. }] if snapshot.revision == 2)
    );
    let mut preview = ConfigurationPreview {
        revision: 1,
        changes: app.editor.changes.clone(),
        scope: Scope::Project,
        path: "/synthetic/project/.xper/config.yaml".into(),
        source: "{}\n".into(),
        authoring: value.clone(),
        effective: value,
        changed: true,
        diagnostics: vec![],
    };
    apply_event(&mut app, Event::Preview(Ok(preview.clone())));
    assert!(app.editor.preview.is_none());
    assert!(app.handle(key(KeyCode::Enter)).is_empty());
    preview.revision = 2;
    let reviewed_changes = preview.changes.clone();
    preview.changes.clear();
    apply_event(&mut app, Event::Preview(Ok(preview.clone())));
    assert!(app.editor.preview.is_none());
    preview.changes = reviewed_changes;
    apply_event(&mut app, Event::Preview(Ok(preview)));
    assert!(
        matches!(app.handle(key(KeyCode::Enter)).as_slice(), [Effect::Save { snapshot, .. }] if snapshot.revision == 2)
    );
}

#[test]
fn home_reload_blocks_configuration_actions_until_success_or_failure() {
    let mut app = configured();
    app.section = Section::Home;
    assert!(matches!(
        app.handle(key(KeyCode::Char('r'))).first(),
        Some(Effect::LoadConfig)
    ));
    assert!(app.busy);
    assert!(app.handle(key(KeyCode::Char('2'))).is_empty());
    assert_eq!(app.section, Section::Home);
    apply_event(&mut app, Event::Configuration(Err("read failed".into())));
    assert!(!app.busy);
    app.handle(key(KeyCode::Char('2')));
    assert_eq!(app.section, Section::Configuration);
}

#[test]
fn choosing_a_model_repairs_malformed_role_containers_and_preserves_other_settings() {
    let mut app = configured();
    app.editor.draft["profiles"]["work"]["roles"] = json!("broken");
    app.editor.draft["profiles"]["work"]["custom"] = json!({"keep":true});
    app.editor.stage = Stage::Roles;
    app.editor.cursor = 0;
    app.handle(key(KeyCode::Enter));
    app.catalog_loading = false;
    app.handle(key(KeyCode::Enter));
    assert_eq!(app.route("one").unwrap()["model"], "precise:model/1");
    assert_eq!(app.editor.draft["profiles"]["work"]["custom"]["keep"], true);
    assert!(app.editor.changes.iter().any(|change|matches!(change,xper_application::configuration::ConfigurationChange::Set{path,..}if path==&vec!["profiles","work","roles"])));
}

#[test]
fn rebinding_a_profile_updates_explicit_route_contexts_and_preserves_inheritance() {
    let mut app = configured();
    app.editor.draft["contexts"]["personal"] = json!({"allowed_providers":["allowed"]});
    app.editor.draft["profiles"]["work"]["roles"]["one"]["context"] = json!("company");
    app.editor.draft["profiles"]["work"]["roles"]["two"] =
        json!({"provider":"allowed","model":"m2","thinking":"off"});
    app.editor.draft["profiles"]["work"]["roles"]["custom.role"] = json!({"context":"company","provider":"allowed","model":"custom","thinking":"off","metadata":{"keep":true}});
    let source = serde_json::to_string(&app.editor.draft).unwrap();
    app.editor.context = "personal".into();
    app.editor.stage = Stage::Roles;
    app.handle(key(KeyCode::Char('c')));
    let edited = xper_config::authoring::edit_source(&source, &app.editor.changes).unwrap();
    let authored = xper_config::parse(&edited).unwrap();
    xper_config::authoring::validate_profiles(&authored).unwrap();
    let roles = &authored["profiles"]["work"]["roles"];
    assert_eq!(authored["profiles"]["work"]["context"], "personal");
    assert_eq!(roles["one"]["context"], "personal");
    assert_eq!(roles["custom.role"]["context"], "personal");
    assert_eq!(roles["custom.role"]["metadata"]["keep"], true);
    assert!(roles["two"].get("context").is_none());
    assert_eq!(roles["two"]["model"], "m2");
}

#[test]
fn first_frame_and_all_screens_render_at_supported_sizes_without_changing_draft() {
    for (width, height) in [(140, 40), (80, 24), (60, 24), (48, 12), (40, 10)] {
        for section in [
            Section::Home,
            Section::Configuration,
            Section::Status,
            Section::Metrics,
        ] {
            let mut app = configured();
            app.section = section;
            let before = app.editor.draft.clone();
            for stage in [
                Stage::Scope,
                Stage::Contexts,
                Stage::Providers,
                Stage::Profiles,
                Stage::Roles,
                Stage::Picker,
                Stage::Review,
            ] {
                app.editor.stage = stage;
                let mut terminal = Terminal::new(TestBackend::new(width, height)).unwrap();
                terminal
                    .draw(|f| {
                        view::draw(
                            f,
                            &app,
                            Theme {
                                color: false,
                                ascii: true,
                            },
                        )
                    })
                    .unwrap();
                let buffer = terminal.backend().buffer();
                let rendered = buffer
                    .content
                    .iter()
                    .map(|c| c.symbol())
                    .collect::<String>();
                assert!(rendered.contains(if width < 48 {
                    "Terminal too small"
                } else {
                    "xper"
                }));
                assert!(!rendered.contains('\u{1b}'));
                assert_eq!(app.editor.draft, before);
            }
        }
    }
}
