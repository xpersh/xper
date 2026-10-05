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

use super::catalog::{Model, Role};

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(super) enum Section {
    Home,
    Configuration,
    Status,
    Metrics,
}

impl Section {
    pub const ALL: [Self; 4] = [Self::Home, Self::Configuration, Self::Status, Self::Metrics];
    pub fn label(self) -> &'static str {
        match self {
            Self::Home => "Home",
            Self::Configuration => "Configuration",
            Self::Status => "Status",
            Self::Metrics => "Metrics",
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(super) enum Stage {
    Scope,
    Contexts,
    Providers,
    Profiles,
    Roles,
    Picker,
    Review,
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
            stage: Stage::Scope,
            scope: Scope::Project,
            draft: json!({}),
            changes: vec![],
            context: String::new(),
            profile: String::new(),
            allowed: vec![],
            new_profile: false,
            cursor: 1,
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
        self.editor = Editor::default();
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
    fn open_profiles(&mut self) {
        self.editor.stage = Stage::Profiles;
        self.editor.cursor = 0;
        if self.names("profiles").is_empty() {
            self.editor.naming = Some(NameKind::Profile);
            self.editor.name.clear();
            self.notice = format!(
                "Context '{}' is ready. Name your first profile, then choose its models.",
                self.editor.context
            );
        }
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
        let old = self.section;
        self.section = section;
        self.detail_open = false;
        self.timeline_cursor = 0;
        let mut effects = vec![];
        if old == Section::Configuration {
            effects.push(Effect::CloseCatalog);
            self.catalog_loading = false;
        }
        if section == Section::Configuration {
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
                    self.editor.stage = Stage::Contexts;
                    self.editor.cursor = 0;
                    return self.preview_effect(false);
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
        if self.section == Section::Configuration && self.editor.naming.is_some() {
            return self.name_key(key);
        }
        if self.section == Section::Configuration && self.editor.stage == Stage::Picker {
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
                    Section::ALL[(i + if key.code == KeyCode::BackTab { 3 } else { 1 }) % 4],
                )
            }
            KeyCode::Char(c @ '1'..='4') => {
                self.select_section(Section::ALL[(c as u8 - b'1') as usize])
            }
            _ => match self.section {
                Section::Home => match key.code {
                    KeyCode::Enter | KeyCode::Char('c') => {
                        self.select_section(Section::Configuration)
                    }
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
                Section::Configuration => self.config_key(key),
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
        if key.code == KeyCode::Char('v')
            && matches!(self.editor.stage, Stage::Contexts | Stage::Profiles)
        {
            self.editor.review_return = self.editor.stage;
            self.editor.stage = Stage::Review;
            return self.preview_effect(true);
        }
        if key.code == KeyCode::Char('r') && self.editor.stage != Stage::Review {
            self.catalog_loading = true;
            return vec![Effect::RefreshCatalog];
        }
        if key.code == KeyCode::Esc {
            if self.editor.stage == Stage::Review {
                self.editor.stage = self.editor.review_return;
            } else if self.dirty() {
                self.confirm_discard = true;
                self.discard_quits = false;
            } else {
                self.editor.stage = Stage::Scope;
                self.editor.cursor = 1;
            }
            return vec![];
        }
        let length = match self.editor.stage {
            Stage::Scope => 3,
            Stage::Contexts => self.names("contexts").len(),
            Stage::Providers => self.providers().len(),
            Stage::Profiles => self.names("profiles").len(),
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
                    self.editor.stage = Stage::Contexts;
                    self.editor.cursor = 0;
                }
            }
            Stage::Contexts => match key.code {
                KeyCode::Delete => {
                    if let Some(name) = self.names("contexts").get(self.editor.cursor).cloned() {
                        self.editor.changes.push(ConfigurationChange::Remove {
                            path: vec!["contexts".into(), name],
                        });
                        return self.preview_effect(false);
                    }
                }
                KeyCode::Char('n') => {
                    self.editor.naming = Some(NameKind::Context);
                    self.editor.name.clear();
                }
                KeyCode::Enter | KeyCode::Char('e') => {
                    if let Some(name) = self.names("contexts").get(self.editor.cursor).cloned() {
                        self.editor.context = name;
                        self.editor.allowed=self.editor.draft["contexts"][&self.editor.context]["allowed_providers"].as_array().map(|a|a.iter().filter_map(Value::as_str).map(str::to_owned).collect()).unwrap_or_default();
                        if key.code == KeyCode::Enter {
                            self.open_profiles();
                        } else {
                            self.editor.stage = Stage::Providers;
                            self.editor.cursor = 0;
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
                        self.open_profiles();
                    }
                }
                _ => {}
            },
            Stage::Profiles => match key.code {
                KeyCode::Delete => {
                    if let Some(name) = self.names("profiles").get(self.editor.cursor).cloned() {
                        self.editor.changes.push(ConfigurationChange::Remove {
                            path: vec!["profiles".into(), name],
                        });
                        return self.preview_effect(false);
                    }
                }
                KeyCode::Char('n') => {
                    self.editor.naming = Some(NameKind::Profile);
                    self.editor.name.clear();
                }
                KeyCode::Char('u') => {
                    self.busy = true;
                    return vec![Effect::Activate(None)];
                }
                KeyCode::Char('a') => {
                    if let Some(name) = self.names("profiles").get(self.editor.cursor).cloned() {
                        if self.dirty() {
                            self.notice = "Save the draft before activating a profile".into();
                        } else {
                            self.busy = true;
                            return vec![Effect::Activate(Some(name))];
                        }
                    }
                }
                KeyCode::Enter => {
                    if let Some(name) = self.names("profiles").get(self.editor.cursor).cloned() {
                        self.editor.profile = name;
                        self.editor.new_profile = false;
                        self.editor.stage = Stage::Roles;
                        self.editor.cursor = 0;
                    } else if self.names("profiles").is_empty() {
                        self.open_profiles();
                    }
                }
                _ => {}
            },
            Stage::Roles => return self.roles_key(key),
            Stage::Review => {
                if key.code == KeyCode::Char('d') && !self.editor.profile.is_empty() {
                    self.set(vec!["profile".into()], json!(self.editor.profile));
                    return self.preview_effect(true);
                }
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
            KeyCode::Char('d') => {
                self.set(vec!["profile".into()], json!(self.editor.profile));
                self.notice = "Default profile updated in draft; review and save to apply".into();
            }
            KeyCode::Char('c') => {
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
                        .is_some_and(|context| {
                            context.as_str() != Some(self.editor.context.as_str())
                        })
                    {
                        self.set(self.role_path(&id, "context"), json!(self.editor.context));
                    }
                }
                self.notice = "Profile context updated in draft".into();
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
            KeyCode::Esc => self.editor.naming = None,
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
