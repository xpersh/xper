//! Pi-specific installation checks and filesystem preparation.

use serde_json::Value;
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

const MIN_PI_VERSION: &str = "0.85.1";
const MAX_PI_VERSION: &str = "0.87.1";

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
    fn settings(&self, global: bool) -> PathBuf {
        if global {
            self.pi_home.join("settings.json")
        } else {
            self.root.join(".pi/settings.json")
        }
    }
}

fn validate_settings(path: &Path) -> Result<(), String> {
    let source = match fs::read_to_string(path) {
        Ok(source) => source,
        Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(()),
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
    Ok(())
}

/// Accept only canonical stable releases from Pi's `--version` output.
fn parse_pi_version(version: &str) -> Option<[u64; 3]> {
    let mut parts = version.split('.');
    let mut release = [0; 3];
    for component in &mut release {
        let part = parts.next()?;
        if (part.len() > 1 && part.starts_with('0'))
            || !part.bytes().all(|byte| byte.is_ascii_digit())
        {
            return None;
        }
        *component = part.parse().ok()?;
    }
    parts.next().is_none().then_some(release)
}

fn supports_pi_version(version: &str) -> bool {
    let Some(version) = parse_pi_version(version) else {
        return false;
    };
    let minimum = parse_pi_version(MIN_PI_VERSION).expect("valid minimum Pi version");
    let maximum = parse_pi_version(MAX_PI_VERSION).expect("valid maximum Pi version");
    (minimum..=maximum).contains(&version)
}

fn inspect(context: &Context, global: bool) -> Vec<Check> {
    let mut checks = Vec::new();
    match Command::new("pi").arg("--version").output() {
        Err(error) if error.kind() == io::ErrorKind::NotFound => checks.push(Check::new(
            "PI_MISSING",
            Status::Fail,
            "Pi executable not found",
            Some("Install Pi: npm install -g @earendil-works/pi-coding-agent"),
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
            if supports_pi_version(&version) {
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
                    format!(
                        "Pi {version}; supported stable versions are {MIN_PI_VERSION} through {MAX_PI_VERSION} (inclusive)"
                    ),
                    Some(&format!(
                        "Install a stable Pi version from {MIN_PI_VERSION} through {MAX_PI_VERSION} (inclusive)"
                    )),
                ));
            }
        }
    }

    let mut settings = validate_settings(&context.settings(global));
    if !global {
        settings = settings.and_then(|()| validate_settings(&context.settings(true)));
    }
    match settings {
        Ok(()) => checks.push(Check::new(
            "PI_SETTINGS",
            Status::Pass,
            "Pi settings are valid; packages and agents are managed by Pi",
            None,
        )),
        Err(message) => checks.push(Check::new(
            "PI_SETTINGS",
            Status::Fail,
            message,
            Some("Repair Pi settings.json"),
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
    fn prepare(&mut self) -> io::Result<Vec<String>> {
        let context = &self.context;
        let global = self.global;
        let mut changes = Vec::new();
        let config = if global {
            &context.scopes.global
        } else {
            &context.scopes.project
        };
        if write_new(config, DEFAULT_CONFIG)? {
            changes.push(format!("created {}", config.display()));
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
