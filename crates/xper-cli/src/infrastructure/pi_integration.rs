//! Reviewed, managed Pi registration and shared adapter discovery.

use std::{
    fs, io,
    io::Write,
    path::{Path, PathBuf},
    sync::atomic::{AtomicU64, Ordering},
};

use serde_json::{Value, json};
use xper_application::{
    installation::{Check, CheckStatus},
    ports::Installation,
};

const HEADER: &str = "// xper-managed-integration-v1 ";
static NEXT_TEMPORARY: AtomicU64 = AtomicU64::new(1);

#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct Registration {
    pub(crate) adapter_root: PathBuf,
    pub(crate) bridge: PathBuf,
}

pub(crate) fn pi_home() -> io::Result<PathBuf> {
    let path = std::env::var_os("PI_CODING_AGENT_DIR")
        .map(PathBuf::from)
        .or_else(|| std::env::var_os("HOME").map(|home| PathBuf::from(home).join(".pi/agent")))
        .ok_or_else(|| io::Error::other("HOME is not set"))?;
    if path.is_absolute() {
        Ok(path)
    } else {
        Ok(std::env::current_dir()?.join(path))
    }
}

fn adapter(path: &Path) -> io::Result<PathBuf> {
    let manifest_path = path.join("package.json");
    let bytes = fs::read(&manifest_path).map_err(|error| {
        io::Error::new(
            error.kind(),
            format!(
                "Cannot read Pi adapter manifest {}: {error}",
                manifest_path.display()
            ),
        )
    })?;
    let manifest: Value = serde_json::from_slice(&bytes)
        .map_err(|_| io::Error::other("Invalid Pi adapter package.json"))?;
    if manifest.get("name").and_then(Value::as_str) != Some("@xper/adapter-pi")
        || manifest.get("version").and_then(Value::as_str) != Some(env!("CARGO_PKG_VERSION"))
    {
        return Err(io::Error::other(
            "Incompatible Pi adapter; install the matching xper adapter",
        ));
    }
    for entry in ["dist/extension.js", "dist/inspection/cli.js"] {
        if !path.join(entry).is_file() {
            return Err(io::Error::other(format!(
                "Pi adapter entry is missing: {}",
                path.join(entry).display()
            )));
        }
    }
    path.canonicalize()
}

fn file_url(path: &Path) -> io::Result<String> {
    let text = path
        .to_str()
        .ok_or_else(|| io::Error::other("Integration paths must be valid Unicode"))?;
    let normalized = if cfg!(windows) {
        text.replace('\\', "/")
    } else {
        text.to_owned()
    };
    let mut url = if normalized.starts_with('/') {
        "file://".to_owned()
    } else {
        "file:///".to_owned()
    };
    for byte in normalized.bytes() {
        if byte.is_ascii_alphanumeric() || b"/-._~:".contains(&byte) {
            url.push(char::from(byte));
        } else {
            url.push_str(&format!("%{byte:02X}"));
        }
    }
    Ok(url)
}

fn source(registration: &Registration) -> io::Result<String> {
    let adapter_root = registration
        .adapter_root
        .to_str()
        .ok_or_else(|| io::Error::other("Integration paths must be valid Unicode"))?;
    let bridge_path = registration
        .bridge
        .to_str()
        .ok_or_else(|| io::Error::other("Integration paths must be valid Unicode"))?;
    let descriptor = json!({"adapterRoot":adapter_root,"bridge":bridge_path});
    let entry = serde_json::to_string(&file_url(
        &registration.adapter_root.join("dist/extension.js"),
    )?)?;
    let bridge = serde_json::to_string(&registration.bridge)?;
    Ok(format!(
        "{HEADER}{descriptor}\nimport {{ createXperExtension }} from {entry};\n\nexport default function xperExtension(pi: Parameters<typeof createXperExtension>[0]): void {{\n  createXperExtension(pi, {{ command: process.env.XPER_BRIDGE_COMMAND ?? {bridge} }});\n}}\n"
    ))
}

fn managed(path: &Path) -> io::Result<Option<(Registration, Vec<u8>)>> {
    match fs::symlink_metadata(path) {
        Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(None),
        Err(error) => return Err(error),
        Ok(metadata) if !metadata.file_type().is_file() => {
            return Err(io::Error::other(format!(
                "Refusing a non-regular Pi integration file: {}",
                path.display()
            )));
        }
        Ok(_) => {}
    }
    let bytes = fs::read(path)?;
    let registration = bytes
        .split(|byte| *byte == b'\n')
        .next()
        .and_then(|line| line.strip_prefix(HEADER.as_bytes()))
        .and_then(|json| serde_json::from_slice::<Value>(json).ok())
        .and_then(|value| {
            Some(Registration {
                adapter_root: PathBuf::from(value.get("adapterRoot")?.as_str()?),
                bridge: PathBuf::from(value.get("bridge")?.as_str()?),
            })
        })
        .ok_or_else(|| {
            io::Error::other(format!(
                "Pi integration is not xper-managed: {}",
                path.display()
            ))
        })?;
    if !registration.adapter_root.is_absolute()
        || !registration.bridge.is_absolute()
        || source(&registration)?.as_bytes() != bytes
    {
        return Err(io::Error::other(format!(
            "Managed Pi integration was modified: {}",
            path.display()
        )));
    }
    Ok(Some((registration, bytes)))
}

