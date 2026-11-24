use sha2::{Digest, Sha256};
use std::collections::{HashMap, HashSet};
use std::fs::{self, DirBuilder, File};
use std::io::{self, Read, Seek, SeekFrom};
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
const MAX_CAPTURED_STREAM_BYTES: usize = 64 * 1024;
const STDOUT_CAPTURE_FILE: &str = ".wasabipad-stdout.log";
const STDERR_CAPTURE_FILE: &str = ".wasabipad-stderr.log";
#[cfg(windows)]
const CREATE_NO_WINDOW: u32 = 0x08000000;
static NEXT_JOB_ID: AtomicU64 = AtomicU64::new(0);

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, serde::Serialize, serde::Deserialize, ts_rs::TS)]
#[serde(rename_all = "lowercase")]
#[ts(rename_all = "lowercase")]
#[ts(export)]
pub enum ExternalPreviewFormat {
    Html,
    Svg,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ExternalPreviewConfigKey {
    pub executable: String,
    pub args: Vec<String>,
    pub output_format: ExternalPreviewFormat,
}

impl ExternalPreviewConfigKey {
    pub fn normalized(
        executable: &str,
        args: &[String],
        output_format: ExternalPreviewFormat,
    ) -> Self {
        Self {
            executable: executable.trim().to_owned(),
            args: args.to_vec(),
            output_format,
        }
    }
}

pub fn hash_input_file(path: &Path) -> Result<[u8; 32], String> {
    let mut file = File::open(path)
        .map_err(|error| format!("Could not read external preview input for hashing: {error}"))?;
    let mut hasher = Sha256::new();
    let mut buffer = [0u8; 64 * 1024];
    loop {
        let read = file
            .read(&mut buffer)
            .map_err(|error| format!("Could not read external preview input for hashing: {error}"))?;
        if read == 0 {
            break;
        }
        hasher.update(&buffer[..read]);
    }
    let digest = hasher.finalize();
    let mut out = [0u8; 32];
    out.copy_from_slice(&digest);
    Ok(out)
}

impl ExternalPreviewFormat {
    fn extension(self) -> &'static str {
        match self {
            Self::Html => "html",
            Self::Svg => "svg",
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, serde::Serialize, ts_rs::TS)]
#[serde(rename_all = "lowercase")]
#[ts(rename_all = "lowercase")]
#[ts(export)]
pub enum ExternalPreviewSourceKind {
    Saved,
    Sibling,
    Temporary,
}

#[allow(dead_code)]
#[derive(Debug, serde::Deserialize, ts_rs::TS)]
#[serde(rename_all = "camelCase")]
#[ts(rename_all = "camelCase")]
#[ts(export)]
pub struct ExternalPreviewResolveRequest {
    pub adapter_id: String,
    pub input_path: String,
    pub executable: String,
    pub args: Vec<String>,
    pub output_format: ExternalPreviewFormat,
}

#[allow(dead_code)]
#[derive(Clone, Debug, PartialEq, Eq, serde::Serialize, ts_rs::TS)]
#[serde(rename_all = "camelCase")]
#[ts(rename_all = "camelCase")]
#[ts(export)]
pub struct ExternalPreviewResolved {
    pub kind: ExternalPreviewSourceKind,
    pub output_path: String,
}

#[allow(dead_code)]
#[derive(Clone, Debug, PartialEq, Eq, serde::Serialize, ts_rs::TS)]
#[serde(tag = "kind", rename_all = "lowercase")]
#[ts(export)]
pub enum ExternalPreviewSaveOutcome {
    Saved { output_path: String },
    OverwriteRequired { directory_path: String },
}

#[allow(dead_code)]
pub(crate) fn saved_preview_dir(input_path: &Path) -> Option<PathBuf> {
    let parent = input_path.parent()?;
    let file_name = input_path.file_name()?.to_str()?;
    if file_name.is_empty() {
        return None;
    }
    Some(parent.join(format!("{file_name}.wasabi-preview")))
}

#[allow(dead_code)]
pub(crate) fn saved_output(
    input_path: &Path,
    format: ExternalPreviewFormat,
) -> Result<Option<PathBuf>, String> {
    let canonical_input = validate_input_path(input_path)?;
    let Some(saved_dir) = saved_preview_dir(input_path) else {
        return Ok(None);
    };
    let meta = match fs::symlink_metadata(&saved_dir) {
        Ok(meta) => meta,
        Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(None),
        Err(error) => {
            return Err(format!(
                "Could not inspect saved external preview directory: {error}"
            ))
        }
    };
    if is_symlink_or_reparse_point(&meta) {
        return Err("保存済み外部プレビューのフォルダにシンボリックリンクは使用できません".to_owned());
    }
    if !meta.is_dir() {
        return Ok(None);
    }
    let canonical_parent = canonical_input
        .parent()
        .ok_or_else(|| "External preview input has no parent directory".to_owned())?;
    let canonical_saved_dir = canonical_directory(&saved_dir, "saved external preview directory")?;
    if !canonical_saved_dir.starts_with(canonical_parent) {
        return Err("保存済み外部プレビューのフォルダが親フォルダ外を参照しています".to_owned());
    }
    let entry_path = saved_dir.join(format!("index.{}", format.extension()));
    let entry_meta = match fs::symlink_metadata(&entry_path) {
        Ok(meta) => meta,
        Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(None),
        Err(error) => {
            return Err(format!(
                "Could not inspect saved external preview entry: {error}"
            ))
        }
    };
    if is_symlink_or_reparse_point(&entry_meta) {
        return Err("保存済み外部プレビューの入口ファイルにシンボリックリンクは使用できません".to_owned());
    }
    if !entry_meta.is_file() {
        return Ok(None);
    }
    validate_output_tree_with_marker(
        &saved_dir,
        &canonical_saved_dir,
        &AtomicBool::new(false),
        false,
    )?;
    let _ = verify_output(&entry_path, &canonical_saved_dir)?;
    Ok(Some(strip_windows_verbatim_prefix_local(&entry_path)))
}

pub(crate) fn existing_output(input_path: &Path, format: ExternalPreviewFormat) -> Option<PathBuf> {
    let output = input_path.with_extension(format.extension());
    if !output.is_file() {
        return None;
    }
    let input = input_path.canonicalize().ok()?;
    let canonical_output = output.canonicalize().ok()?;
    (input != canonical_output).then_some(output)
}

#[allow(dead_code)]
#[derive(Debug, serde::Deserialize, ts_rs::TS)]
#[serde(rename_all = "camelCase")]
#[ts(rename_all = "camelCase")]
#[ts(export)]
pub struct ExternalPreviewRequest {
    pub adapter_id: String,
    pub input_path: String,
    pub executable: String,
    pub args: Vec<String>,
    pub output_format: ExternalPreviewFormat,
    pub request_id: String,
    pub work_root: Option<String>,
}

#[derive(Debug)]
pub struct ExternalPreviewResult {
    pub output_path: PathBuf,
}

struct CapturedStream {
    bytes: Vec<u8>,
    truncated: bool,
    error: Option<String>,
}

fn capture_stream(path: &Path) -> Option<CapturedStream> {
    let mut stream = match File::open(path) {
        Ok(stream) => stream,
        Err(error) if error.kind() == io::ErrorKind::NotFound => return None,
        Err(error) => {
            return Some(CapturedStream {
                bytes: Vec::new(),
                truncated: false,
                error: Some(error.to_string()),
            })
        }
    };
    let length = match stream.metadata() {
        Ok(metadata) => metadata.len(),
        Err(error) => {
            return Some(CapturedStream {
                bytes: Vec::new(),
                truncated: false,
                error: Some(error.to_string()),
            })
        }
    };
    let mut captured = CapturedStream {
        bytes: Vec::new(),
        truncated: length > MAX_CAPTURED_STREAM_BYTES as u64,
        error: None,
    };
    if let Err(error) = stream.seek(SeekFrom::Start(
        length.saturating_sub(MAX_CAPTURED_STREAM_BYTES as u64),
    )) {
        captured.error = Some(error.to_string());
        return Some(captured);
    }
    if let Err(error) = stream
        .take(MAX_CAPTURED_STREAM_BYTES as u64)
        .read_to_end(&mut captured.bytes)
    {
        captured.error = Some(error.to_string());
    }
    Some(captured)
}

fn external_preview_error_with_output(
    message: String,
    (stdout, stderr): (Option<CapturedStream>, Option<CapturedStream>),
) -> String {
    let mut error = message;
    append_captured_stream(&mut error, "stdout", stdout);
    append_captured_stream(&mut error, "stderr", stderr);
    error
}

fn append_captured_stream(error: &mut String, name: &str, stream: Option<CapturedStream>) {
    let Some(stream) = stream else { return };
    if stream.bytes.is_empty() && !stream.truncated && stream.error.is_none() {
        return;
    }
    error.push_str(&format!("\n\n[{name}]\n"));
    if stream.truncated {
        error.push_str("... earlier output omitted ...\n");
    }
    error.push_str(&String::from_utf8_lossy(&stream.bytes));
    if stream.bytes.last().is_some_and(|byte| *byte != b'\n') {
        error.push('\n');
    }
    if let Some(read_error) = stream.error {
        error.push_str(&format!("[Could not read output: {read_error}]\n"));
    }
}

#[derive(Clone, Default)]
pub(crate) struct ExternalPreviewOperations {
    jobs: Arc<Mutex<JobRegistry>>,
    cleaned_work_roots: Arc<Mutex<HashSet<PathBuf>>>,
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
                Some((completed.output_path.clone(), completed.work_root.clone()))
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
        if let Some((path, work_root)) = completed_path {
            cleanup_job(&path, &work_root)?;
            self.release_output(&path);
        }
        Ok(())
    }

