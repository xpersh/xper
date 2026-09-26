//! Pi-specific installation checks and filesystem preparation.

use serde_json::{Value, json};
use std::{
    fs,
    io::{self, Write},
    path::{Path, PathBuf},
    process::Command,
};
use xper_application::{
    installation::{Check, CheckStatus as Status},
    ports::Installation,
};
use xper_config::{DEFAULT_CONFIG, ScopePaths, load_effective, load_global};

const PI_VERSION: &str = "0.85.1";
const OPEN_AGENTS_VERSION: &str = "0.1.22";
const PACKAGE: &str = "npm:pi-open-agents@0.1.22";
const AGENT: &str = "---\nname: xper\ndescription: XP development coordinator backed by xper\nmode: primary\nsystemPrompt: replace\n---\n\nYou are xper, the primary agent for an Extreme Programming development session.\nStart a run with /xper start before delegating Discovery. Use xper_delegate for the discovery.explorer assignment and report the Discovery Brief and current phase. A failed or cancelled attempt does not satisfy the Discovery gate. Report bridge problems clearly.\n";

struct Context {
    root: PathBuf,
    pi_home: PathBuf,
    scopes: ScopePaths,
}
impl Context {
    fn current() -> io::Result<Self> {
        let root = std::env::current_dir()?;
        let home = std::env::var_os("HOME")
            .map(PathBuf::from)
            .ok_or_else(|| io::Error::other("HOME is not set"))?;
        let pi_home = std::env::var_os("PI_CODING_AGENT_DIR")
            .map(PathBuf::from)
            .unwrap_or_else(|| home.join(".pi/agent"));
        let xdg = std::env::var_os("XDG_CONFIG_HOME").map(PathBuf::from);
        let scopes = ScopePaths::new(&root, &home, xdg.as_deref());
        Ok(Self {
            root,
            pi_home,
            scopes,
        })
    }
    fn agent(&self, global: bool) -> PathBuf {
        if global {
            self.pi_home.join("agents/xper.md")
        } else {
            self.root.join(".pi/agents/xper.md")
        }
    }
    fn effective_agent(&self) -> PathBuf {
        let project = self.agent(false);
        if project.exists() {
            project
        } else {
            self.agent(true)
        }
    }
    fn package_roots(&self, global: bool) -> Vec<PathBuf> {
        let mut roots = Vec::new();
        if !global {
            roots.push(
                self.root
                    .join(".pi/npm/node_modules/pi-open-agents/package.json"),
            );
        }
        roots.push(
            self.pi_home
                .join("npm/node_modules/pi-open-agents/package.json"),
        );
        roots
    }
    fn settings(&self, global: bool) -> PathBuf {
        if global {
            self.pi_home.join("settings.json")
        } else {
            self.root.join(".pi/settings.json")
        }
    }
}

fn package_version(context: &Context, global: bool) -> Option<String> {
    for path in context.package_roots(global) {
        if let Ok(source) = fs::read_to_string(path)
            && let Ok(value) = serde_json::from_str::<Value>(&source)
            && let Some(version) = value.get("version").and_then(Value::as_str)
        {
            return Some(version.to_owned());
        }
    }
    None
}

fn settings_packages(path: &Path) -> Result<Vec<String>, String> {
    let source = match fs::read_to_string(path) {
        Ok(source) => source,
        Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(Vec::new()),
        Err(error) => return Err(format!("cannot read {}: {error}", path.display())),
    };
    let value: Value =
        serde_json::from_str(&source).map_err(|_| format!("invalid JSON in {}", path.display()))?;
    if !value.is_object() {
        return Err(format!("settings must be an object in {}", path.display()));
    }
    xper_config::reject_credentials(&value).map_err(|_| {
        format!(
            "Pi settings contains a credential field in {}; move it to Pi's credential store",
            path.display()
        )
    })?;
    let Some(packages) = value.get("packages") else {
        return Ok(Vec::new());
    };
    let packages = packages
        .as_array()
        .ok_or_else(|| format!("packages must be an array in {}", path.display()))?;
    packages
        .iter()
        .map(|item| {
            item.as_str()
                .map(str::to_owned)
                .ok_or_else(|| format!("non-string package in {}", path.display()))
        })
        .collect()
}