fn validate(registration: &Registration) -> io::Result<()> {
    adapter(&registration.adapter_root)?;
    if !registration.bridge.is_file() {
        return Err(io::Error::other(format!(
            "Registered xper binary is missing: {}",
            registration.bridge.display()
        )));
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        if fs::metadata(&registration.bridge)?.permissions().mode() & 0o111 == 0 {
            return Err(io::Error::other(format!(
                "Registered xper binary is not executable: {}",
                registration.bridge.display()
            )));
        }
    }
    Ok(())
}

fn registered_at(home: &Path) -> io::Result<Option<Registration>> {
    managed(&home.join("extensions/xper.ts"))?
        .map(|(registration, _)| {
            validate(&registration)?;
            Ok(registration)
        })
        .transpose()
}

pub(crate) fn registered() -> io::Result<Option<Registration>> {
    registered_at(&pi_home()?)
}

fn adapter_directory_at(root: &Path, home: &Path) -> io::Result<PathBuf> {
    let checkout = root.join("adapters/pi");
    if checkout.join("package.json").exists() {
        return adapter(&checkout);
    }
    if let Some(registration) = registered_at(home)? {
        return Ok(registration.adapter_root);
    }
    let installed = home.join("npm/node_modules/@xper/adapter-pi");
    if installed.join("package.json").exists() {
        return adapter(&installed);
    }
    Err(io::Error::other(
        "Pi adapter not found; build this checkout's adapter or install the matching Pi package",
    ))
}

pub(crate) fn adapter_directory(root: &Path) -> io::Result<PathBuf> {
    adapter_directory_at(root, &pi_home()?)
}

#[derive(Clone, Debug)]
pub(crate) struct GlobalIntegration {
    path: PathBuf,
    registration: Registration,
    original: Option<Vec<u8>>,
    proposed: String,
}

impl GlobalIntegration {
    pub(crate) fn plan(root: &Path) -> io::Result<Self> {
        Self::plan_at(root, &pi_home()?, &std::env::current_exe()?)
    }

    fn plan_at(root: &Path, home: &Path, bridge: &Path) -> io::Result<Self> {
        let registration = Registration {
            adapter_root: adapter_directory_at(root, home)?,
            bridge: bridge.canonicalize()?,
        };
        validate(&registration)?;
        let path = home.join("extensions/xper.ts");
        let original = managed(&path)?.map(|(_, bytes)| bytes);
        let proposed = source(&registration)?;
        Ok(Self {
            path,
            registration,
            original,
            proposed,
        })
    }

    pub(crate) fn describe(&self) -> String {
        format!(
            "Register global Pi extension {}; adapter {}; bridge {}. Existing Pi settings are preserved. The linked adapter build and binary must remain at these paths.",
            self.path.display(),
            self.registration.adapter_root.display(),
            self.registration.bridge.display()
        )
    }

    fn check(&self) -> io::Result<()> {
        validate(&self.registration)?;
        if managed(&self.path)?.map(|(_, bytes)| bytes) != self.original {
            return Err(io::Error::other(
                "Pi integration changed after review; review a new plan before applying it",
            ));
        }
        Ok(())
    }

    pub(crate) fn prepare(&self) -> io::Result<Vec<String>> {
        self.check()?;
        if self.original.as_deref() == Some(self.proposed.as_bytes()) {
            return Ok(vec![]);
        }
        let parent = self
            .path
            .parent()
            .expect("integration destination has a parent");
        fs::create_dir_all(parent)?;
        let temporary = parent.join(format!(
            ".xper-integration-{}-{}.tmp",
            std::process::id(),
            NEXT_TEMPORARY.fetch_add(1, Ordering::Relaxed)
        ));
        let mut file = fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&temporary)?;
        let result = (|| {
            if let Ok(metadata) = fs::symlink_metadata(&self.path) {
                file.set_permissions(metadata.permissions())?;
            }
            file.write_all(self.proposed.as_bytes())?;
            file.sync_all()?;
            self.check()?;
            fs::rename(&temporary, &self.path)
        })();
        let _ = fs::remove_file(&temporary);
        result?;
        Ok(vec![self.describe()])
    }
}

impl Installation for GlobalIntegration {
    type Error = io::Error;