    pub(crate) fn cleanup_output(&self, output_path: &Path) -> Result<(), String> {
        let target = {
            let jobs = self
                .jobs
                .lock()
                .map_err(|_| "External preview job registry is unavailable.".to_owned())?;
            let canonical_target = fs::canonicalize(output_path).ok();
            jobs.completed
                .values()
                .find(|completed| {
                    completed.output_path == output_path
                        || canonical_target
                            .as_ref()
                            .is_some_and(|c| &completed.canonical_output_path == c)
                })
                .map(|completed| (completed.output_path.clone(), completed.work_root.clone()))
        };
        let Some((managed_output, work_root)) = target else {
            return Ok(());
        };
        cleanup_job(&managed_output, &work_root)?;
        self.release_output(&managed_output);
        Ok(())
    }

    #[allow(dead_code)]
    pub(crate) fn cleanup_retired_output(&self, output_path: &Path) -> Result<(), String> {
        let canonical_target = fs::canonicalize(output_path).ok();
        let is_session_retained = {
            let jobs = self
                .jobs
                .lock()
                .map_err(|_| "External preview job registry is unavailable.".to_owned())?;
            jobs.session_outputs.values().any(|session| {
                session.output_path == output_path
                    || canonical_target
                        .as_ref()
                        .is_some_and(|c| &session.canonical_output_path == c)
            })
        };
        if is_session_retained {
            return Ok(());
        }
        self.cleanup_output(output_path)
    }

