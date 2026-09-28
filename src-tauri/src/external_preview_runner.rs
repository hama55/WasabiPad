use std::collections::HashMap;
use std::fs::{self, DirBuilder, File};
use std::io;
use std::path::{Component, Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

const POLL_INTERVAL: Duration = Duration::from_millis(25);
const CANCEL_TOMBSTONE_TTL: Duration = Duration::from_secs(60);
const MAX_CANCEL_TOMBSTONES: usize = 256;
const JOB_PREFIX: &str = "external-preview-job-";
const JOB_MARKER: &str = ".wasabipad-external-preview-job";
const MAX_OUTPUT_FILES: usize = 256;
const MAX_OUTPUT_BYTES: u64 = 64 * 1024 * 1024;
static NEXT_JOB_ID: AtomicU64 = AtomicU64::new(0);

#[derive(Clone, Copy, Debug, serde::Deserialize, ts_rs::TS)]
#[serde(rename_all = "lowercase")]
#[ts(rename_all = "lowercase")]
#[ts(export)]
pub enum ExternalPreviewFormat {
    Html,
    Svg,
}

impl ExternalPreviewFormat {
    fn extension(self) -> &'static str {
        match self {
            Self::Html => "html",
            Self::Svg => "svg",
        }
    }
}

#[derive(Debug, serde::Deserialize, ts_rs::TS)]
#[serde(rename_all = "camelCase")]
#[ts(rename_all = "camelCase")]
#[ts(export)]
pub struct ExternalPreviewRequest {
    pub input_path: String,
    pub executable: String,
    pub args: Vec<String>,
    pub output_format: ExternalPreviewFormat,
    pub request_id: String,
}

#[derive(Debug)]
pub struct ExternalPreviewResult {
    pub output_path: PathBuf,
}

#[derive(Clone, Default)]
pub(crate) struct ExternalPreviewOperations {
    jobs: Arc<Mutex<JobRegistry>>,
}

impl ExternalPreviewOperations {
    pub(crate) fn register(
        &self,
        request_id: &str,
        input_path: &Path,
    ) -> Result<(Arc<AtomicBool>, PathBuf), String> {
        validate_request_id(request_id)?;
        let input_path = validate_input_path(input_path)?;
        let input_key = input_key(&input_path);
        let cancelled = {
            let mut jobs = self
                .jobs
                .lock()
                .map_err(|_| "External preview job registry is unavailable.".to_owned())?;
            jobs.prune_expired();
            if jobs.cancelled_before_start.remove(request_id).is_some() {
                return Err("External preview cancelled".to_owned());
            }
            if jobs.active.contains_key(request_id) || jobs.completed.contains_key(request_id) {
                return Err("An external preview with this request ID already exists.".to_owned());
            }
            if let Some(previous_id) = jobs.latest_by_input.get(&input_key).cloned() {
                if let Some(previous) = jobs.active.get(&previous_id) {
                    previous.cancelled.store(true, Ordering::Release);
                }
            }
            let cancelled = Arc::new(AtomicBool::new(false));
            jobs.active.insert(
                request_id.to_owned(),
                ActiveJob {
                    input_key: input_key.clone(),
                    cancelled: cancelled.clone(),
                },
            );
            jobs.latest_by_input
                .insert(input_key, request_id.to_owned());
            cancelled
        };
        Ok((cancelled, input_path))
    }

    pub(crate) fn cancel(&self, request_id: &str) -> Result<(), String> {
        let completed_path = {
            let mut jobs = self
                .jobs
                .lock()
                .map_err(|_| "External preview job registry is unavailable.".to_owned())?;
            jobs.prune_expired();
            if let Some(active) = jobs.active.get(request_id) {
                let input_key = active.input_key.clone();
                active.cancelled.store(true, Ordering::Release);
                if jobs
                    .latest_by_input
                    .get(&input_key)
                    .is_some_and(|id| id == request_id)
                {
                    jobs.latest_by_input.remove(&input_key);
                }
                None
            } else if let Some(completed) = jobs.completed.get(request_id) {
                Some(completed.output_path.clone())
            } else {
                validate_request_id(request_id)?;
                if jobs.cancelled_before_start.len() >= MAX_CANCEL_TOMBSTONES {
                    return Err("Too many pending external preview cancellations.".to_owned());
                }
                jobs.cancelled_before_start
                    .insert(request_id.to_owned(), Instant::now() + CANCEL_TOMBSTONE_TTL);
                None
            }
        };
        if let Some(path) = completed_path {
            cleanup_job(&path, &default_work_root())?;
            self.release_output(&path);
        }
        Ok(())
    }

