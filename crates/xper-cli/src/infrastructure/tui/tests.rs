use super::{
    apply_event,
    catalog::{Model, Role},
    model::{Action, App, Effect, NameKind, Section, Stage},
    view::{self, Theme},
    worker::Event,
};
use crossterm::event::{KeyCode, KeyEvent, KeyModifiers};
use ratatui::{Terminal, backend::TestBackend};
use serde_json::{Value, json};
use std::collections::BTreeMap;
use xper_application::configuration::{
    ConfigurationChange, ConfigurationDocument, ConfigurationPreview, ConfigurationScope as Scope,
    ConfigurationSnapshot,
};

fn key(code: KeyCode) -> KeyEvent {
    KeyEvent::new(code, KeyModifiers::NONE)
}
fn snapshot(value: Value, origin: Scope) -> ConfigurationSnapshot {
    let scopes = [Scope::Global, Scope::Project, Scope::Local];
    ConfigurationSnapshot {
        documents: scopes
            .iter()
            .map(|scope| ConfigurationDocument {
                scope: *scope,
                path: format!("/synthetic/{scope:?}.yaml"),
                source: (*scope == origin).then(|| value.to_string()),
                value: (*scope == origin).then(|| value.clone()),
                error: None,
            })
            .collect(),
        scoped: scopes
            .iter()
            .map(|scope| {
                (
                    *scope,
                    if *scope >= origin {
                        value.clone()
                    } else {
                        json!({})
                    },
                )
            })
            .collect(),
        effective: Some(value),
        origins: BTreeMap::new(),
        default_profile: None,
        active_profile: None,
        effective_profile: None,
        diagnostics: vec![],
        revision: 1,
    }
}

fn configured() -> App {
    let mut app = App::new("/synthetic/project".into());
    app.section = Section::Profiles;
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
    app.configuration_loaded(snapshot(app.editor.draft.clone(), Scope::Project));
    app
}

#[test]
fn pending_provider_choices_and_new_context_names_are_protected_before_enter() {
    for new_context in [false, true] {
        let mut app = configured();
        app.handle(key(KeyCode::Char('5')));
        app.handle(key(KeyCode::Char(if new_context { 'n' } else { 'e' })));
        app.handle(key(KeyCode::Enter));
        if new_context {
            for letter in "personal".chars() {
                app.handle(key(KeyCode::Char(letter)));
            }
            app.handle(key(KeyCode::Enter));
            assert!(app.dirty(), "The new context name is already a draft");
        } else {
            assert!(!app.dirty(), "Opening an existing context is read-only");
        }
        assert_eq!(app.editor.stage, Stage::Providers);
        app.handle(key(KeyCode::Char(' ')));
        assert!(app.editor.changes.is_empty());
        assert!(app.dirty());
        let allowed = app.editor.allowed.clone();

        assert!(app.handle(key(KeyCode::Char('2'))).is_empty());
        assert_eq!(app.section, Section::Settings);
        assert_eq!(app.editor.allowed, allowed);
        app.handle(key(KeyCode::Char('q')));
        assert!(!app.quit);
        assert!(app.confirm_discard);
        app.handle(key(KeyCode::Esc));
        assert_eq!(app.editor.allowed, allowed);
        app.handle(key(KeyCode::Esc));
        assert!(app.confirm_discard);
        app.handle(key(KeyCode::Enter));
        assert!(!app.dirty());
        assert_eq!(app.editor.stage, Stage::ContextList);
    }
}

