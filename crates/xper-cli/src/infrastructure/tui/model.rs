//! Terminal-independent navigation and configuration draft state.

use crossterm::event::{KeyCode, KeyEvent, KeyModifiers};
use serde_json::{Value, json};
use xper_application::{
    configuration::{
        ConfigurationChange, ConfigurationPreview, ConfigurationScope as Scope,
        ConfigurationSnapshot,
    },
    read_models::RunProjection,
    use_cases::get_run_status,
};

use super::{
    catalog::{Model, Role},
    inventory,
};

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(super) enum Section {
    Home,
    Profiles,
    Status,
    Metrics,
    Settings,
}

impl Section {
    pub const ALL: [Self; 5] = [
        Self::Home,
        Self::Profiles,
        Self::Status,
        Self::Metrics,
        Self::Settings,
    ];
    pub fn authoring(self) -> bool {
        matches!(self, Self::Profiles | Self::Settings)
    }
    pub fn label(self) -> &'static str {
        match self {
            Self::Home => "Home",
            Self::Profiles => "Profiles",
            Self::Status => "Status",
            Self::Metrics => "Metrics",
            Self::Settings => "Settings",
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(super) enum Stage {
    ContextList,
    Actions,
    LegacyOverride,
    Scope,
    Contexts,
    Providers,
    Profiles,
    Roles,
    Picker,
    Review,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(super) enum Action {
    NewProfile,
    EditProfile,
    DeleteProfile,
    ActivateProfile,
    ClearSelection,
    NewContext,
    EditContext,
    DeleteContext,
}
impl Action {
    pub fn label(self) -> &'static str {
        match self {
            Self::NewProfile => "Create profile",
            Self::EditProfile => "Edit profile",
            Self::DeleteProfile => "Delete profile",
            Self::ActivateProfile => "Activate profile",
            Self::ClearSelection => "Remove scoped activation",
            Self::NewContext => "Create context",
            Self::EditContext => "Edit context",
            Self::DeleteContext => "Delete context",
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(super) enum NameKind {
    Context,
    Profile,
}

pub(super) enum Effect {
    OpenCatalog,
    CloseCatalog,
    RefreshCatalog,
    LoadConfig,
    Search {
        sequence: u64,
        query: String,
        provider: Option<String>,
    },
    History {
        after: Option<String>,
        selected: Option<String>,
    },
    Detail(String),
    Preview {
        snapshot: Box<ConfigurationSnapshot>,
        scope: Scope,
        changes: Vec<ConfigurationChange>,
    },
    Save {
        snapshot: Box<ConfigurationSnapshot>,
        scope: Scope,
        changes: Vec<ConfigurationChange>,
    },
    Activate(Option<String>),
}

pub(super) struct Editor {
    pub section: Section,
    pub action: Action,
    pub stage: Stage,
    pub scope: Scope,
    pub draft: Value,
    pub changes: Vec<ConfigurationChange>,
    pub context: String,
    pub profile: String,
    pub allowed: Vec<String>,
    pub new_profile: bool,
    pub cursor: usize,
    pub role_cursor: usize,
    pub query: String,
    pub provider: Option<String>,
    pub apply_all: bool,
    pub naming: Option<NameKind>,
    pub name: String,
    pub preview: Option<ConfigurationPreview>,
    pub preview_scroll: u16,
    pub review_return: Stage,
}

impl Default for Editor {
    fn default() -> Self {
        Self {
            section: Section::Profiles,
            action: Action::NewProfile,
            stage: Stage::Profiles,
            scope: Scope::Project,
            draft: json!({}),
            changes: vec![],
            context: String::new(),
            profile: String::new(),
            allowed: vec![],
            new_profile: false,
            cursor: 0,
            role_cursor: 0,
            query: String::new(),
            provider: None,
            apply_all: false,
            naming: None,
            name: String::new(),
            preview: None,
            preview_scroll: 0,
            review_return: Stage::Roles,
        }
    }
}

pub(super) struct App {
    pub root: String,
    pub section: Section,
    pub snapshot: Option<ConfigurationSnapshot>,
    pub editor: Editor,
    pub roles: Vec<Role>,
    pub models: Vec<Model>,
    pub matches: Vec<Model>,
    pub catalog_error: Option<String>,
    pub catalog_loading: bool,
    pub search_sequence: u64,
    pub search_pending: bool,
    pub runs: Vec<RunProjection>,
    /// A retained selected run outside the contiguous history page window.
    pub pinned_run: Option<String>,
    pub next_cursor: Option<String>,
    pub run_cursor: usize,
    pub detail: get_run_status::Outcome,
    pub detail_open: bool,
    pub timeline_cursor: usize,
    pub notice: String,
    pub busy: bool,
    pub history_loading: bool,
    pub help: bool,
    pub confirm_discard: bool,
    pub confirm_repair: bool,
    pub discard_quits: bool,
    pub quit: bool,
}

pub(super) const SCOPES: [Scope; 3] = [Scope::Global, Scope::Project, Scope::Local];
/// Fixed logical metric rows, excluding the run header and reported outcomes.
pub(super) const METRIC_FIXED_ROWS: usize = 12;
pub(super) fn scope_label(scope: Scope) -> &'static str {
    match scope {
        Scope::Global => "Global",
        Scope::Project => "Project",
        Scope::Local => "Local (private)",
    }
}

impl App {
    pub fn new(root: String) -> Self {
        Self {
            root,
            section: Section::Home,
            snapshot: None,
            editor: Editor::default(),
            roles: vec![],
            models: vec![],
            matches: vec![],
            catalog_error: None,
            catalog_loading: false,
            search_sequence: 0,
            search_pending: false,
            runs: vec![],
            pinned_run: None,
            next_cursor: None,
            run_cursor: 0,
            detail: Default::default(),
            detail_open: false,
            timeline_cursor: 0,
            notice: "Loading project...".into(),
            busy: false,
            history_loading: false,
            help: false,
            confirm_discard: false,
            confirm_repair: false,
            discard_quits: false,
            quit: false,
        }
    }
    pub fn dirty(&self) -> bool {
        !self.editor.changes.is_empty()
            || (self.editor.stage == Stage::Providers
                && self.editor.naming.is_none()
                && self
                    .editor
                    .draft
                    .get("contexts")
                    .and_then(|contexts| contexts.get(&self.editor.context))
                    .and_then(|context| context.get("allowed_providers"))
                    != Some(&json!(self.editor.allowed)))
    }
    pub fn selected_run(&self) -> Option<String> {
        self.runs.get(self.run_cursor).map(|r| r.run_id.clone())
    }
    pub fn names(&self, section: &str) -> Vec<String> {
        self.editor
            .draft
            .get(section)
            .and_then(Value::as_object)
            .map(|m| m.keys().cloned().collect())
            .unwrap_or_default()
    }
    pub fn providers(&self) -> Vec<String> {
        let mut values: Vec<String> = self
            .models
            .iter()
            .map(|m| m.provider.clone())
            .chain(self.editor.allowed.iter().cloned())
            .chain(
                self.editor
                    .draft
                    .get("contexts")
                    .and_then(|c| c.get(&self.editor.context))
                    .and_then(|c| c.get("allowed_providers"))
                    .and_then(Value::as_array)
                    .into_iter()
                    .flatten()
                    .filter_map(Value::as_str)
                    .map(str::to_owned),
            )
            .collect();
        values.sort();
        values.dedup();
        values
    }
    pub fn role_ids(&self) -> Vec<String> {
        let mut ids: Vec<String> = self.roles.iter().map(|r| r.id.clone()).collect();
        if let Some(routes) = self
            .editor
            .draft
            .get("profiles")
            .and_then(|v| v.get(&self.editor.profile))
            .and_then(|v| v.get("roles"))
            .and_then(Value::as_object)
        {
            for id in routes.keys() {
                if !ids.contains(id) {
                    ids.push(id.clone());
                }
            }
        }
        ids
    }
    pub fn route(&self, id: &str) -> Option<&Value> {
        self.editor
            .draft
            .get("profiles")?
            .get(&self.editor.profile)?
            .get("roles")?
            .get(id)
    }
    pub fn configuration_loaded(&mut self, snapshot: ConfigurationSnapshot) {
        if !self.dirty() {
            self.editor.draft = snapshot
                .scoped
                .get(&self.editor.scope)
                .cloned()
                .unwrap_or_else(|| json!({}));
        }
        self.snapshot = Some(snapshot);
    }
    pub fn reset_editor(&mut self) {
        let section = self.editor.section;
        self.editor = Editor {
            section,
            ..Editor::default()
        };
        self.editor.stage = if section == Section::Settings {
            Stage::ContextList
        } else {
            Stage::Profiles
        };
        if let Some(snapshot) = &self.snapshot {
            self.editor.draft = snapshot
                .scoped
                .get(&self.editor.scope)
                .cloned()
                .unwrap_or_else(|| json!({}));
        }
    }
    fn set(&mut self, path: Vec<String>, value: Value) {
        set_value(&mut self.editor.draft, &path, value.clone());
        self.editor
            .changes
            .push(ConfigurationChange::Set { path, value });
        self.editor.preview = None;
    }
    fn role_path(&self, id: &str, field: &str) -> Vec<String> {
        vec![
            "profiles".into(),
            self.editor.profile.clone(),
            "roles".into(),
            id.into(),
            field.into(),
        ]
    }
    pub fn profiles(&self) -> Vec<inventory::Profile> {
        self.snapshot
            .as_ref()
            .map(inventory::profiles)
            .unwrap_or_default()
    }
    pub fn contexts(&self) -> Vec<inventory::Context> {
        self.snapshot
            .as_ref()
            .map(inventory::contexts)
            .unwrap_or_default()
    }
    pub fn actions(&self) -> Vec<Action> {
        if self.editor.section == Section::Settings {
            vec![Action::EditContext, Action::DeleteContext]
        } else {
            vec![
                Action::ActivateProfile,
                Action::EditProfile,
                Action::DeleteProfile,
                Action::ClearSelection,
            ]
        }
    }
    fn start_action(&mut self, action: Action, scope: Scope) {
        self.editor.action = action;
        self.editor.stage = Stage::Scope;
        self.editor.cursor = SCOPES.iter().position(|s| *s == scope).unwrap_or(1);
        self.editor.preview = None;
        self.editor.changes.clear();
        self.editor.new_profile = action == Action::NewProfile;
        if action == Action::NewProfile {
            self.editor.profile.clear();
        }
        if action == Action::NewContext {
            self.editor.context.clear();
        }
    }
    fn review(&mut self, back: Stage) -> Vec<Effect> {
        self.editor.review_return = back;
        self.editor.stage = Stage::Review;
        self.editor.preview_scroll = 0;
        self.preview_effect(true)
    }
    fn choose_context(&mut self, name: String) {
        self.editor.context = name;
        self.editor.allowed =
            self.editor.draft["contexts"][&self.editor.context]["allowed_providers"]
                .as_array()
                .map(|a| {
                    a.iter()
                        .filter_map(Value::as_str)
                        .map(str::to_owned)
                        .collect()
                })
                .unwrap_or_default();
    }
    fn bind_context(&mut self) {
        self.set(
            vec![
                "profiles".into(),
                self.editor.profile.clone(),
                "context".into(),
            ],
            json!(self.editor.context),
        );
        for id in self.role_ids() {
            if self
                .route(&id)
                .and_then(|route| route.get("context"))
                .is_some_and(|context| context.as_str() != Some(self.editor.context.as_str()))
            {
                self.set(self.role_path(&id, "context"), json!(self.editor.context));
            }
        }
        self.notice = "Profile context updated in draft".into();
    }
    fn after_scope(&mut self) -> Vec<Effect> {
        self.editor.cursor = 0;
        match self.editor.action {
            Action::NewProfile => self.editor.stage = Stage::Contexts,
            Action::NewContext => {
                self.editor.stage = Stage::Providers;
                self.editor.naming = Some(NameKind::Context);
                self.editor.name.clear();
            }
            Action::EditProfile => {
                if let Some(context) =
                    self.editor.draft["profiles"][&self.editor.profile]["context"].as_str()
                {
                    self.editor.context = context.to_owned();
                    self.editor.stage = Stage::Roles;
                } else {
                    if self.names("profiles").contains(&self.editor.profile) {
                        self.editor.stage = Stage::Contexts;
                        self.notice = "Choose a valid context to repair this profile.".into();
                    } else {
                        self.notice = "This profile is not available in this scope. Choose its origin or a higher scope.".into();
                        self.editor.cursor = SCOPES
                            .iter()
                            .position(|s| *s == self.editor.scope)
                            .unwrap_or(1);
                    }
                }
            }
            Action::EditContext => {
                if self.names("contexts").contains(&self.editor.context) {
                    self.choose_context(self.editor.context.clone());
                    self.editor.stage = Stage::Providers;
                } else {
                    self.notice = "This context is not available in this scope. Choose its origin or a higher scope.".into();
                    self.editor.cursor = SCOPES
                        .iter()
                        .position(|s| *s == self.editor.scope)
                        .unwrap_or(1);
                }
            }
            Action::ActivateProfile => {
                self.set(vec!["profile".into()], json!(self.editor.profile));
                return self.review(Stage::Scope);
            }
            Action::ClearSelection | Action::DeleteProfile | Action::DeleteContext => {
                let (section, name) = if self.editor.action == Action::DeleteContext {
                    ("contexts", self.editor.context.clone())
                } else {
                    ("profiles", self.editor.profile.clone())
                };
                let document = self
                    .snapshot
                    .as_ref()
                    .and_then(|s| s.documents.iter().find(|d| d.scope == self.editor.scope))
                    .and_then(|d| d.value.as_ref());
                let exists = if self.editor.action == Action::ClearSelection {
                    document
                        .and_then(|d| d.get("profile"))
                        .and_then(Value::as_str)
                        == Some(name.as_str())
                } else {
                    document
                        .and_then(|d| d.get(section))
                        .and_then(|v| v.get(&name))
                        .is_some()
                };
                if !exists {
                    self.notice = "There is no matching definition or activation in this scope. Choose a listed source scope.".into();
                    self.editor.cursor = SCOPES
                        .iter()
                        .position(|s| *s == self.editor.scope)
                        .unwrap_or(1);
                    return vec![];
                }
                if self.editor.action == Action::ClearSelection
                    || (section == "profiles"
                        && document
                            .and_then(|d| d.get("profile"))
                            .and_then(Value::as_str)
                            == Some(name.as_str()))
                {
                    self.editor.changes.push(ConfigurationChange::Remove {
                        path: vec!["profile".into()],
                    });
                }
                if self.editor.action != Action::ClearSelection {
                    self.editor.changes.push(ConfigurationChange::Remove {
                        path: vec![section.into(), name],
                    });
                }
                return self.review(Stage::Scope);
            }
        }
        vec![]
    }
    fn assign(&mut self, id: &str, model: &Model) {
        let profile = self.editor.profile.clone();
        if !self
            .editor
            .draft
            .get("profiles")
            .and_then(|p| p.get(&profile))
            .is_some_and(Value::is_object)
        {
            self.set(
                vec!["profiles".into(), profile.clone()],
                json!({"context":self.editor.context,"roles":{}}),
            );
        }
        if !self.editor.draft["profiles"][&profile]
            .get("roles")
            .is_some_and(Value::is_object)
        {
            self.set(
                vec!["profiles".into(), profile.clone(), "roles".into()],
                json!({}),
            );
        }
        if self.route(id).is_some_and(|route| !route.is_object()) {
            self.set(
                vec!["profiles".into(), profile, "roles".into(), id.into()],
                json!({}),
            );
        }
        let thinking = self
            .route(id)
            .and_then(|r| r.get("thinking"))
            .and_then(Value::as_str)
            .unwrap_or("off")
            .to_owned();
        for (field, value) in [
            ("provider", model.provider.as_str()),
            ("model", model.model.as_str()),
            ("thinking", if model.reasoning { &thinking } else { "off" }),
        ] {
            if self.route(id).and_then(|r| r.get(field)) != Some(&json!(value)) {
                self.set(self.role_path(id, field), json!(value));
            }
        }
    }
    pub fn search_effect(&mut self) -> Effect {
        self.search_sequence += 1;
        self.catalog_loading = true;
        self.search_pending = false;
        Effect::Search {
            sequence: self.search_sequence,
            query: self.editor.query.clone(),
            provider: self.editor.provider.clone(),
        }
    }
    fn select_section(&mut self, section: Section) -> Vec<Effect> {
        if section == self.section {
            return vec![];
        }
        if section.authoring() && section != self.editor.section {
            if self.dirty() {
                self.notice = format!(
                    "Finish or discard the draft in {} before opening {}.",
                    self.editor.section.label(),
                    section.label()
                );
                return vec![];
            }
            self.editor.section = section;
            self.reset_editor();
        }
        let old = self.section;
        self.section = section;
        self.detail_open = false;
        self.timeline_cursor = 0;
        let mut effects = vec![];
        if old.authoring() && !section.authoring() {
            effects.push(Effect::CloseCatalog);
            self.catalog_loading = false;
        }
        if section.authoring() && !old.authoring() {
            self.catalog_loading = true;
            effects.push(Effect::OpenCatalog);
        }
        if matches!(section, Section::Status | Section::Metrics) {
            self.history_loading = true;
            effects.push(Effect::History {
                after: None,
                selected: self.selected_run(),
            });
        }
        effects
    }
    pub fn handle(&mut self, key: KeyEvent) -> Vec<Effect> {
        if key.code == KeyCode::Char('c') && key.modifiers.contains(KeyModifiers::CONTROL) {
            self.quit = true;
            return vec![Effect::CloseCatalog];
        }
        if self.confirm_repair {
            match key.code {
                KeyCode::Char('y') | KeyCode::Enter => {
                    self.confirm_repair = false;
                    self.editor.changes.push(ConfigurationChange::Set {
                        path: vec![],
                        value: json!({}),
                    });
                    self.editor.draft = json!({});
                    self.editor.action = if self.editor.section == Section::Settings {
                        Action::NewContext
                    } else {
                        Action::NewProfile
                    };
                    self.editor.new_profile = self.editor.section == Section::Profiles;
                    self.editor.profile.clear();
                    return self.after_scope();
                }
                KeyCode::Esc | KeyCode::Char('n') => self.confirm_repair = false,
                _ => {}
            }
            return vec![];
        }
        if self.confirm_discard {
            match key.code {
                KeyCode::Char('y') | KeyCode::Enter => {
                    self.confirm_discard = false;
                    self.reset_editor();
                    self.quit = self.discard_quits;
                }
                KeyCode::Esc | KeyCode::Char('n') => self.confirm_discard = false,
                _ => {}
            }
            return vec![];
        }
        if self.help {
            if matches!(key.code, KeyCode::Esc | KeyCode::Char('?') | KeyCode::Enter) {
                self.help = false;
            }
            return vec![];
        }
        if self.section.authoring() && self.editor.naming.is_some() {
            return self.name_key(key);
        }
        if self.section.authoring() && self.editor.stage == Stage::Picker {
            return self.picker_key(key);
        }
        if self.busy {
            return vec![];
        }
        match key.code {
            KeyCode::Char('?') => {
                self.help = true;
                vec![]
            }
            KeyCode::Char('q') => {
                if self.dirty() {
                    self.confirm_discard = true;
                    self.discard_quits = true;
                } else {
                    self.quit = true;
                }
                vec![]
            }
            KeyCode::Tab | KeyCode::BackTab => {
                let i = Section::ALL
                    .iter()
                    .position(|s| *s == self.section)
                    .unwrap_or(0);
                self.select_section(
                    Section::ALL[(i + if key.code == KeyCode::BackTab {
                        Section::ALL.len() - 1
                    } else {
                        1
                    }) % Section::ALL.len()],
                )
            }
            KeyCode::Char(c @ '1'..='5') => {
                self.select_section(Section::ALL[(c as u8 - b'1') as usize])
            }
            _ => match self.section {
                Section::Home => match key.code {
                    KeyCode::Enter | KeyCode::Char('c') => self.select_section(Section::Profiles),
                    KeyCode::Char('r') => {
                        self.busy = true;
                        vec![
                            Effect::LoadConfig,
                            Effect::History {
                                after: None,
                                selected: self.selected_run(),
                            },
                        ]
                    }
                    _ => vec![],
                },
                Section::Profiles | Section::Settings => self.config_key(key),
                Section::Status | Section::Metrics => self.history_key(key),
            },
        }
    }
    fn history_key(&mut self, key: KeyEvent) -> Vec<Effect> {
        if self.detail_open {
            match key.code {
                KeyCode::Esc => self.detail_open = false,
                KeyCode::Down | KeyCode::Char('j') => {
                    let count = if self.section == Section::Metrics {
                        self.detail.run.as_ref().map_or(0, |run| {
                            METRIC_FIXED_ROWS
                                + run.metrics.outcomes.as_ref().map_or(1, |rows| rows.len())
                        })
                    } else {
                        self.detail.timeline.len()
                    };
                    self.timeline_cursor = (self.timeline_cursor + 1).min(count.saturating_sub(1));
                }
                KeyCode::Up | KeyCode::Char('k') => {
                    self.timeline_cursor = self.timeline_cursor.saturating_sub(1)
                }
                _ => {}
            }
        } else {
            let old = self.run_cursor;
            match key.code {
                KeyCode::Down | KeyCode::Char('j') => {
                    self.run_cursor = (self.run_cursor + 1).min(self.runs.len().saturating_sub(1))
                }
                KeyCode::Up | KeyCode::Char('k') => {
                    self.run_cursor = self.run_cursor.saturating_sub(1)
                }
                KeyCode::Enter => self.detail_open = true,
                KeyCode::Char('n') => {
                    if let Some(after) = self.next_cursor.clone() {
                        self.history_loading = true;
                        return vec![Effect::History {
                            after: Some(after),
                            selected: self.selected_run(),
                        }];
                    }
                }
                _ => {}
            }
            if self.run_cursor != old {
                self.timeline_cursor = 0;
                return self
                    .selected_run()
                    .map(Effect::Detail)
                    .into_iter()
                    .collect();
            }
        }
        if key.code == KeyCode::Char('r') {
            self.history_loading = true;
            return vec![Effect::History {
                after: None,
                selected: self.selected_run(),
            }];
        }
        vec![]
    }
    fn config_key(&mut self, key: KeyEvent) -> Vec<Effect> {
        if key.code == KeyCode::F(5) {
            self.editor.preview = None;
            self.busy = true;
            return vec![Effect::LoadConfig];
        }
        if key.code == KeyCode::Char('r') && self.editor.stage != Stage::Review {
            self.catalog_loading = true;
            return vec![Effect::RefreshCatalog];
        }
        if key.code == KeyCode::Esc {
            match self.editor.stage {
                Stage::Review => {
                    self.editor.stage = self.editor.review_return;
                    if self.editor.stage == Stage::Scope {
                        self.editor.changes.clear();
                        self.editor.preview = None;
                        self.editor.cursor = SCOPES
                            .iter()
                            .position(|s| *s == self.editor.scope)
                            .unwrap_or(1);
                    }
                }
                Stage::Actions | Stage::LegacyOverride => self.reset_editor(),
                Stage::Profiles | Stage::ContextList => return self.select_section(Section::Home),
                _ if self.dirty() => {
                    self.confirm_discard = true;
                    self.discard_quits = false;
                }
                _ => self.reset_editor(),
            }
            return vec![];
        }
        let length = match self.editor.stage {
            Stage::Profiles => self.profiles().len(),
            Stage::ContextList => self.contexts().len(),
            Stage::Actions => self.actions().len(),
            Stage::Scope => 3,
            Stage::Contexts => self.names("contexts").len(),
            Stage::Providers => self.providers().len(),
            Stage::Roles => self.role_ids().len(),
            _ => 0,
        };
        match key.code {
            KeyCode::Up | KeyCode::Char('k') => {
                self.editor.cursor = self.editor.cursor.saturating_sub(1);
                if self.editor.stage == Stage::Review {
                    self.editor.preview_scroll = self.editor.preview_scroll.saturating_sub(1);
                }
                return vec![];
            }
            KeyCode::Down | KeyCode::Char('j') => {
                self.editor.cursor = (self.editor.cursor + 1).min(length.saturating_sub(1));
                if self.editor.stage == Stage::Review {
                    self.editor.preview_scroll = self.editor.preview_scroll.saturating_add(1);
                }
                return vec![];
            }
            _ => {}
        }
        match self.editor.stage {
            Stage::Profiles | Stage::ContextList => {
                let profiles = self.editor.stage == Stage::Profiles;
                if key.code == KeyCode::Char('n') {
                    self.start_action(
                        if profiles {
                            Action::NewProfile
                        } else {
                            Action::NewContext
                        },
                        Scope::Project,
                    );
                } else if key.code == KeyCode::Char('u')
                    && profiles
                    && self
                        .snapshot
                        .as_ref()
                        .is_some_and(|s| s.active_profile.is_some())
                {
                    self.editor.stage = Stage::LegacyOverride;
                } else if matches!(
                    key.code,
                    KeyCode::Enter | KeyCode::Char('a') | KeyCode::Char('e') | KeyCode::Delete
                ) {
                    let scope = if profiles {
                        let Some(profile) = self.profiles().get(self.editor.cursor).cloned() else {
                            if key.code == KeyCode::Enter {
                                self.start_action(Action::NewProfile, Scope::Project);
                            }
                            return vec![];
                        };
                        self.editor.profile = profile.name.clone();
                        profile.highest_scope()
                    } else {
                        let Some(context) = self.contexts().get(self.editor.cursor).cloned() else {
                            if key.code == KeyCode::Enter {
                                self.start_action(Action::NewContext, Scope::Project);
                            }
                            return vec![];
                        };
                        self.editor.context = context.name.clone();
                        context.highest_scope()
                    };
                    let action = match key.code {
                        KeyCode::Char('a') if profiles => Some(Action::ActivateProfile),
                        KeyCode::Char('e') => Some(if profiles {
                            Action::EditProfile
                        } else {
                            Action::EditContext
                        }),
                        KeyCode::Delete => Some(if profiles {
                            Action::DeleteProfile
                        } else {
                            Action::DeleteContext
                        }),
                        _ => None,
                    };
                    if let Some(action) = action {
                        self.start_action(action, scope);
                    } else {
                        self.editor.stage = Stage::Actions;
                        self.editor.cursor = 0;
                    }
                }
            }
            Stage::Actions => {
                if key.code == KeyCode::Enter
                    && let Some(action) = self.actions().get(self.editor.cursor).copied()
                {
                    let scope = if self.editor.section == Section::Profiles {
                        self.profiles()
                            .iter()
                            .find(|p| p.name == self.editor.profile)
                            .map(|p| p.highest_scope())
                    } else {
                        self.contexts()
                            .iter()
                            .find(|c| c.name == self.editor.context)
                            .map(|c| c.highest_scope())
                    }
                    .unwrap_or(Scope::Project);
                    self.start_action(action, scope);
                }
            }
            Stage::LegacyOverride => {
                if key.code == KeyCode::Enter {
                    self.busy = true;
                    return vec![Effect::Activate(None)];
                }
            }
            Stage::Scope => {
                if key.code == KeyCode::Enter && self.snapshot.is_some() {
                    self.editor.scope = SCOPES[self.editor.cursor.min(2)];
                    self.editor.draft = self
                        .snapshot
                        .as_ref()
                        .and_then(|s| s.scoped.get(&self.editor.scope))
                        .cloned()
                        .unwrap_or_else(|| json!({}));
                    if self.snapshot.as_ref().is_some_and(|s| {
                        s.documents.iter().any(|d| {
                            d.scope == self.editor.scope && d.source.is_some() && d.error.is_some()
                        })
                    }) {
                        self.confirm_repair = true;
                        return vec![];
                    }
                    return self.after_scope();
                }
            }
            Stage::Contexts => match key.code {
                KeyCode::Char('n') => {
                    self.editor.naming = Some(NameKind::Context);
                    self.editor.name.clear();
                }
                KeyCode::Enter => {
                    if let Some(name) = self.names("contexts").get(self.editor.cursor).cloned() {
                        self.choose_context(name);
                        if self.names("profiles").contains(&self.editor.profile) {
                            self.bind_context();
                            self.editor.stage = Stage::Roles;
                            self.editor.cursor = 0;
                        } else {
                            self.editor.naming = Some(NameKind::Profile);
                            self.editor.name.clear();
                        }
                    }
                }
                _ => {}
            },
            Stage::Providers => match key.code {
                KeyCode::Char(' ') => {
                    if let Some(provider) = self.providers().get(self.editor.cursor).cloned() {
                        if self.editor.allowed.contains(&provider) {
                            self.editor.allowed.retain(|p| p != &provider);
                        } else {
                            self.editor.allowed.push(provider);
                        }
                    }
                }
                KeyCode::Enter => {
                    if self.editor.allowed.is_empty() {
                        self.notice = "Select at least one allowed provider".into();
                    } else {
                        self.set(
                            vec![
                                "contexts".into(),
                                self.editor.context.clone(),
                                "allowed_providers".into(),
                            ],
                            json!(self.editor.allowed),
                        );
                        if self.editor.section == Section::Profiles {
                            if self.names("profiles").contains(&self.editor.profile) {
                                self.bind_context();
                                self.editor.stage = Stage::Roles;
                                self.editor.cursor = 0;
                            } else {
                                self.editor.stage = Stage::Contexts;
                                self.editor.naming = Some(NameKind::Profile);
                                self.editor.name.clear();
                                self.notice = "Context ready. Name the profile that will assign models to roles.".into();
                            }
                        } else {
                            return self.review(Stage::Providers);
                        }
                    }
                }
                _ => {}
            },
            Stage::Roles => return self.roles_key(key),
            Stage::Review => {
                if key.code == KeyCode::Char('v') {
                    return self.preview_effect(true);
                }
                if key.code == KeyCode::Enter
                    && let (Some(preview), Some(snapshot)) = (&self.editor.preview, &self.snapshot)
                    && preview.revision == snapshot.revision
                    && preview.scope == self.editor.scope
                    && preview.changes == self.editor.changes
                {
                    self.busy = true;
                    return vec![Effect::Save {
                        snapshot: Box::new(snapshot.clone()),
                        scope: self.editor.scope,
                        changes: self.editor.changes.clone(),
                    }];
                }
            }
            Stage::Picker => {}
        }
        vec![]
    }
    fn roles_key(&mut self, key: KeyEvent) -> Vec<Effect> {
        match key.code {
            KeyCode::Enter | KeyCode::Char('a') => {
                self.editor.role_cursor = self.editor.cursor;
                self.editor.apply_all = key.code == KeyCode::Char('a');
                self.editor.stage = Stage::Picker;
                self.editor.query.clear();
                self.editor.provider = None;
                self.editor.cursor = 0;
                return vec![self.search_effect()];
            }
            KeyCode::Char('t') => {
                if let Some(id) = self.role_ids().get(self.editor.cursor).cloned()
                    && let Some(route) = self.route(&id)
                {
                    let known = self.models.iter().find(|m| {
                        route.get("provider").and_then(Value::as_str) == Some(&m.provider)
                            && route.get("model").and_then(Value::as_str) == Some(&m.model)
                    });
                    if let Some(model) = known {
                        let levels = if model.reasoning {
                            &["off", "minimal", "low", "medium", "high", "xhigh", "max"][..]
                        } else {
                            &["off"][..]
                        };
                        let current = route
                            .get("thinking")
                            .and_then(Value::as_str)
                            .unwrap_or("off");
                        let i = levels.iter().position(|l| *l == current).unwrap_or(0);
                        self.set(
                            self.role_path(&id, "thinking"),
                            json!(levels[(i + 1) % levels.len()]),
                        );
                    } else {
                        self.notice =
                            "Load the catalog to check this model's reasoning capability".into();
                    }
                }
            }
            KeyCode::Char('c') => {
                self.editor.stage = Stage::Contexts;
                self.editor.cursor = self
                    .names("contexts")
                    .iter()
                    .position(|name| name == &self.editor.context)
                    .unwrap_or(0);
                self.notice =
                    "Choose a context for this profile. Models must use its allowed providers."
                        .into();
            }
            KeyCode::Delete => {
                if let Some(id) = self.role_ids().get(self.editor.cursor).cloned() {
                    let path = vec![
                        "profiles".into(),
                        self.editor.profile.clone(),
                        "roles".into(),
                        id,
                    ];
                    self.editor
                        .changes
                        .push(ConfigurationChange::Remove { path });
                    return self.preview_effect(false);
                }
            }
            KeyCode::Char('v') => {
                if self.editor.new_profile
                    && (self.roles.is_empty()
                        || self.roles.iter().any(|role| self.route(&role.id).is_none()))
                {
                    self.notice =
                        "Assign a model to every role before reviewing this new profile".into();
                    return vec![];
                }
                self.editor.stage = Stage::Review;
                self.editor.review_return = Stage::Roles;
                return self.preview_effect(true);
            }
            _ => {}
        }
        vec![]
    }
    fn preview_effect(&mut self, _review: bool) -> Vec<Effect> {
        if let Some(snapshot) = &self.snapshot {
            self.busy = true;
            vec![Effect::Preview {
                snapshot: Box::new(snapshot.clone()),
                scope: self.editor.scope,
                changes: self.editor.changes.clone(),
            }]
        } else {
            vec![]
        }
    }
    fn name_key(&mut self, key: KeyEvent) -> Vec<Effect> {
        match key.code {
            KeyCode::Esc => {
                self.editor.naming = None;
                self.editor.stage = if self.editor.action == Action::NewProfile {
                    Stage::Contexts
                } else {
                    Stage::Scope
                };
                if self.editor.stage == Stage::Scope {
                    self.editor.cursor = SCOPES
                        .iter()
                        .position(|s| *s == self.editor.scope)
                        .unwrap_or(1);
                }
            }
            KeyCode::Backspace => {
                self.editor.name.pop();
            }
            KeyCode::Char(c)
                if !key
                    .modifiers
                    .intersects(KeyModifiers::CONTROL | KeyModifiers::ALT) =>
            {
                self.editor.name.push(c);
            }
            KeyCode::Enter => {
                let name = self.editor.name.trim().to_owned();
                let kind = self.editor.naming.unwrap();
                let section = if kind == NameKind::Context {
                    "contexts"
                } else {
                    "profiles"
                };
                if name.is_empty() || self.names(section).contains(&name) {
                    self.notice = "Choose a nonempty, unused name".into();
                    return vec![];
                }
                self.editor.naming = None;
                self.editor.cursor = 0;
                if kind == NameKind::Context {
                    self.editor.context = name;
                    self.editor.allowed.clear();
                    self.editor.stage = Stage::Providers;
                } else {
                    self.editor.profile = name;
                    self.editor.new_profile = true;
                    self.set(
                        vec!["profiles".into(), self.editor.profile.clone()],
                        json!({"context":self.editor.context,"roles":{}}),
                    );
                    self.editor.stage = Stage::Roles;
                }
            }
            _ => {}
        }
        vec![]
    }
    fn picker_key(&mut self, key: KeyEvent) -> Vec<Effect> {
        match key.code {
            KeyCode::Esc => {
                self.editor.stage = Stage::Roles;
                self.editor.cursor = self.editor.role_cursor;
            }
            KeyCode::Up => self.editor.cursor = self.editor.cursor.saturating_sub(1),
            KeyCode::Down => {
                self.editor.cursor =
                    (self.editor.cursor + 1).min(self.filtered_matches().len().saturating_sub(1))
            }
            KeyCode::F(4) => {
                let providers = self.allowed_providers();
                let next = self
                    .editor
                    .provider
                    .as_ref()
                    .and_then(|p| providers.iter().position(|x| x == p))
                    .map_or(Some(0), |i| {
                        if i + 1 < providers.len() {
                            Some(i + 1)
                        } else {
                            None
                        }
                    });
                self.editor.provider = next.and_then(|i| providers.get(i).cloned());
                self.editor.cursor = 0;
                self.search_pending = true;
            }
            KeyCode::Backspace => {
                self.editor.query.pop();
                self.search_pending = true;
                self.editor.cursor = 0;
            }
            KeyCode::Char(c)
                if !key
                    .modifiers
                    .intersects(KeyModifiers::CONTROL | KeyModifiers::ALT) =>
            {
                self.editor.query.push(c);
                self.search_pending = true;
                self.editor.cursor = 0;
            }
            KeyCode::Enter if !self.catalog_loading && !self.search_pending => {
                if let Some(model) = self.filtered_matches().get(self.editor.cursor).cloned() {
                    let ids = if self.editor.apply_all {
                        self.role_ids()
                    } else {
                        self.role_ids()
                            .get(self.editor.role_cursor)
                            .cloned()
                            .into_iter()
                            .collect()
                    };
                    for id in ids {
                        self.assign(&id, &model);
                    }
                    self.editor.stage = Stage::Roles;
                    self.editor.cursor = self.editor.role_cursor;
                }
            }
            _ => {}
        }
        vec![]
    }
    pub fn allowed_providers(&self) -> Vec<String> {
        let context = self
            .editor
            .draft
            .get("profiles")
            .and_then(|v| v.get(&self.editor.profile))
            .and_then(|v| v.get("context"))
            .and_then(Value::as_str)
            .unwrap_or(&self.editor.context);
        self.editor
            .draft
            .get("contexts")
            .and_then(|v| v.get(context))
            .and_then(|v| v.get("allowed_providers"))
            .and_then(Value::as_array)
            .map(|a| {
                a.iter()
                    .filter_map(Value::as_str)
                    .map(str::to_owned)
                    .collect()
            })
            .unwrap_or_default()
    }
    pub fn filtered_matches(&self) -> Vec<Model> {
        let allowed = self.allowed_providers();
        self.matches
            .iter()
            .filter(|m| allowed.contains(&m.provider))
            .cloned()
            .collect()
    }
}

fn set_value(root: &mut Value, path: &[String], value: Value) {
    if path.is_empty() {
        *root = value;
        return;
    }
    if !root.is_object() {
        *root = json!({});
    }
    let next = root
        .as_object_mut()
        .unwrap()
        .entry(path[0].clone())
        .or_insert(Value::Null);
    set_value(next, &path[1..], value);
}