    pub(crate) fn finish_success(
        &self,
        request_id: &str,
        cancelled: &Arc<AtomicBool>,
        output_path: &Path,
    ) -> Result<(), String> {
        let stale_reason = {
            let mut jobs = self
                .jobs
                .lock()
                .map_err(|_| "External preview job registry is unavailable.".to_owned())?;
            if !jobs
                .active
                .get(request_id)
                .is_some_and(|active| Arc::ptr_eq(&active.cancelled, cancelled))
            {
                Some("External preview generation was cancelled or superseded")
            } else {
                let active = jobs
                    .active
                    .remove(request_id)
                    .expect("active job was checked");
                let current = jobs
                    .latest_by_input
                    .get(&active.input_key)
                    .is_some_and(|id| id == request_id);
                if cancelled.load(Ordering::Acquire) || !current {
                    if current {
                        jobs.latest_by_input.remove(&active.input_key);
                    }
                    Some(if cancelled.load(Ordering::Acquire) {
                        "External preview cancelled"
                    } else {
                        "External preview generation was superseded"
                    })
                } else {
                    jobs.completed.insert(
                        request_id.to_owned(),
                        CompletedJob {
                            input_key: active.input_key,
                            output_path: output_path.to_path_buf(),
                        },
                    );
                    None
                }
            }
        };
        if let Some(reason) = stale_reason {
            let _ = cleanup_job(output_path, &default_work_root());
            return Err(reason.to_owned());
        }
        Ok(())
    }

    pub(crate) fn release_output(&self, output_path: &Path) {
        if let Ok(mut jobs) = self.jobs.lock() {
            let request_id = jobs.completed.iter().find_map(|(id, completed)| {
                (completed.output_path == output_path).then(|| id.clone())
            });
            if let Some(request_id) = request_id {
                if let Some(completed) = jobs.completed.remove(&request_id) {
                    if jobs
                        .latest_by_input
                        .get(&completed.input_key)
                        .is_some_and(|id| id == &request_id)
                    {
                        jobs.latest_by_input.remove(&completed.input_key);
                    }
                }
            }
        }
    }

    pub(crate) fn guard(&self, request_id: String, cancelled: Arc<AtomicBool>) -> ActiveJobGuard {
        ActiveJobGuard::new(self.jobs.clone(), request_id, cancelled)
    }
}

#[derive(Default)]
struct JobRegistry {
    active: HashMap<String, ActiveJob>,
    cancelled_before_start: HashMap<String, Instant>,
    latest_by_input: HashMap<String, String>,
    completed: HashMap<String, CompletedJob>,
}

struct ActiveJob {
    input_key: String,
    cancelled: Arc<AtomicBool>,
}

struct CompletedJob {
    input_key: String,
    output_path: PathBuf,
}