    fn inspect(&self) -> Vec<Check> {
        vec![match self.check() {
            Ok(()) => Check::new(
                "PI_GLOBAL_INTEGRATION",
                CheckStatus::Pass,
                self.describe(),
                None,
            ),
            Err(error) => Check::new(
                "PI_GLOBAL_INTEGRATION",
                CheckStatus::Fail,
                error.to_string(),
                Some("Review the global Pi integration again"),
            ),
        }]
    }

    fn prepare(&mut self) -> io::Result<Vec<String>> {
        GlobalIntegration::prepare(self)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    struct Workspace {
        root: PathBuf,
        checkout: PathBuf,
        home: PathBuf,
        bridge: PathBuf,
    }
    impl Workspace {
        fn new() -> Self {
            let root = std::env::temp_dir().join(format!(
                "xper-integration-test-{}-{}",
                std::process::id(),
                NEXT_TEMPORARY.fetch_add(1, Ordering::Relaxed)
            ));
            let checkout = root.join("checkout # quoted");
            let home = root.join("pi-home");
            let bridge = root.join("bin/xper");
            fs::create_dir_all(bridge.parent().unwrap()).unwrap();
            fs::write(&bridge, "synthetic executable").unwrap();
            #[cfg(unix)]
            {
                use std::os::unix::fs::PermissionsExt;
                fs::set_permissions(&bridge, fs::Permissions::from_mode(0o755)).unwrap();
            }
            build(&checkout.join("adapters/pi"));
            Self {
                root,
                checkout,
                home,
                bridge,
            }
        }
        fn plan(&self) -> GlobalIntegration {
            GlobalIntegration::plan_at(&self.checkout, &self.home, &self.bridge).unwrap()
        }
        fn shim(&self) -> PathBuf {
            self.home.join("extensions/xper.ts")
        }
    }
    impl Drop for Workspace {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.root);
        }
    }
    fn build(path: &Path) {
        fs::create_dir_all(path.join("dist/inspection")).unwrap();
        fs::write(
            path.join("package.json"),
            json!({"name":"@xper/adapter-pi","version":env!("CARGO_PKG_VERSION")}).to_string(),
        )
        .unwrap();
        fs::write(path.join("dist/extension.js"), "synthetic extension").unwrap();
        fs::write(path.join("dist/inspection/cli.js"), "synthetic catalog").unwrap();
    }

    #[test]
    fn planning_is_read_only_and_preparation_is_managed_and_idempotent() {
        let workspace = Workspace::new();
        fs::create_dir_all(&workspace.home).unwrap();
        let settings = workspace.home.join("settings.json");
        fs::write(&settings, "{\"packages\":[\"custom\"]}\n").unwrap();
        let plan = workspace.plan();
        assert!(!workspace.shim().exists());
        assert!(
            plan.describe()
                .contains("Existing Pi settings are preserved")
        );
        assert_eq!(plan.prepare().unwrap().len(), 1);
        let text = fs::read_to_string(workspace.shim()).unwrap();
        assert!(text.starts_with(HEADER));
        assert!(text.contains("checkout%20%23%20quoted"));
        assert!(text.contains("process.env.XPER_BRIDGE_COMMAND"));
        let registration = registered_at(&workspace.home).unwrap().unwrap();
        assert_eq!(
            registration.adapter_root,
            workspace
                .checkout
                .join("adapters/pi")
                .canonicalize()
                .unwrap()
        );
        assert_eq!(
            registration.bridge,
            workspace.bridge.canonicalize().unwrap()
        );
        assert!(workspace.plan().prepare().unwrap().is_empty());
        assert_eq!(fs::read_to_string(workspace.shim()).unwrap(), text);
        assert_eq!(
            fs::read_to_string(settings).unwrap(),
            "{\"packages\":[\"custom\"]}\n"
        );
        assert!(!workspace.checkout.join(".xper").exists());
    }

    #[test]
    fn discovery_uses_managed_registration_and_old_package_without_source_tree_assumptions() {
        let workspace = Workspace::new();
        let unrelated = workspace.root.join("other-project");
        assert!(adapter_directory_at(&unrelated, &workspace.home).is_err());
        let installed = workspace.home.join("npm/node_modules/@xper/adapter-pi");
        build(&installed);
        assert_eq!(
            adapter_directory_at(&unrelated, &workspace.home).unwrap(),
            installed.canonicalize().unwrap()
        );
        workspace.plan().prepare().unwrap();
        assert_eq!(
            adapter_directory_at(&unrelated, &workspace.home).unwrap(),
            workspace
                .checkout
                .join("adapters/pi")
                .canonicalize()
                .unwrap()
        );
        fs::remove_file(
            workspace
                .checkout
                .join("adapters/pi/dist/inspection/cli.js"),
        )
        .unwrap();
        assert!(registered_at(&workspace.home).is_err());
        assert!(adapter_directory_at(&unrelated, &workspace.home).is_err());
    }

    #[test]
    fn incompatible_or_unbuilt_source_is_rejected_before_registration() {
        let workspace = Workspace::new();
        let directory = workspace.checkout.join("adapters/pi");
        for manifest in [
            json!({"name":"another-package","version":env!("CARGO_PKG_VERSION")}),
            json!({"name":"@xper/adapter-pi","version":"0.0.0"}),
        ] {
            fs::write(directory.join("package.json"), manifest.to_string()).unwrap();
            assert!(
                GlobalIntegration::plan_at(&workspace.checkout, &workspace.home, &workspace.bridge)
                    .is_err()
            );
            assert!(!workspace.shim().exists());
        }
        build(&directory);
        fs::remove_file(directory.join("dist/extension.js")).unwrap();
        assert!(
            GlobalIntegration::plan_at(&workspace.checkout, &workspace.home, &workspace.bridge)
                .is_err()
        );
        assert!(!workspace.shim().exists());
    }

    #[test]
    fn custom_modified_and_concurrently_created_shims_are_preserved() {
        let workspace = Workspace::new();
        let plan = workspace.plan();
        fs::create_dir_all(workspace.shim().parent().unwrap()).unwrap();
        fs::write(workspace.shim(), "export default function custom() {}\n").unwrap();
        assert!(plan.prepare().is_err());
        assert!(
            GlobalIntegration::plan_at(&workspace.checkout, &workspace.home, &workspace.bridge)
                .is_err()
        );
        assert_eq!(
            fs::read_to_string(workspace.shim()).unwrap(),
            "export default function custom() {}\n"
        );
        fs::remove_file(workspace.shim()).unwrap();
        workspace.plan().prepare().unwrap();
        let reviewed = workspace.plan();
        let modified = format!(
            "{}// custom addition\n",
            fs::read_to_string(workspace.shim()).unwrap()
        );
        fs::write(workspace.shim(), &modified).unwrap();
        assert!(reviewed.prepare().is_err());
        assert!(registered_at(&workspace.home).is_err());
        assert_eq!(fs::read_to_string(workspace.shim()).unwrap(), modified);
    }

    #[test]
    fn changed_managed_registration_requires_review_and_missing_targets_are_diagnosed() {
        let workspace = Workspace::new();
        workspace.plan().prepare().unwrap();
        let reviewed = workspace.plan();
        let replacement = Registration {
            adapter_root: reviewed.registration.adapter_root.clone(),
            bridge: workspace.root.join("removed-xper"),
        };
        let bytes = source(&replacement).unwrap();
        fs::write(workspace.shim(), &bytes).unwrap();
        assert!(registered_at(&workspace.home).is_err());
        assert!(
            reviewed
                .prepare()
                .unwrap_err()
                .to_string()
                .contains("changed after review")
        );
        assert_eq!(fs::read_to_string(workspace.shim()).unwrap(), bytes);
        // A new review from a usable checkout can repair an unchanged managed link.
        workspace.plan().prepare().unwrap();
        assert!(registered_at(&workspace.home).unwrap().is_some());
        fs::remove_file(&workspace.bridge).unwrap();
        assert!(
            registered_at(&workspace.home)
                .unwrap_err()
                .to_string()
                .contains("binary is missing")
        );
    }

    #[cfg(unix)]
    #[test]
    fn symlinks_are_refused_and_replacing_a_managed_shim_preserves_permissions() {
        use std::os::unix::fs::{PermissionsExt, symlink};
        let workspace = Workspace::new();
        let plan = workspace.plan();
        fs::create_dir_all(workspace.shim().parent().unwrap()).unwrap();
        symlink(workspace.root.join("missing"), workspace.shim()).unwrap();
        assert!(plan.prepare().is_err());
        assert!(
            fs::symlink_metadata(workspace.shim())
                .unwrap()
                .file_type()
                .is_symlink()
        );
        fs::remove_file(workspace.shim()).unwrap();
        workspace.plan().prepare().unwrap();
        fs::set_permissions(workspace.shim(), fs::Permissions::from_mode(0o640)).unwrap();
        let newer = workspace.root.join("new-checkout");
        build(&newer.join("adapters/pi"));
        GlobalIntegration::plan_at(&newer, &workspace.home, &workspace.bridge)
            .unwrap()
            .prepare()
            .unwrap();
        assert_eq!(
            fs::metadata(workspace.shim()).unwrap().permissions().mode() & 0o777,
            0o640
        );
        fs::set_permissions(&workspace.bridge, fs::Permissions::from_mode(0o644)).unwrap();
        assert!(
            registered_at(&workspace.home)
                .unwrap_err()
                .to_string()
                .contains("not executable")
        );
    }
}