    #[allow(dead_code)]
    pub(crate) fn discard_output(&self, output_path: &Path) -> Result<(), String> {
        let canonical_target = fs::canonicalize(output_path).ok();
        {
            let mut jobs = self
                .jobs
                .lock()
                .map_err(|_| "External preview job registry is unavailable.".to_owned())?;
            jobs.session_outputs.retain(|_, session| {
                !(session.output_path == output_path
                    || canonical_target
                        .as_ref()
                        .is_some_and(|c| &session.canonical_output_path == c))
            });
        }
        self.cleanup_output(output_path)
    }

    #[allow(dead_code)]
    pub(crate) fn cleanup_all(&self) -> Result<(), String> {
        let targets: Vec<(PathBuf, PathBuf)> = {
            let mut jobs = self
                .jobs
                .lock()
                .map_err(|_| "External preview job registry is unavailable.".to_owned())?;
            for active in jobs.active.values() {
                active.cancelled.store(true, Ordering::Release);
            }
            let mut seen = HashSet::new();
            let mut collected = Vec::new();
            for completed in jobs.completed.drain().map(|(_, v)| v) {
                if seen.insert(completed.canonical_output_path.clone()) {
                    collected.push((completed.output_path, completed.work_root));
                }
            }
            for session in jobs.session_outputs.drain().map(|(_, v)| v) {
                if seen.insert(session.canonical_output_path.clone()) {
                    collected.push((session.output_path, session.work_root));
                }
            }
            jobs.latest_by_input.clear();
            jobs.cancelled_before_start.clear();
            collected
        };

        let mut errors = Vec::new();
        for (output_path, work_root) in targets {
            if let Err(error) = cleanup_job(&output_path, &work_root) {
                errors.push(error);
            }
        }
        if errors.is_empty() {
            Ok(())
        } else {
            Err(errors.join("; "))
        }
    }

    #[allow(dead_code)]
    pub(crate) fn lookup_session_output(
        &self,
        input_path: &Path,
        executable: &str,
        args: &[String],
        output_format: ExternalPreviewFormat,
    ) -> Result<Option<PathBuf>, String> {
        let canonical_input = validate_input_path(input_path)?;
        let key = input_key(&canonical_input);
        let candidate = {
            let jobs = self
                .jobs
                .lock()
                .map_err(|_| "External preview job registry is unavailable.".to_owned())?;
            jobs.session_outputs.get(&key).cloned()
        };
        let Some(entry) = candidate else {
            return Ok(None);
        };
        let requested_config = ExternalPreviewConfigKey::normalized(executable, args, output_format);
        if entry.config != requested_config {
            return Ok(None);
        }
        let current_sha256 = hash_input_file(&canonical_input)?;
        if entry.input_sha256 != current_sha256 {
            return Ok(None);
        }
        let valid = entry
            .output_path
            .parent()
            .and_then(|job_dir| {
                let canonical_job = canonical_directory(job_dir, "external preview job directory").ok()?;
                validate_output_tree(job_dir, &canonical_job, &AtomicBool::new(false)).ok()?;
                verify_output(&entry.output_path, &canonical_job).ok()
            })
            .is_some();
        if !valid {
            if let Ok(mut jobs) = self.jobs.lock() {
                if jobs
                    .session_outputs
                    .get(&key)
                    .is_some_and(|existing| existing.request_id == entry.request_id)
                {
                    jobs.session_outputs.remove(&key);
                }
                jobs.completed.remove(&entry.request_id);
            }
            return Ok(None);
        }
        Ok(Some(strip_windows_verbatim_prefix_local(&entry.output_path)))
    }

