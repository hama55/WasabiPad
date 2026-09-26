use std::collections::HashMap;
use std::env;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

const CANCEL_TOMBSTONE_TTL: Duration = Duration::from_secs(60);
const MAX_CANCEL_TOMBSTONES: usize = 256;

pub(crate) const CANCELLED_MESSAGE: &str = "LilyPond generation cancelled";

pub(crate) fn local_addon_status(
    app_data_root: &Path,
    id: &str,
) -> Result<super::addin_manager::LocalAddonStatus, String> {
    super::addin_manager::list_local_status(app_data_root)?
        .into_iter()
        .find(|status| status.id == id)
        .ok_or_else(|| format!("unsupported official addin id: {id}"))
}

pub(crate) fn configured_lilypond_path(settings_json: &str) -> Result<Option<String>, String> {
    let settings = serde_json::from_str::<serde_json::Value>(settings_json)
        .map_err(|error| format!("Could not read LilyPond settings: {error}"))?;
    match settings.get("lilypondExecutablePath") {
        None | Some(serde_json::Value::Null) => Ok(None),
        Some(serde_json::Value::String(path)) if path.trim().is_empty() => Ok(None),
        Some(serde_json::Value::String(path)) => Ok(Some(path.clone())),
        Some(_) => Err(
            "The LilyPond executable setting is invalid. Set lilypondExecutablePath to a file path or null."
                .into(),
        ),
    }
}

pub(crate) fn resolve_lilypond_executable(
    configured_path: Option<&str>,
    candidates: &[PathBuf],
) -> Result<PathBuf, String> {
    if let Some(configured_path) = configured_path.filter(|path| !path.trim().is_empty()) {
        let path = PathBuf::from(configured_path);
        return existing_executable(&path).ok_or_else(|| {
            format!(
                "The configured LilyPond executable was not found: {}. Update lilypondExecutablePath in Settings.",
                path.display()
            )
        });
    }
    candidates
        .iter()
        .find_map(|path| existing_executable(path))
        .ok_or_else(|| {
            "LilyPond was not found on PATH or in common install folders. Set lilypondExecutablePath in Settings."
                .into()
        })
}

fn existing_executable(path: &Path) -> Option<PathBuf> {
    if !path.is_file() {
        return None;
    }
    std::fs::canonicalize(path).ok()
}

pub(crate) fn lilypond_executable_candidates() -> Vec<PathBuf> {
    let names: &[&str] = if cfg!(windows) {
        &["lilypond.exe", "lilypond"]
    } else {
        &["lilypond"]
    };
    let mut directories = env::var_os("PATH")
        .map(|path| env::split_paths(&path).collect::<Vec<_>>())
        .unwrap_or_default();

    #[cfg(windows)]
    for variable in ["ProgramFiles", "ProgramFiles(x86)"] {
        if let Some(root) = env::var_os(variable).map(PathBuf::from) {
            for name in [
                "LilyPond/bin",
                "LilyPond/usr/bin",
                "LilyPond (64-bit)/bin",
                "LilyPond (64-bit)/usr/bin",
            ] {
                directories.push(root.join(name));
            }
        }
    }
    #[cfg(windows)]
    if let Some(local_app_data) = env::var_os("LOCALAPPDATA").map(PathBuf::from) {
        for name in [
            "LilyPond/bin",
            "LilyPond/usr/bin",
            "Programs/LilyPond/bin",
            "Programs/LilyPond/usr/bin",
        ] {
            directories.push(local_app_data.join(name));
        }
    }

    directories
        .into_iter()
        .flat_map(|directory| names.iter().map(move |name| directory.join(name)))
        .collect()
}

pub(crate) fn saved_source_path(value: Option<String>) -> Result<Option<PathBuf>, String> {
    value
        .map(|value| {
            let path = PathBuf::from(value);
            if path.is_absolute() {
                Ok(path)
            } else {
                Err("Save this LilyPond document before using relative source paths.".to_owned())
            }
        })
        .transpose()
}

#[derive(Default)]
pub(crate) struct JobRegistry {
    active: HashMap<String, Arc<AtomicBool>>,
    cancelled_before_start: HashMap<String, Instant>,
}

#[derive(Clone, Default)]
pub(crate) struct MusicOperations {
    pub(crate) manager_lock: Arc<Mutex<()>>,
    pub(crate) jobs: Arc<Mutex<JobRegistry>>,
}

impl JobRegistry {
    pub(crate) fn register(&mut self, request_id: &str) -> Result<Arc<AtomicBool>, String> {
        validate_request_id(request_id)?;
        self.prune_expired();
        if self.cancelled_before_start.remove(request_id).is_some() {
            return Err(CANCELLED_MESSAGE.into());
        }
        if self.active.contains_key(request_id) {
            return Err("A LilyPond generation with this request ID is already running.".into());
        }
        let cancelled = Arc::new(AtomicBool::new(false));
        self.active.insert(request_id.to_owned(), cancelled.clone());
        Ok(cancelled)
    }

    pub(crate) fn cancel(&mut self, request_id: &str) -> Result<(), String> {
        validate_request_id(request_id)?;
        self.prune_expired();
        if let Some(cancelled) = self.active.get(request_id) {
            cancelled.store(true, Ordering::Release);
            return Ok(());
        }
        if self.cancelled_before_start.len() >= MAX_CANCEL_TOMBSTONES {
            return Err("Too many pending LilyPond cancellations.".into());
        }
        self.cancelled_before_start
            .insert(request_id.to_owned(), Instant::now() + CANCEL_TOMBSTONE_TTL);
        Ok(())
    }

    pub(crate) fn finish(&mut self, request_id: &str, cancelled: &Arc<AtomicBool>) {
        if self
            .active
            .get(request_id)
            .is_some_and(|active| Arc::ptr_eq(active, cancelled))
        {
            self.active.remove(request_id);
        }
        self.prune_expired();
    }

    fn prune_expired(&mut self) {
        let now = Instant::now();
        self.cancelled_before_start
            .retain(|_, expires_at| *expires_at > now);
    }
}

pub(crate) struct ActiveJobGuard {
    registry: Arc<Mutex<JobRegistry>>,
    request_id: String,
    cancelled: Arc<AtomicBool>,
}

impl ActiveJobGuard {
    pub(crate) fn new(
        registry: Arc<Mutex<JobRegistry>>,
        request_id: String,
        cancelled: Arc<AtomicBool>,
    ) -> Self {
        Self {
            registry,
            request_id,
            cancelled,
        }
    }
}

impl Drop for ActiveJobGuard {
    fn drop(&mut self) {
        if let Ok(mut registry) = self.registry.lock() {
            registry.finish(&self.request_id, &self.cancelled);
        }
    }
}

fn validate_request_id(request_id: &str) -> Result<(), String> {
    if request_id.is_empty() || request_id.len() > 128 || request_id.chars().any(char::is_control) {
        return Err("LilyPond request ID must contain 1 to 128 printable characters.".into());
    }
    Ok(())
}