#[test]
fn first_context_continues_to_profile_naming_and_cancel_can_resume_with_enter() {
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

    assert_eq!(app.editor.stage, Stage::Contexts);
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
fn existing_context_creates_a_new_profile_without_replacing_existing_profiles() {
    let mut app = configured();
    let existing = app.editor.draft["profiles"]["work"].clone();
    app.handle(key(KeyCode::Char('n')));
    assert_eq!(app.editor.stage, Stage::Scope);
    app.handle(key(KeyCode::Enter));
    assert_eq!(app.editor.stage, Stage::Contexts);
    app.handle(key(KeyCode::Enter));
    assert_eq!(app.editor.naming, Some(NameKind::Profile));
    for letter in "new".chars() {
        app.handle(key(KeyCode::Char(letter)));
    }
    app.handle(key(KeyCode::Enter));
    assert_eq!(app.editor.stage, Stage::Roles);
    assert!(app.editor.new_profile);
    assert_eq!(app.editor.draft["profiles"]["work"], existing);
    assert_eq!(app.editor.draft["profiles"]["new"]["context"], "company");
}

#[test]
fn activating_an_inventory_profile_reviews_a_yaml_selection_in_the_chosen_scope() {
    for (cursor, scope) in [Scope::Global, Scope::Project, Scope::Local]
        .into_iter()
        .enumerate()
    {
        let mut app = configured();
        app.configuration_loaded(snapshot(app.editor.draft.clone(), Scope::Global));
        assert_eq!(app.profiles().len(), 1);
        assert!(app.handle(key(KeyCode::Enter)).is_empty());
        assert_eq!(app.editor.stage, Stage::Actions);
        assert_eq!(app.actions()[app.editor.cursor], Action::ActivateProfile);
        assert!(app.handle(key(KeyCode::Enter)).is_empty());
        assert_eq!(app.editor.stage, Stage::Scope);
        app.editor.cursor = cursor;
        let effects = app.handle(key(KeyCode::Enter));
        assert_eq!(app.editor.stage, Stage::Review);
        let [
            Effect::Preview {
                scope: selected,
                changes,
                ..
            },
        ] = effects.as_slice()
        else {
            panic!("Scoped activation must only request a preview");
        };
        assert_eq!(*selected, scope);
        assert_eq!(
            changes,
            &[ConfigurationChange::Set {
                path: vec!["profile".into()],
                value: json!("work"),
            }]
        );
        assert_eq!(app.editor.draft["profile"], "work");
        assert!(app.snapshot.as_ref().unwrap().active_profile.is_none());
        assert!(app.handle(key(KeyCode::Enter)).is_empty());
        apply_event(
            &mut app,
            Event::Preview(Err("synthetic preview failure".into())),
        );
        app.handle(key(KeyCode::Esc));
        assert_eq!(app.editor.stage, Stage::Scope);
        assert_eq!(app.editor.cursor, cursor);
        assert!(!app.dirty());
        assert!(
            matches!(app.handle(key(KeyCode::Enter)).as_slice(), [Effect::Preview { scope: retry, .. }] if *retry == scope)
        );
    }
}

#[test]
fn profile_origin_active_state_and_actions_are_visible_in_compact_terminals() {
    for width in [60, 80] {
        let mut app = configured();
        app.snapshot.as_mut().unwrap().effective_profile = Some("work".into());
        let mut terminal = Terminal::new(TestBackend::new(width, 24)).unwrap();
        let mut rendered = |app: &App| {
            terminal
                .draw(|f| {
                    view::draw(
                        f,
                        app,
                        Theme {
                            color: false,
                            ascii: true,
                        },
                    )
                })
                .unwrap();
            let buffer = terminal.backend().buffer();
            (0..24)
                .map(|y| {
                    (0..width)
                        .map(|x| buffer[(x, y)].symbol())
                        .collect::<String>()
                })
                .collect::<Vec<_>>()
                .join("\n")
        };
        let text = rendered(&app);
        assert!(text.contains("work  [Project]  ACTIVE"));
        assert!(text.contains("Enter: actions"));
        app.handle(key(KeyCode::Enter));
        let text = rendered(&app);
        for action in [
            "Profile actions: work",
            "Activate profile",
            "Edit profile",
            "Delete profile",
            "Remove scoped activation",
        ] {
            assert!(text.contains(action), "{action} missing at {width} columns");
        }
    }
}

#[test]
fn settings_context_creation_reviews_only_context_changes_and_keeps_profiles_separate() {
    let mut app = configured();
    let original_profiles = app.editor.draft["profiles"].clone();
    app.handle(key(KeyCode::Char('5')));
    assert_eq!(app.section, Section::Settings);
    assert_eq!(app.editor.stage, Stage::ContextList);
    assert_eq!(app.contexts()[0].name, "company");
    app.handle(key(KeyCode::Char('n')));
    assert_eq!(app.editor.action, Action::NewContext);
    assert_eq!(app.editor.stage, Stage::Scope);
    app.handle(key(KeyCode::Enter));
    assert_eq!(app.editor.naming, Some(NameKind::Context));
    for letter in "personal".chars() {
        app.handle(key(KeyCode::Char(letter)));
    }
    app.handle(key(KeyCode::Enter));
    app.handle(key(KeyCode::Char(' ')));
    let effects = app.handle(key(KeyCode::Enter));
    assert_eq!(app.editor.stage, Stage::Review);
    assert!(app.editor.naming.is_none());
    assert_eq!(app.editor.draft["profiles"], original_profiles);
    assert!(
        matches!(effects.as_slice(), [Effect::Preview { changes, .. }]
        if changes == &[ConfigurationChange::Set {
            path: vec!["contexts".into(), "personal".into(), "allowed_providers".into()],
            value: json!(["allowed"]),
        }])
    );
    // Leaving a review never transfers its pending context edits into Profiles.
    apply_event(
        &mut app,
        Event::Preview(Err("synthetic validation error".into())),
    );
    assert!(app.handle(key(KeyCode::Char('2'))).is_empty());
    assert_eq!(app.section, Section::Settings);
    assert!(app.dirty());
}

#[test]
fn deleting_a_referenced_definition_requires_a_successful_preview_before_saving() {
    use crate::infrastructure::configuration::LocalConfiguration;
    use xper_application::use_cases::preview_configuration;

    for section in [Section::Profiles, Section::Settings] {
        let mut app = configured();
        if section == Section::Profiles {
            let snapshot = app.snapshot.as_mut().unwrap();
            snapshot.active_profile = Some("work".into());
            snapshot.effective_profile = Some("work".into());
        } else {
            app.handle(key(KeyCode::Char('5')));
        }
        assert!(app.handle(key(KeyCode::Delete)).is_empty());
        assert_eq!(app.editor.stage, Stage::Scope);
        let effects = app.handle(key(KeyCode::Enter));
        assert_eq!(app.editor.stage, Stage::Review);
        let [
            Effect::Preview {
                snapshot,
                scope,
                changes,
            },
        ] = effects.as_slice()
        else {
            panic!("Deletion must be reviewed before writing");
        };
        assert!(
            changes
                .iter()
                .all(|change| matches!(change, ConfigurationChange::Remove { .. }))
        );
        let repository =
            LocalConfiguration::new("/synthetic/project".into(), "/synthetic/home".into(), None);
        let failure = preview_configuration::execute(&repository, snapshot, *scope, changes)
            .unwrap_err()
            .to_string();
        apply_event(&mut app, Event::Preview(Err(failure)));
        assert!(app.editor.preview.is_none());
        assert!(app.handle(key(KeyCode::Enter)).is_empty());
        assert!(app.dirty());
        app.handle(key(KeyCode::Esc));
        assert_eq!(app.editor.stage, Stage::Scope);
        assert!(!app.dirty());
    }
}

#[test]
fn clearing_legacy_activation_requires_its_own_confirmation() {
    let mut app = configured();
    app.snapshot.as_mut().unwrap().active_profile = Some("work".into());
    assert!(app.handle(key(KeyCode::Char('u'))).is_empty());
    assert_eq!(app.editor.stage, Stage::LegacyOverride);
    assert!(app.handle(key(KeyCode::Esc)).is_empty());
    assert_eq!(app.editor.stage, Stage::Profiles);
    assert_eq!(
        app.snapshot.as_ref().unwrap().active_profile.as_deref(),
        Some("work")
    );
    app.handle(key(KeyCode::Char('u')));
    assert!(matches!(
        app.handle(key(KeyCode::Enter)).as_slice(),
        [Effect::Activate(None)]
    ));
    assert!(!app.dirty());
}

#[test]
fn opening_sections_does_not_initialize_configuration_or_emit_mutations() {
    let mut app = App::new("/synthetic/unconfigured".into());
    let mut empty = snapshot(json!({}), Scope::Project);
    for document in &mut empty.documents {
        document.source = None;
        document.value = None;
    }
    app.configuration_loaded(empty);
    for code in [
        KeyCode::Enter,
        KeyCode::Char('5'),
        KeyCode::Char('2'),
        KeyCode::Char('3'),
        KeyCode::Char('4'),
        KeyCode::Char('1'),
    ] {
        let effects = app.handle(key(code));
        assert!(effects.iter().all(|effect| matches!(
            effect,
            Effect::OpenCatalog | Effect::CloseCatalog | Effect::History { .. }
        )));
        assert!(!app.dirty());
        assert!(app.profiles().is_empty());
        assert!(app.contexts().is_empty());
        assert!(app.editor.preview.is_none());
        assert!(
            app.snapshot
                .as_ref()
                .unwrap()
                .documents
                .iter()
                .all(|document| document.source.is_none())
        );
    }
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
    app.editor.draft["profile"] = json!(app.editor.profile);
    app.editor.changes.push(ConfigurationChange::Set {
        path: vec!["profile".into()],
        value: json!(app.editor.profile),
    });
    app.handle(key(KeyCode::Char('q')));
    assert!(app.confirm_discard);
    assert!(!app.quit);
    app.handle(key(KeyCode::Esc));
    assert!(!app.confirm_discard);
    assert!(app.dirty());
}

#[test]
fn selected_scope_uses_its_own_values_and_configuration_reload_retains_a_draft() {
    let mut app = App::new("/synthetic/project".into());
    app.section = Section::Profiles;
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
    app.editor.stage = Stage::Scope;
    app.editor.cursor = 0;
    app.handle(key(KeyCode::Enter));
    assert_eq!(app.names("contexts"), vec!["global"]);
    app.editor.stage = Stage::Roles;
    app.editor.profile = "draft".into();
    app.editor.draft["profile"] = json!(app.editor.profile);
    app.editor.changes.push(ConfigurationChange::Set {
        path: vec!["profile".into()],
        value: json!(app.editor.profile),
    });
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
    app.editor.draft["profile"] = json!(app.editor.profile);
    app.editor.changes.push(ConfigurationChange::Set {
        path: vec!["profile".into()],
        value: json!(app.editor.profile),
    });
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
    assert_eq!(app.section, Section::Profiles);
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
    app.editor.action = Action::EditProfile;
    app.editor.stage = Stage::Roles;
    app.handle(key(KeyCode::Char('c')));
    assert_eq!(app.editor.stage, Stage::Contexts);
    assert!(!app.dirty());
    app.editor.cursor = app
        .names("contexts")
        .iter()
        .position(|name| name == "personal")
        .unwrap();
    app.handle(key(KeyCode::Enter));
    assert_eq!(app.editor.stage, Stage::Roles);
    assert!(app.editor.naming.is_none());
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
            Section::Profiles,
            Section::Status,
            Section::Metrics,
            Section::Settings,
        ] {
            let mut app = configured();
            app.section = section;
            if section.authoring() {
                app.editor.section = section;
            }
            let before = app.editor.draft.clone();
            for stage in [
                Stage::Scope,
                Stage::Actions,
                Stage::ContextList,
                Stage::LegacyOverride,
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