    #[allow(dead_code)]
    pub(crate) fn resolve_reusable_output(
        &self,
        input_path: &Path,
        executable: &str,
        args: &[String],
        output_format: ExternalPreviewFormat,
    ) -> Result<Option<ExternalPreviewResolved>, String> {
        if let Some(path) = saved_output(input_path, output_format)? {
            return Ok(Some(ExternalPreviewResolved {
                kind: ExternalPreviewSourceKind::Saved,
                output_path: path.to_string_lossy().into_owned(),
            }));
        }
        if let Some(path) = existing_output(input_path, output_format) {
            return Ok(Some(ExternalPreviewResolved {
                kind: ExternalPreviewSourceKind::Sibling,
                output_path: strip_windows_verbatim_prefix_local(&path)
                    .to_string_lossy()
                    .into_owned(),
            }));
        }
        if let Some(path) = self.lookup_session_output(input_path, executable, args, output_format)? {
            return Ok(Some(ExternalPreviewResolved {
                kind: ExternalPreviewSourceKind::Temporary,
                output_path: path.to_string_lossy().into_owned(),
            }));
        }
        Ok(None)
    }

    #[allow(dead_code)]
    pub(crate) fn save_external_preview(
        &self,
        input_path: &Path,
        source_output_path: &Path,
        output_format: ExternalPreviewFormat,
        overwrite: bool,
    ) -> Result<ExternalPreviewSaveOutcome, String> {
        let canonical_input = validate_input_path(input_path)?;
        let key = input_key(&canonical_input);
        let parent = input_path
            .parent()
            .ok_or_else(|| "External preview input has no parent directory".to_owned())?;
        let canonical_parent = canonical_directory(parent, "external preview parent directory")?;
        let canonical_source = fs::canonicalize(source_output_path)
            .map_err(|error| format!("保存元の外部プレビューが見つかりません: {error}"))?;

        let (managed_output, _work_root) = {
            let jobs = self
                .jobs
                .lock()
                .map_err(|_| "External preview job registry is unavailable.".to_owned())?;
            jobs.completed
                .values()
                .find(|completed| {
                    completed.input_key == key
                        && (completed.output_path == source_output_path
                            || completed.canonical_output_path == canonical_source)
                })
                .map(|completed| (completed.output_path.clone(), completed.work_root.clone()))
                .ok_or_else(|| "保存対象の一時外部プレビューが見つかりません".to_owned())?
        };

        let expected_name = format!("index.{}", output_format.extension());
        if managed_output.file_name().and_then(|n| n.to_str()) != Some(expected_name.as_str()) {
            return Err("保存対象の出力形式が一致しません".to_owned());
        }
        let source_job_dir = managed_output
            .parent()
            .ok_or_else(|| "保存元のジョブフォルダが見つかりません".to_owned())?;
        let canonical_source_dir =
            canonical_directory(source_job_dir, "external preview job directory")?;
        validate_output_tree(source_job_dir, &canonical_source_dir, &AtomicBool::new(false))?;
        let _ = verify_output(&managed_output, &canonical_source_dir)?;

        let target_dir = saved_preview_dir(input_path)
            .ok_or_else(|| "保存先フォルダ名を決定できませんでした".to_owned())?;
        let target_exists = match fs::symlink_metadata(&target_dir) {
            Ok(meta) => {
                if is_symlink_or_reparse_point(&meta) {
                    return Err(
                        "保存先パスがシンボリックリンクのため保存できません".to_owned(),
                    );
                }
                if !meta.is_dir() {
                    return Err(
                        "保存先と同じ名前のファイルが既に存在するため保存できません".to_owned(),
                    );
                }
                true
            }
            Err(error) if error.kind() == io::ErrorKind::NotFound => false,
            Err(error) => {
                return Err(format!("保存先フォルダを確認できませんでした: {error}"));
            }
        };

        if target_exists && !overwrite {
            return Ok(ExternalPreviewSaveOutcome::OverwriteRequired {
                directory_path: strip_windows_verbatim_prefix_local(&target_dir)
                    .to_string_lossy()
                    .into_owned(),
            });
        }

        let staging_dir = create_staging_directory(&canonical_parent, ".wasabipad-preview-save-")?;
        let mut staging_guard = StagingDirGuard {
            path: staging_dir.clone(),
            keep: false,
        };
        copy_output_tree(&canonical_source_dir, &staging_dir)?;
        let canonical_staging =
            canonical_directory(&staging_dir, "external preview staging directory")?;
        validate_output_tree_with_marker(
            &staging_dir,
            &canonical_staging,
            &AtomicBool::new(false),
            false,
        )?;
        let _ = verify_output(&staging_dir.join(&expected_name), &canonical_staging)?;

        if target_exists {
            let backup_dir = reserve_unique_sibling_path(&canonical_parent, ".wasabipad-preview-backup-");
            rename_dir_with_retry(&target_dir, &backup_dir).map_err(|error| {
                format!("保存済みフォルダ内のファイルが使用中のため上書きできませんでした: {error}")
            })?;
            if let Err(error) = fs::rename(&staging_dir, &target_dir) {
                let _ = rename_dir_with_retry(&backup_dir, &target_dir);
                return Err(format!("保存済みフォルダの置き換えに失敗しました: {error}"));
            }
            staging_guard.keep = true;
            let _ = remove_dir_all_with_retry(&backup_dir);
        } else {
            fs::rename(&staging_dir, &target_dir)
                .map_err(|error| format!("保存済みフォルダの配置に失敗しました: {error}"))?;
            staging_guard.keep = true;
        }

        let saved_entry = strip_windows_verbatim_prefix_local(&target_dir.join(&expected_name));
        Ok(ExternalPreviewSaveOutcome::Saved {
            output_path: saved_entry.to_string_lossy().into_owned(),
        })
    }