fn agent_valid(path: &Path) -> Result<bool, io::Error> {
    let source = match fs::read_to_string(path) {
        Ok(source) => source,
        Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(false),
        Err(error) => return Err(error),
    };
    let mut front = source.split("---");
    let valid = front.next() == Some("")
        && front.next().is_some_and(|header| {
            header.lines().any(|line| line.trim() == "name: xper")
                && header.lines().any(|line| line.trim() == "mode: primary")
        });
    Ok(valid)
}

fn inspect(context: &Context, global: bool) -> Vec<Check> {
    let mut checks = Vec::new();
    match Command::new("pi").arg("--version").output() {
        Err(error) if error.kind() == io::ErrorKind::NotFound => checks.push(Check::new(
            "PI_MISSING",
            Status::Fail,
            "Pi executable not found",
            Some("Install Pi: npm install -g @mariozechner/pi-coding-agent"),
        )),
        Err(_) => checks.push(Check::new(
            "PI_MISSING",
            Status::Fail,
            "Pi executable could not run",
            Some("Check the pi executable and PATH"),
        )),
        Ok(output) if !output.status.success() => checks.push(Check::new(
            "PI_VERSION",
            Status::Fail,
            "pi --version failed",
            Some("Repair Pi and retry"),
        )),
        Ok(output) => {
            let version = String::from_utf8_lossy(&output.stdout).trim().to_owned();
            if version == PI_VERSION {
                checks.push(Check::new(
                    "PI_VERSION",
                    Status::Pass,
                    format!("Pi {version}"),
                    None,
                ));
            } else {
                checks.push(Check::new(
                    "PI_VERSION",
                    Status::Fail,
                    format!("Pi {version}; tested version is {PI_VERSION}"),
                    Some("Install the tested Pi version"),
                ));
            }
        }
    }

    match package_version(context, global) {
        None => checks.push(Check::new(
            "OPEN_AGENTS_MISSING",
            Status::Fail,
            "pi-open-agents is not installed in the selected scope",
            Some("pi install npm:pi-open-agents"),
        )),
        Some(version) if version != OPEN_AGENTS_VERSION => checks.push(Check::new(
            "OPEN_AGENTS_VERSION",
            Status::Fail,
            format!("pi-open-agents {version}; tested version is {OPEN_AGENTS_VERSION}"),
            Some("pi install npm:pi-open-agents@0.1.22"),
        )),
        Some(version) => checks.push(Check::new(
            "OPEN_AGENTS_VERSION",
            Status::Pass,
            format!("pi-open-agents {version}"),
            None,
        )),
    }

    let mut packages = settings_packages(&context.settings(global));
    if !global {
        let global_packages = settings_packages(&context.pi_home.join("settings.json"));
        packages = match (packages, global_packages) {
            (Ok(mut project), Ok(global)) => {
                project.extend(global);
                Ok(project)
            }
            (Err(error), _) | (_, Err(error)) => Err(error),
        };
    }
    match packages {
        Err(message) => checks.push(Check::new(
            "PI_SETTINGS",
            Status::Fail,
            message,
            Some("Repair Pi settings.json"),
        )),
        Ok(packages) => {
            let conflicts: Vec<_> = packages
                .iter()
                .map(String::as_str)
                .filter(|p| {
                    p.contains("agent")
                        && !p.starts_with("npm:pi-open-agents")
                        && !p.starts_with("file:")
                })
                .collect();
            if conflicts.is_empty() {
                checks.push(Check::new(
                    "AGENT_CONFLICT",
                    Status::Pass,
                    "No competing agent package declared",
                    None,
                ));
            } else {
                checks.push(Check::new(
                    "AGENT_CONFLICT",
                    Status::Fail,
                    format!("Competing agent package: {}", conflicts.join(", ")),
                    Some("Remove or disable the competing Pi agent manager"),
                ));
            }
            if let Some(declared) = packages
                .iter()
                .find(|p| p.starts_with("npm:pi-open-agents") && *p != PACKAGE)
            {
                checks.push(Check::new(
                    "PACKAGE_DECLARATION",
                    Status::Fail,
                    format!("Pi settings declares {declared}; expected {PACKAGE}"),
                    Some("Replace the declaration with npm:pi-open-agents@0.1.22"),
                ));
            } else if packages.iter().any(|p| p == PACKAGE) {
                checks.push(Check::new(
                    "PACKAGE_DECLARATION",
                    Status::Pass,
                    PACKAGE,
                    None,
                ));
            } else {
                checks.push(Check::new(
                    "PACKAGE_DECLARATION",
                    Status::Warn,
                    "Tested pi-open-agents package is not pinned in Pi settings",
                    Some("Run xper init to pin npm:pi-open-agents@0.1.22"),
                ));
            }
        }
    }

    let agent = if global {
        context.agent(true)
    } else {
        context.effective_agent()
    };
    match agent_valid(&agent) {
        Ok(true) => checks.push(Check::new(
            "PRIMARY_AGENT",
            Status::Pass,
            format!("{} is primary", agent.display()),
            None,
        )),
        Ok(false) => checks.push(Check::new(
            "PRIMARY_AGENT",
            Status::Fail,
            format!("{} missing or not primary", agent.display()),
            Some("Run xper init to create or repair the agent"),
        )),
        Err(error) => checks.push(Check::new(
            "PRIMARY_AGENT",
            Status::Fail,
            format!("{}: {error}", agent.display()),
            Some("Check agent file permissions"),
        )),
    }

    let extension = if global {
        context.pi_home.join("extensions/xper.ts")
    } else {
        context.root.join(".pi/extensions/xper.ts")
    };
    let adapter = if global {
        context
            .pi_home
            .join("npm/node_modules/@xper/adapter-pi/package.json")
    } else {
        context.root.join("adapters/pi/package.json")
    };
    let built = if global {
        context
            .pi_home
            .join("npm/node_modules/@xper/adapter-pi/dist/extension.js")
    } else {
        context.root.join("adapters/pi/dist/extension.js")
    };
    let adapter_version = fs::read_to_string(&adapter)
        .ok()
        .and_then(|source| serde_json::from_str::<Value>(&source).ok())
        .and_then(|v| v.get("version").and_then(Value::as_str).map(str::to_owned));
    if extension.is_file()
        && built.is_file()
        && adapter_version.as_deref() == Some(env!("CARGO_PKG_VERSION"))
    {
        checks.push(Check::new(
            "ADAPTER",
            Status::Pass,
            format!("xper Pi adapter {}", env!("CARGO_PKG_VERSION")),
            None,
        ));
    } else if adapter_version.is_some()
        && adapter_version.as_deref() != Some(env!("CARGO_PKG_VERSION"))
    {
        checks.push(Check::new(
            "ADAPTER",
            Status::Fail,
            format!(
                "xper Pi adapter version {}; expected {}",
                adapter_version.unwrap_or_default(),
                env!("CARGO_PKG_VERSION")
            ),
            Some("Install the matching xper Pi adapter version"),
        ));
    } else {
        checks.push(Check::new("ADAPTER", Status::Warn,
            "xper Pi extension or built adapter not found",
            Some("Install the xper Pi adapter and build its extension; in this checkout run npm ci && npm run build --workspace @xper/adapter-pi")));
    }

    let config = if global {
        load_global(&context.scopes)
    } else {
        load_effective(&context.scopes)
    };
    match config {
        Ok(config) if config.pointer("/harness/adapter").and_then(Value::as_str) == Some("pi") => {
            let configured = if global {
                context.scopes.global.is_file()
            } else {
                [
                    &context.scopes.global,
                    &context.scopes.project,
                    &context.scopes.local,
                ]
                .iter()
                .any(|path| path.is_file())
            };
            if configured {
                checks.push(Check::new(
                    "CONFIG",
                    Status::Pass,
                    "Effective configuration is valid for Pi",
                    None,
                ));
            } else {
                checks.push(Check::new(
                    "CONFIG",
                    Status::Warn,
                    "No xper configuration file found; built-in defaults apply",
                    Some("Run xper init"),
                ));
            }
        }
        Ok(_) => checks.push(Check::new(
            "CONFIG",
            Status::Fail,
            "Selected harness adapter is not Pi",
            Some("Set harness.adapter to pi"),
        )),
        Err(error) => checks.push(Check::new(
            "CONFIG",
            Status::Fail,
            error.to_string(),
            Some("Repair the indicated configuration file"),
        )),
    }
    for check in &mut checks {
        if check.id == "PRIMARY_AGENT" {
            check.repairable = true;
        }
    }
    checks
}