impl JobRegistry {
    fn finish(&mut self, request_id: &str, cancelled: &Arc<AtomicBool>) {
        if self
            .active
            .get(request_id)
            .is_some_and(|active| Arc::ptr_eq(&active.cancelled, cancelled))
        {
            if let Some(active) = self.active.remove(request_id) {
                if self
                    .latest_by_input
                    .get(&active.input_key)
                    .is_some_and(|id| id == request_id)
                {
                    self.latest_by_input.remove(&active.input_key);
                }
            }
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
    fn new(
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

pub(crate) fn default_work_root() -> PathBuf {
    std::env::temp_dir()
        .join("WasabiPad")
        .join("external-preview")
}

pub(crate) fn cleanup_stale_jobs(work_root: &Path) -> Result<(), String> {
    let root = absolute_path(work_root)
        .map_err(|error| format!("Could not resolve external preview work root: {error}"))?;
    if !root.exists() {
        return Ok(());
    }
    let root = canonical_directory(&root, "external preview work root")?;
    for entry in fs::read_dir(&root)
        .map_err(|error| format!("Could not inspect external preview work root: {error}"))?
    {
        let entry =
            entry.map_err(|error| format!("Could not inspect external preview job: {error}"))?;
        let path = entry.path();
        if !entry
            .file_type()
            .map_err(|error| format!("Could not inspect external preview job: {error}"))?
            .is_dir()
        {
            continue;
        }
        let Some(owner_pid) = job_owner_pid(&path) else {
            continue;
        };
        match fs::symlink_metadata(path.join(JOB_MARKER)) {
            Ok(metadata) if metadata.file_type().is_file() => {}
            Err(error) if error.kind() == io::ErrorKind::NotFound => {}
            _ => continue,
        }
        if process_is_running(owner_pid) {
            // PID reuse can retain an orphan until that unrelated process exits; never risk a live viewer.
            continue;
        }
        fs::remove_dir_all(path)
            .map_err(|error| format!("Could not clean stale external preview job: {error}"))?;
    }
    Ok(())
}

fn job_owner_pid(path: &Path) -> Option<u32> {
    let mut parts = path
        .file_name()?
        .to_str()?
        .strip_prefix(JOB_PREFIX)?
        .split('-');
    let pid = parts.next()?.parse().ok()?;
    parts.next()?.parse::<u128>().ok()?;
    parts.next()?.parse::<u64>().ok()?;
    parts.next().is_none().then_some(pid)
}

fn process_is_running(pid: u32) -> bool {
    if pid == 0 {
        return false;
    }

    #[cfg(windows)]
    {
        use windows_sys::Win32::Foundation::{
            CloseHandle, GetLastError, ERROR_INVALID_PARAMETER, WAIT_OBJECT_0, WAIT_TIMEOUT,
        };
        use windows_sys::Win32::System::Threading::{
            OpenProcess, WaitForSingleObject, PROCESS_SYNCHRONIZE,
        };

        // Unknown access/wait failures are treated as live so startup cleanup cannot delete
        // another process's potentially displayed output.
        unsafe {
            let process = OpenProcess(PROCESS_SYNCHRONIZE, 0, pid);
            if process.is_null() {
                return GetLastError() != ERROR_INVALID_PARAMETER;
            }
            let status = WaitForSingleObject(process, 0);
            CloseHandle(process);
            match status {
                WAIT_OBJECT_0 => false,
                WAIT_TIMEOUT => true,
                _ => true,
            }
        }
    }

    #[cfg(unix)]
    {
        let Ok(pid) = libc::pid_t::try_from(pid) else {
            return false;
        };
        // EPERM means the process exists but cannot be queried; only ESRCH proves it is gone.
        unsafe {
            libc::kill(pid, 0) == 0
                || io::Error::last_os_error().raw_os_error() != Some(libc::ESRCH)
        }
    }

    #[cfg(not(any(windows, unix)))]
    {
        // Conservatively preserve output when this target has no process-liveness probe.
        true
    }
}

pub fn run_external_preview(
    executable: &Path,
    args: &[String],
    input_path: &Path,
    output_format: ExternalPreviewFormat,
    work_root: &Path,
    timeout: Duration,
    cancelled: &AtomicBool,
) -> Result<ExternalPreviewResult, String> {
    if cancelled.load(Ordering::Acquire) {
        return Err("External preview cancelled".to_owned());
    }
    let input_path = validate_input_path(input_path)?;
    validate_executable(executable)?;
    let mut job = create_job_directory(work_root)?;
    let output_path = job
        .path
        .join(format!("index.{}", output_format.extension()));
    let resolved_args = args
        .iter()
        .map(|arg| replace_template(arg, &input_path, &output_path))
        .collect::<Vec<_>>();

    let mut command = Command::new(executable);
    command
        .args(resolved_args)
        .current_dir(&job.path)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null());

    if cancelled.load(Ordering::Acquire) {
        return Err("External preview cancelled".to_owned());
    }
    let mut child = command
        .spawn()
        .map_err(|error| format!("Could not start external preview: {error}"))?;
    let started = Instant::now();
    let status = loop {
        if cancelled.load(Ordering::Acquire) {
            return Err(stop_child(
                &mut child,
                "External preview cancelled".to_owned(),
            ));
        }
        if started.elapsed() >= timeout {
            return Err(stop_child(
                &mut child,
                format!("External preview timed out after {timeout:?}"),
            ));
        }
        match child.try_wait() {
            Ok(Some(status)) => break status,
            Ok(None) => {
                if let Err(error) = check_output_limits(&job.path, &job.canonical_path) {
                    return Err(stop_child(&mut child, error));
                }
                thread::sleep(POLL_INTERVAL);
            }
            Err(error) => {
                return Err(stop_child(
                    &mut child,
                    format!("Could not wait for external preview: {error}"),
                ));
            }
        }
    };

    if cancelled.load(Ordering::Acquire) {
        return Err("External preview cancelled".to_owned());
    }
    if !status.success() {
        return Err(format!("External preview exited with {status}"));
    }
    check_output_limits(&job.path, &job.canonical_path)?;
    let output_path = verify_output(&output_path, &job.canonical_path)?;
    if cancelled.load(Ordering::Acquire) {
        return Err("External preview cancelled".to_owned());
    }
    job.keep = true;
    Ok(ExternalPreviewResult { output_path })
}

pub fn cleanup_job(output_path: &Path, work_root: &Path) -> Result<(), String> {
    let root = canonical_directory(work_root, "external preview work root")?;
    let job_path = output_path
        .parent()
        .ok_or_else(|| "External preview output has no job directory".to_owned())?;
    if !job_path.exists() {
        return Ok(());
    }
    let job = canonical_directory(job_path, "external preview job directory")?;
    if job.parent() != Some(root.as_path())
        || job_owner_pid(&job).is_none()
        || !is_regular_file(&job.join(JOB_MARKER))
    {
        return Err("Refusing to delete a non-WasabiPad external preview directory".to_owned());
    }
    fs::remove_dir_all(job)
        .map_err(|error| format!("Could not clean external preview job: {error}"))
}

fn validate_input_path(path: &Path) -> Result<PathBuf, String> {
    if !path.is_absolute() {
        return Err("External preview input path must be absolute".to_owned());
    }
    let canonical = fs::canonicalize(path)
        .map_err(|error| format!("Could not resolve external preview input: {error}"))?;
    if !is_regular_file(&canonical) {
        return Err("External preview input is not a regular file".to_owned());
    }
    Ok(canonical)
}

fn input_key(path: &Path) -> String {
    let value = path.to_string_lossy().into_owned();
    if cfg!(windows) {
        value.to_ascii_lowercase()
    } else {
        value
    }
}

fn validate_executable(executable: &Path) -> Result<(), String> {
    if executable.as_os_str().is_empty()
        || executable.to_string_lossy().chars().any(char::is_control)
    {
        return Err(
            "External preview executable is empty or contains control characters".to_owned(),
        );
    }
    if executable.is_absolute()
        || executable
            .components()
            .eq([Component::Normal(executable.as_os_str())].into_iter())
    {
        Ok(())
    } else {
        Err("External preview executable must be an absolute path or a PATH command".to_owned())
    }
}

fn replace_template(template: &str, input_path: &Path, output_path: &Path) -> String {
    template
        .replace("{file}", &input_path.to_string_lossy())
        .replace("{output}", &output_path.to_string_lossy())
}

struct JobDirectory {
    path: PathBuf,
    canonical_path: PathBuf,
    keep: bool,
}

impl Drop for JobDirectory {
    fn drop(&mut self) {
        if !self.keep {
            let _ = fs::remove_dir_all(&self.path);
        }
    }
}

fn create_job_directory(work_root: &Path) -> Result<JobDirectory, String> {
    let root = absolute_path(work_root)
        .map_err(|error| format!("Could not resolve external preview work root: {error}"))?;
    fs::create_dir_all(&root)
        .map_err(|error| format!("Could not create external preview work root: {error}"))?;
    let canonical_root = canonical_directory(&root, "external preview work root")?;
    #[cfg(unix)]
    let builder = {
        use std::os::unix::fs::DirBuilderExt;
        let mut builder = DirBuilder::new();
        builder.mode(0o700);
        builder
    };
    #[cfg(not(unix))]
    let builder = DirBuilder::new();

    for _ in 0..32 {
        let timestamp = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_nanos();
        let id = NEXT_JOB_ID.fetch_add(1, Ordering::Relaxed);
        let path = root.join(format!(
            "{JOB_PREFIX}{}-{timestamp}-{id}",
            std::process::id()
        ));
        match builder.create(&path) {
            Ok(()) => {
                let canonical_path = fs::canonicalize(&path).map_err(|error| {
                    format!("Could not resolve external preview job directory: {error}")
                })?;
                if !canonical_path.starts_with(&canonical_root) {
                    let _ = fs::remove_dir_all(&path);
                    return Err("External preview job directory escaped its work root".to_owned());
                }
                if let Err(error) = create_job_marker(&path) {
                    let _ = fs::remove_dir_all(&path);
                    return Err(error);
                }
                return Ok(JobDirectory {
                    path,
                    canonical_path,
                    keep: false,
                });
            }
            Err(error) if error.kind() == io::ErrorKind::AlreadyExists => continue,
            Err(error) => {
                return Err(format!(
                    "Could not create external preview job directory: {error}"
                ));
            }
        }
    }
    Err("Could not reserve a unique external preview job directory".to_owned())
}

fn create_job_marker(path: &Path) -> Result<(), String> {
    File::create_new(path.join(JOB_MARKER))
        .map(|_| ())
        .map_err(|error| format!("Could not mark external preview job directory: {error}"))
}

fn verify_output(path: &Path, canonical_job: &Path) -> Result<PathBuf, String> {
    // This is the WasabiPad-side guarantee: the entry output exists as a regular file in this job.
    // HTML validity and application-specific meaning belong to the external adapter/browser.
    let canonical = fs::canonicalize(path)
        .map_err(|error| format!("External preview output is missing: {error}"))?;
    if !canonical.starts_with(canonical_job) || !is_regular_file(&canonical) {
        return Err("External preview output is outside its job directory".to_owned());
    }
    Ok(canonical)
}

fn check_output_limits(job_root: &Path, canonical_job_root: &Path) -> Result<(), String> {
    let mut directories = vec![job_root.to_path_buf()];
    let mut file_count = 0usize;
    let mut total_bytes = 0u64;

    while let Some(directory) = directories.pop() {
        for entry in fs::read_dir(&directory)
            .map_err(|error| format!("Could not list external preview output: {error}"))?
        {
            let entry = entry
                .map_err(|error| format!("Could not inspect external preview output: {error}"))?;
            let path = entry.path();
            if path == job_root.join(JOB_MARKER) {
                continue;
            }

            let metadata = fs::symlink_metadata(&path)
                .map_err(|error| format!("Could not inspect external preview output: {error}"))?;
            if metadata.file_type().is_symlink() {
                return Err("External preview output contains a symbolic link".to_owned());
            }
            let canonical_path = fs::canonicalize(&path)
                .map_err(|error| format!("Could not resolve external preview output: {error}"))?;
            if !canonical_path.starts_with(canonical_job_root) {
                return Err("External preview output escaped its job directory".to_owned());
            }

            if metadata.is_dir() {
                directories.push(path);
            } else if metadata.is_file() {
                file_count += 1;
                if file_count > MAX_OUTPUT_FILES {
                    return Err(format!(
                        "External preview produced more than {MAX_OUTPUT_FILES} output files"
                    ));
                }
                total_bytes = total_bytes
                    .checked_add(metadata.len())
                    .ok_or_else(|| "External preview output size overflowed".to_owned())?;
                if total_bytes > MAX_OUTPUT_BYTES {
                    return Err(format!(
                        "External preview outputs exceed the {} MiB byte limit",
                        MAX_OUTPUT_BYTES / (1024 * 1024)
                    ));
                }
            } else {
                return Err("External preview output contains a non-file entry".to_owned());
            }
        }
    }

    Ok(())
}

fn canonical_directory(path: &Path, label: &str) -> Result<PathBuf, String> {
    let canonical =
        fs::canonicalize(path).map_err(|error| format!("Could not resolve {label}: {error}"))?;
    if !canonical.is_dir() {
        return Err(format!("{label} is not a directory"));
    }
    Ok(canonical)
}

fn is_regular_file(path: &Path) -> bool {
    fs::symlink_metadata(path)
        .map(|metadata| metadata.file_type().is_file())
        .unwrap_or(false)
}

fn absolute_path(path: &Path) -> io::Result<PathBuf> {
    if path.is_absolute() {
        Ok(path.to_path_buf())
    } else {
        Ok(std::env::current_dir()?.join(path))
    }
}

fn stop_child(child: &mut Child, reason: String) -> String {
    terminate_child(child);
    let wait_error = child.wait().err();
    if let Some(error) = wait_error {
        format!("{reason}; could not reap external preview process: {error}")
    } else {
        reason
    }
}

#[cfg(windows)]
fn terminate_child(child: &mut Child) {
    let id = child.id().to_string();
    let _ = Command::new("taskkill")
        .args(["/PID", &id, "/T", "/F"])
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status();
    let _ = child.kill();
}

#[cfg(not(windows))]
fn terminate_child(child: &mut Child) {
    let _ = child.kill();
}

fn validate_request_id(request_id: &str) -> Result<(), String> {
    if request_id.is_empty() || request_id.len() > 128 || request_id.chars().any(char::is_control) {
        return Err(
            "External preview request ID must contain 1 to 128 printable characters.".into(),
        );
    }
    Ok(())
}