    pub(crate) fn cleanup_stale_roots(&self, work_roots: &[PathBuf]) -> Result<(), String> {
        let mut cleaned = self
            .cleaned_work_roots
            .lock()
            .map_err(|_| "External preview cleanup state is unavailable.".to_owned())?;
        for work_root in work_roots {
            let root = absolute_path(work_root).map_err(|error| {
                format!("Could not resolve external preview work root: {error}")
            })?;
            let key = if root.exists() {
                fs::canonicalize(&root).unwrap_or_else(|_| root.clone())
            } else {
                root.clone()
            };
            if cleaned.contains(&key) {
                continue;
            }
            cleanup_stale_jobs(&root)?;
            cleaned.insert(key);
        }
        Ok(())
    }

    #[allow(dead_code)]
    pub(crate) fn finish_success(
        &self,
        request_id: &str,
        cancelled: &Arc<AtomicBool>,
        output_path: &Path,
        work_root: &Path,
    ) -> Result<(), String> {
        self.finish_session_success(request_id, cancelled, output_path, work_root, None, None)
    }

    pub(crate) fn finish_session_success(
        &self,
        request_id: &str,
        cancelled: &Arc<AtomicBool>,
        output_path: &Path,
        work_root: &Path,
        session_record: Option<([u8; 32], ExternalPreviewConfigKey)>,
        protected_displayed_output: Option<&Path>,
    ) -> Result<(), String> {
        let canonical_output =
            fs::canonicalize(output_path).unwrap_or_else(|_| output_path.to_path_buf());
        let protected_canonical =
            protected_displayed_output.map(|p| fs::canonicalize(p).unwrap_or_else(|_| p.to_path_buf()));

        let (stale_reason, retired_previous) = {
            let mut jobs = self
                .jobs
                .lock()
                .map_err(|_| "External preview job registry is unavailable.".to_owned())?;
            if !jobs
                .active
                .get(request_id)
                .is_some_and(|active| Arc::ptr_eq(&active.cancelled, cancelled))
            {
                (
                    Some("External preview generation was cancelled or superseded"),
                    None,
                )
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
                    (
                        Some(if cancelled.load(Ordering::Acquire) {
                            "External preview cancelled"
                        } else {
                            "External preview generation was superseded"
                        }),
                        None,
                    )
                } else {
                    let input_key = active.input_key;
                    jobs.completed.insert(
                        request_id.to_owned(),
                        CompletedJob {
                            input_key: input_key.clone(),
                            output_path: output_path.to_path_buf(),
                            canonical_output_path: canonical_output.clone(),
                            work_root: work_root.to_path_buf(),
                        },
                    );
                    let retired = if let Some((input_sha256, config)) = session_record {
                        let normalized_config = ExternalPreviewConfigKey::normalized(
                            &config.executable,
                            &config.args,
                            config.output_format,
                        );
                        jobs.session_outputs.insert(
                            input_key,
                            SessionOutput {
                                request_id: request_id.to_owned(),
                                input_sha256,
                                config: normalized_config,
                                output_path: output_path.to_path_buf(),
                                canonical_output_path: canonical_output.clone(),
                                work_root: work_root.to_path_buf(),
                            },
                        )
                    } else {
                        None
                    };
                    (None, retired)
                }
            }
        };
        if let Some(reason) = stale_reason {
            let _ = cleanup_job(output_path, work_root);
            return Err(reason.to_owned());
        }
        if let Some(previous) = retired_previous {
            let is_same = previous.canonical_output_path == canonical_output;
            let is_protected = protected_canonical
                .as_ref()
                .is_some_and(|p| p == &previous.canonical_output_path);
            if !is_same && !is_protected && cleanup_job(&previous.output_path, &previous.work_root).is_ok() {
                if let Ok(mut jobs) = self.jobs.lock() {
                    jobs.completed.remove(&previous.request_id);
                }
            }
        }
        Ok(())
    }

    pub(crate) fn release_output(&self, output_path: &Path) {
        let canonical_target = fs::canonicalize(output_path).ok();
        if let Ok(mut jobs) = self.jobs.lock() {
            let request_id = jobs.completed.iter().find_map(|(id, completed)| {
                (completed.output_path == output_path
                    || canonical_target
                        .as_ref()
                        .is_some_and(|c| &completed.canonical_output_path == c))
                .then(|| id.clone())
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
                    if jobs
                        .session_outputs
                        .get(&completed.input_key)
                        .is_some_and(|s| s.request_id == request_id)
                    {
                        jobs.session_outputs.remove(&completed.input_key);
                    }
                }
            }
        }
    }

    #[allow(dead_code)]
    pub(crate) fn is_managed_output(&self, output_path: &Path) -> bool {
        let Ok(canonical_target) = fs::canonicalize(output_path) else {
            return false;
        };
        let Ok(jobs) = self.jobs.lock() else {
            return false;
        };
        jobs.completed.values().any(|completed| {
            completed.output_path == output_path
                || fs::canonicalize(&completed.output_path)
                    .is_ok_and(|canonical| canonical == canonical_target)
        })
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
    session_outputs: HashMap<String, SessionOutput>,
}