fn write_new(path: &Path, content: &str) -> io::Result<bool> {
    if path.exists() {
        return Ok(false);
    }
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)?;
    }
    let mut file = fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(path)?;
    file.write_all(content.as_bytes())?;
    Ok(true)
}

fn pin_package(path: &Path) -> Result<bool, String> {
    let mut value = match fs::read_to_string(path) {
        Ok(source) => serde_json::from_str::<Value>(&source)
            .map_err(|_| format!("invalid JSON in {}", path.display()))?,
        Err(error) if error.kind() == io::ErrorKind::NotFound => json!({"packages": []}),
        Err(error) => return Err(error.to_string()),
    };
    xper_config::reject_credentials(&value).map_err(|_| "Pi settings contains a credential field; move credentials to Pi's credential store before init".to_owned())?;
    if value.get("packages").is_none() {
        value
            .as_object_mut()
            .ok_or_else(|| format!("settings must be an object in {}", path.display()))?
            .insert("packages".into(), json!([]));
    }
    let packages = value
        .get_mut("packages")
        .and_then(Value::as_array_mut)
        .ok_or_else(|| format!("packages must be an array in {}", path.display()))?;
    if packages.iter().any(|v| v.as_str() == Some(PACKAGE)) {
        return Ok(false);
    }
    if packages.iter().any(|v| {
        v.as_str()
            .is_some_and(|s| s.starts_with("npm:pi-open-agents"))
    }) {
        return Err("Pi settings pins another pi-open-agents version; edit it explicitly".into());
    }
    packages.push(Value::String(PACKAGE.into()));
    let text = serde_json::to_string_pretty(&value).map_err(|e| e.to_string())? + "\n";
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    fs::write(path, text).map_err(|e| e.to_string())?;
    Ok(true)
}