struct ActiveJob {
    input_key: String,
    cancelled: Arc<AtomicBool>,
}

struct CompletedJob {
    input_key: String,
    output_path: PathBuf,
    canonical_output_path: PathBuf,
    work_root: PathBuf,
}

#[derive(Clone)]
struct SessionOutput {
    request_id: String,
    input_sha256: [u8; 32],
    config: ExternalPreviewConfigKey,
    output_path: PathBuf,
    canonical_output_path: PathBuf,
    work_root: PathBuf,
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

#[allow(dead_code)]
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
    let stdout_path = job.path.join(STDOUT_CAPTURE_FILE);
    let stderr_path = job.path.join(STDERR_CAPTURE_FILE);
    let stdout = File::create(&stdout_path)
        .map_err(|error| format!("Could not capture external preview stdout: {error}"))?;
    let stderr = File::create(&stderr_path)
        .map_err(|error| format!("Could not capture external preview stderr: {error}"))?;

    let mut command = Command::new(executable);
    command
        .args(resolved_args)
        .current_dir(&job.path)
        .stdin(Stdio::null())
        .stdout(Stdio::from(stdout))
        .stderr(Stdio::from(stderr));
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        // Keep console adapters invisible while their output is captured to files.
        command.creation_flags(CREATE_NO_WINDOW);
    }

    if cancelled.load(Ordering::Acquire) {
        return Err("External preview cancelled".to_owned());
    }
    let mut child = command
        .spawn()
        .map_err(|error| format!("Could not start external preview: {error}"))?;
    let status = loop {
        if cancelled.load(Ordering::Acquire) {
            let message = stop_child(&mut child, "External preview cancelled".to_owned());
            return Err(external_preview_error_with_output(
                message,
                (capture_stream(&stdout_path), capture_stream(&stderr_path)),
            ));
        }
        match child.try_wait() {
            Ok(Some(status)) => break status,
            Ok(None) => {
                thread::sleep(POLL_INTERVAL);
            }
            Err(error) => {
                let message = stop_child(
                    &mut child,
                    format!("Could not wait for external preview: {error}"),
                );
                return Err(external_preview_error_with_output(
                    message,
                    (capture_stream(&stdout_path), capture_stream(&stderr_path)),
                ));
            }
        }
    };

    if cancelled.load(Ordering::Acquire) {
        return Err("External preview cancelled".to_owned());
    }
    if !status.success() {
        return Err(external_preview_error_with_output(
            format!("External preview exited with {status}"),
            (capture_stream(&stdout_path), capture_stream(&stderr_path)),
        ));
    }
    let captured = (capture_stream(&stdout_path), capture_stream(&stderr_path));
    if let Err(error) = validate_output_tree(&job.path, &job.canonical_path, cancelled) {
        return Err(external_preview_error_with_output(error, captured));
    }
    let output_path = match verify_output(&output_path, &job.canonical_path) {
        Ok(path) => path,
        Err(error) => return Err(external_preview_error_with_output(error, captured)),
    };
    for path in [&stdout_path, &stderr_path] {
        if let Err(error) = fs::remove_file(path) {
            return Err(external_preview_error_with_output(
                format!("Could not remove external preview log file: {error}"),
                captured,
            ));
        }
    }
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
            .eq([Component::Normal(executable.as_os_str())])
    {
        Ok(())
    } else {
        Err("External preview executable must be an absolute path or a PATH command".to_owned())
    }
}

fn replace_template(template: &str, input_path: &Path, output_path: &Path) -> String {
    let input = input_path.to_string_lossy();
    let output = output_path.to_string_lossy();
    let mut result = String::with_capacity(template.len());
    let mut rest = template;
    while !rest.is_empty() {
        if let Some(after) = rest.strip_prefix("{file}") {
            result.push_str(&input);
            rest = after;
        } else if let Some(after) = rest.strip_prefix("{output}") {
            result.push_str(&output);
            rest = after;
        } else {
            let step = rest.chars().next().map(char::len_utf8).unwrap_or(1);
            let next_brace = rest[step..].find('{').map(|offset| offset + step);
            let split_at = next_brace.unwrap_or(rest.len());
            result.push_str(&rest[..split_at]);
            rest = &rest[split_at..];
        }
    }
    result
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

fn validate_output_tree(
    job_root: &Path,
    canonical_job_root: &Path,
    cancelled: &AtomicBool,
) -> Result<(), String> {
    validate_output_tree_with_marker(job_root, canonical_job_root, cancelled, true)
}

fn validate_output_tree_with_marker(
    job_root: &Path,
    canonical_job_root: &Path,
    cancelled: &AtomicBool,
    skip_job_marker: bool,
) -> Result<(), String> {
    let mut directories = vec![job_root.to_path_buf()];

    while let Some(directory) = directories.pop() {
        for entry in fs::read_dir(&directory)
            .map_err(|error| format!("Could not list external preview output: {error}"))?
        {
            if cancelled.load(Ordering::Acquire) {
                return Err("External preview cancelled".to_owned());
            }
            let entry = entry
                .map_err(|error| format!("Could not inspect external preview output: {error}"))?;
            let path = entry.path();
            if skip_job_marker && path == job_root.join(JOB_MARKER) {
                continue;
            }

            let metadata = fs::symlink_metadata(&path)
                .map_err(|error| format!("Could not inspect external preview output: {error}"))?;
            if is_symlink_or_reparse_point(&metadata) {
                return Err("External preview output contains a symbolic link".to_owned());
            }
            let canonical_path = fs::canonicalize(&path)
                .map_err(|error| format!("Could not resolve external preview output: {error}"))?;
            if !canonical_path.starts_with(canonical_job_root) {
                return Err("External preview output escaped its job directory".to_owned());
            }

            if metadata.is_dir() {
                directories.push(path);
            } else if !metadata.is_file() {
                return Err("External preview output contains a non-file entry".to_owned());
            }
        }
    }

    Ok(())
}

fn is_symlink_or_reparse_point(metadata: &fs::Metadata) -> bool {
    if metadata.file_type().is_symlink() {
        return true;
    }
    #[cfg(windows)]
    {
        use std::os::windows::fs::MetadataExt;
        const FILE_ATTRIBUTE_REPARSE_POINT: u32 = 0x0400;
        if (metadata.file_attributes() & FILE_ATTRIBUTE_REPARSE_POINT) != 0 {
            return true;
        }
    }
    false
}

struct StagingDirGuard {
    path: PathBuf,
    keep: bool,
}

impl Drop for StagingDirGuard {
    fn drop(&mut self) {
        if !self.keep {
            let _ = fs::remove_dir_all(&self.path);
        }
    }
}

fn reserve_unique_sibling_path(parent: &Path, prefix: &str) -> PathBuf {
    let timestamp = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_nanos();
    let id = NEXT_JOB_ID.fetch_add(1, Ordering::Relaxed);
    parent.join(format!("{prefix}{}-{timestamp}-{id}", std::process::id()))
}

fn create_staging_directory(parent: &Path, prefix: &str) -> Result<PathBuf, String> {
    let builder = DirBuilder::new();
    for _ in 0..32 {
        let path = reserve_unique_sibling_path(parent, prefix);
        match builder.create(&path) {
            Ok(()) => return Ok(path),
            Err(error) if error.kind() == io::ErrorKind::AlreadyExists => continue,
            Err(error) => {
                return Err(format!("保存用の一時フォルダを作成できませんでした: {error}"));
            }
        }
    }
    Err("保存用の一時フォルダ名を確保できませんでした".to_owned())
}

fn copy_output_tree(source_root: &Path, target_root: &Path) -> Result<(), String> {
    let mut stack = vec![(source_root.to_path_buf(), target_root.to_path_buf(), true)];
    while let Some((src_dir, dst_dir, is_root)) = stack.pop() {
        for entry in fs::read_dir(&src_dir)
            .map_err(|error| format!("保存元の外部プレビューを読み取れませんでした: {error}"))?
        {
            let entry = entry
                .map_err(|error| format!("保存元の外部プレビューを読み取れませんでした: {error}"))?;
            let name = entry.file_name();
            if is_root {
                if let Some(name_str) = name.to_str() {
                    if name_str == JOB_MARKER
                        || name_str == STDOUT_CAPTURE_FILE
                        || name_str == STDERR_CAPTURE_FILE
                    {
                        continue;
                    }
                }
            }
            let src_path = entry.path();
            let dst_path = dst_dir.join(&name);
            let meta = fs::symlink_metadata(&src_path)
                .map_err(|error| format!("保存元の情報を読み取れませんでした: {error}"))?;
            if is_symlink_or_reparse_point(&meta) {
                return Err("保存元にシンボリックリンクが含まれるため保存できません".to_owned());
            }
            if meta.is_dir() {
                fs::create_dir(&dst_path)
                    .map_err(|error| format!("保存先サブフォルダを作成できませんでした: {error}"))?;
                stack.push((src_path, dst_path, false));
            } else if meta.is_file() {
                fs::copy(&src_path, &dst_path)
                    .map_err(|error| format!("保存先へファイルをコピーできませんでした: {error}"))?;
            } else {
                return Err("保存元に通常ファイル以外の項目が含まれるため保存できません".to_owned());
            }
        }
    }
    Ok(())
}

fn rename_dir_with_retry(from: &Path, to: &Path) -> io::Result<()> {
    let mut last_error = None;
    for attempt in 0..3 {
        match fs::rename(from, to) {
            Ok(()) => return Ok(()),
            Err(error) => {
                last_error = Some(error);
                if attempt < 2 {
                    thread::sleep(Duration::from_millis(30));
                }
            }
        }
    }
    Err(last_error.unwrap_or_else(|| io::Error::other("rename failed")))
}

fn remove_dir_all_with_retry(path: &Path) -> io::Result<()> {
    let mut last_error = None;
    for attempt in 0..3 {
        match fs::remove_dir_all(path) {
            Ok(()) => return Ok(()),
            Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(()),
            Err(error) => {
                last_error = Some(error);
                if attempt < 2 {
                    thread::sleep(Duration::from_millis(30));
                }
            }
        }
    }
    Err(last_error.unwrap_or_else(|| io::Error::other("remove_dir_all failed")))
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

fn strip_windows_verbatim_prefix_local(path: &Path) -> PathBuf {
    #[cfg(windows)]
    {
        if let Some(raw) = path.to_str() {
            if let Some(unc) = raw.strip_prefix(r"\\?\UNC\") {
                return PathBuf::from(format!(r"\\{unc}"));
            }
            if let Some(stripped) = raw.strip_prefix(r"\\?\") {
                return PathBuf::from(stripped);
            }
        }
    }
    path.to_path_buf()
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
pub(crate) fn resolve_system_root_executable(
    system_root: Option<&std::ffi::OsStr>,
    relative: &str,
) -> PathBuf {
    let base = system_root
        .filter(|value| !value.is_empty())
        .map(PathBuf::from)
        .filter(|path| path.is_absolute())
        .unwrap_or_else(|| PathBuf::from(r"C:\Windows"));
    base.join(relative)
}

#[cfg(windows)]
pub(crate) fn system_root_executable(relative: &str) -> PathBuf {
    resolve_system_root_executable(std::env::var_os("SystemRoot").as_deref(), relative)
}

#[cfg(windows)]
fn terminate_child(child: &mut Child) {
    let id = child.id().to_string();
    let mut taskkill = Command::new(system_root_executable(r"System32\taskkill.exe"));
    use std::os::windows::process::CommandExt;
    taskkill.creation_flags(CREATE_NO_WINDOW);
    let _ = taskkill
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

#[cfg(test)]
mod template_tests {
    use super::replace_template;
    use std::path::Path;

    // Feature: 外部プレビュー引数の単一パス置換
    // Scenario: 入力ファイル名に `{output}` を含むパスを置換する
    // Given: `{file}` に `{output}` リテラルを含む入力パスと日本語を含む引数テンプレート
    // When: replace_template で置換する
    // Then: 入力パス内の `{output}` は二重置換されず、マルチバイト文字も安全に保たれる
    #[test]
    fn replaces_placeholders_in_a_single_pass_without_double_expansion() {
        let input = Path::new(r"C:\work\{output}\曲.abc");
        let output = Path::new(r"C:\temp\job\index.html");
        let resolved = replace_template("入力={file} -> 出力={output}", input, output);
        assert_eq!(
            resolved,
            r"入力=C:\work\{output}\曲.abc -> 出力=C:\temp\job\index.html"
        );
    }

    // Feature: Windows システム実行ファイルの絶対パス解決
    // Scenario: SystemRoot 環境変数が有効な絶対パスならそれを使い、未設定や相対パスなら C:\Windows へフォールバックする
    // Given: 有効な SystemRoot、未設定、空文字、相対パス
    // When: resolve_system_root_executable を呼ぶ
    // Then: 常に絶対パス配下の実行ファイルパスを返す
    #[cfg(windows)]
    #[test]
    fn resolves_system_root_executables_safely() {
        use super::resolve_system_root_executable;
        use std::ffi::OsStr;
        use std::path::PathBuf;

        assert_eq!(
            resolve_system_root_executable(Some(OsStr::new(r"D:\Windows")), "explorer.exe"),
            PathBuf::from(r"D:\Windows\explorer.exe")
        );
        assert_eq!(
            resolve_system_root_executable(Some(OsStr::new(r"D:\Windows")), r"System32\taskkill.exe"),
            PathBuf::from(r"D:\Windows\System32\taskkill.exe")
        );
        assert_eq!(
            resolve_system_root_executable(None, "explorer.exe"),
            PathBuf::from(r"C:\Windows\explorer.exe")
        );
        assert_eq!(
            resolve_system_root_executable(Some(OsStr::new("")), "explorer.exe"),
            PathBuf::from(r"C:\Windows\explorer.exe")
        );
        assert_eq!(
            resolve_system_root_executable(Some(OsStr::new("relative")), r"System32\taskkill.exe"),
            PathBuf::from(r"C:\Windows\System32\taskkill.exe")
        );
    }
}