fn ignore_local_config(root: &Path) -> io::Result<bool> {
    let path = root.join(".gitignore");
    let existing = match fs::read_to_string(&path) {
        Ok(text) => text,
        Err(error) if error.kind() == io::ErrorKind::NotFound => String::new(),
        Err(error) => return Err(error),
    };
    const RULE: &str = "/.xper/config.local.yaml";
    if existing.lines().any(|line| line.trim() == RULE) {
        return Ok(false);
    }
    let mut file = fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(&path)?;
    if !existing.is_empty() && !existing.ends_with('\n') {
        writeln!(file)?;
    }
    writeln!(file, "{RULE}")?;
    Ok(true)
}

pub(crate) struct LocalInstallation {
    context: Context,
    global: bool,
}

impl LocalInstallation {
    pub(crate) fn current(global: bool) -> io::Result<Self> {
        Ok(Self {
            context: Context::current()?,
            global,
        })
    }
}

impl Installation for LocalInstallation {
    type Error = io::Error;

    fn inspect(&self) -> Vec<Check> {
        inspect(&self.context, self.global)
    }
    fn agent_target(&self) -> String {
        self.context.agent(self.global).display().to_string()
    }
    fn agent_is_valid(&self) -> io::Result<bool> {
        agent_valid(&self.context.agent(self.global))
    }

    fn prepare(&mut self, repair_agent: bool) -> io::Result<Vec<String>> {
        let context = &self.context;
        let global = self.global;
        let agent = context.agent(global);
        let mut changes = Vec::new();
        if repair_agent && agent.exists() && agent.with_extension("md.bak").exists() {
            return Err(io::Error::other(format!(
                "backup already exists: {}",
                agent.with_extension("md.bak").display()
            )));
        }
        let config = if global {
            &context.scopes.global
        } else {
            &context.scopes.project
        };
        if write_new(config, DEFAULT_CONFIG)? {
            changes.push(format!("created {}", config.display()));
        }
        if repair_agent {
            if agent.exists() {
                let backup = agent.with_extension("md.bak");
                fs::copy(&agent, &backup)?;
                changes.push(format!("backed up {}", backup.display()));
                fs::write(&agent, AGENT)?;
            } else {
                write_new(&agent, AGENT)?;
            }
            changes.push(format!("created {}", agent.display()));
        }
        match pin_package(&context.settings(global)) {
            Ok(true) => changes.push(format!(
                "pinned {PACKAGE} in {}",
                context.settings(global).display()
            )),
            Ok(false) => {}
            Err(error) => return Err(io::Error::other(error)),
        }
        if !global && ignore_local_config(&context.root)? {
            changes.push(format!(
                "ignored .xper/config.local.yaml in {}",
                context.root.join(".gitignore").display()
            ));
        }
        Ok(changes)
    }
}
