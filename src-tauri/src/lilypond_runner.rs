use std::ffi::OsStr;
use std::fs::{self, DirBuilder, File, OpenOptions};
use std::io::{self, Read, Write};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::thread;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

const MAX_OUTPUT_FILES: usize = 256;
const MAX_OUTPUT_BYTES: u64 = 64 * 1024 * 1024;
const MAX_CAPTURED_DIAGNOSTIC_BYTES: usize = 1024 * 1024;
const MAX_DISPLAYED_STDERR_BYTES: usize = 8 * 1024;
const POLL_INTERVAL: Duration = Duration::from_millis(25);

static NEXT_JOB_ID: AtomicU64 = AtomicU64::new(0);

#[derive(Debug, serde::Serialize, ts_rs::TS)]
#[serde(rename_all = "camelCase")]
#[ts(rename_all = "camelCase")]
#[ts(export)]
pub struct LilyOutput {
    pub svg_pages: Vec<SvgPage>,
    pub midi_files: Vec<MidiFile>,
}

#[derive(Debug, serde::Serialize, ts_rs::TS)]
#[serde(rename_all = "camelCase")]
#[ts(rename_all = "camelCase")]
#[ts(export)]
pub struct SvgPage {
    pub file_name: String,
    pub content: String,
}

#[derive(Debug, serde::Serialize, ts_rs::TS)]
#[serde(rename_all = "camelCase")]
#[ts(rename_all = "camelCase")]
#[ts(export)]
pub struct MidiFile {
    pub display_name: String,
    pub bytes: Vec<u8>,
}

struct JobDirectory {
    path: PathBuf,
    canonical_path: PathBuf,
}

impl Drop for JobDirectory {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.path);
    }
}

struct OutputFile {
    path: PathBuf,
    file_name: String,
    length: u64,
}

#[derive(Default)]
struct OutputInventory {
    svg_pages: Vec<OutputFile>,
    midi_files: Vec<OutputFile>,
    total_bytes: u64,
}

struct CapturedStream {
    bytes: Vec<u8>,
    truncated: bool,
}

struct CapturedLogs {
    stdout: CapturedStream,
    stderr: CapturedStream,
}

struct LogReaders {
    stdout: thread::JoinHandle<io::Result<CapturedStream>>,
    stderr: thread::JoinHandle<io::Result<CapturedStream>>,
}

impl LogReaders {
    fn join(self) -> Result<CapturedLogs, String> {
        Ok(CapturedLogs {
            stdout: join_reader(self.stdout, "stdout")?,
            stderr: join_reader(self.stderr, "stderr")?,
        })
    }
}

pub fn run_lilypond(
    executable: &Path,
    source_path: Option<&Path>,
    source: &str,
    work_root: &Path,
    timeout: Duration,
    cancelled: &AtomicBool,
) -> Result<LilyOutput, String> {
    if cancelled.load(Ordering::Acquire) {
        return Err("LilyPond generation cancelled".to_owned());
    }

    let include_directory = source_path.map(include_directory).transpose()?;
    let job = create_job_directory(work_root)?;
    let source_file = job.path.join("buffer.ly");
    write_new_file(&source_file, source.as_bytes())?;

    let mut command = Command::new(executable);
    command.arg("-fsvg").arg("-o").arg(job.path.join("output"));
    if let Some(include_directory) = include_directory {
        command.arg("-I").arg(include_directory);
    }
    command
        .arg(&source_file)
        .current_dir(&job.path)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());

    if cancelled.load(Ordering::Acquire) {
        return Err("LilyPond generation cancelled".to_owned());
    }
    let mut child = command
        .spawn()
        .map_err(|error| format!("Could not start LilyPond: {error}"))?;
    let stdout = child.stdout.take().expect("stdout is piped");
    let stderr = child.stderr.take().expect("stderr is piped");
    let readers = LogReaders {
        stdout: thread::spawn(move || drain_stream(stdout)),
        stderr: thread::spawn(move || drain_stream(stderr)),
    };
    let started = Instant::now();
    let status = loop {
        if cancelled.load(Ordering::Acquire) {
            return Err(stop_child(
                &mut child,
                readers,
                "LilyPond generation cancelled".to_owned(),
            ));
        }

        match child.try_wait() {
            Ok(Some(status)) => break status,
            Ok(None) => {
                if started.elapsed() >= timeout {
                    return Err(stop_child(
                        &mut child,
                        readers,
                        format!("LilyPond generation timed out after {timeout:?}"),
                    ));
                }
                if let Err(error) = collect_outputs(&job.path, &job.canonical_path) {
                    return Err(stop_child(&mut child, readers, error));
                }
                thread::sleep(POLL_INTERVAL);
            }
            Err(error) => {
                return Err(stop_child(
                    &mut child,
                    readers,
                    format!("Could not wait for LilyPond: {error}"),
                ));
            }
        }
    };
    let logs = readers.join()?;

    if !status.success() {
        return Err(error_with_diagnostics(
            &logs,
            format!("LilyPond exited with {status}"),
        ));
    }

    let mut outputs = collect_outputs(&job.path, &job.canonical_path)?;
    if outputs.svg_pages.is_empty() {
        return Err("LilyPond produced no SVG pages".to_owned());
    }
    order_svg_pages(&mut outputs.svg_pages)?;
    order_midi_files(&mut outputs.midi_files)?;

    let mut svg_pages = Vec::with_capacity(outputs.svg_pages.len());
    let mut midi_files = Vec::with_capacity(outputs.midi_files.len());
    let mut bytes_read = 0u64;
    for file in outputs.svg_pages {
        let bytes = read_output_file(&file, &job.canonical_path, MAX_OUTPUT_BYTES - bytes_read)?;
        bytes_read += bytes.len() as u64;
        let content = String::from_utf8(bytes)
            .map_err(|error| format!("LilyPond produced invalid UTF-8 SVG: {error}"))?;
        svg_pages.push(SvgPage {
            file_name: file.file_name,
            content,
        });
    }
    for file in outputs.midi_files {
        let bytes = read_output_file(&file, &job.canonical_path, MAX_OUTPUT_BYTES - bytes_read)?;
        bytes_read += bytes.len() as u64;
        midi_files.push(MidiFile {
            display_name: file.file_name,
            bytes,
        });
    }

    Ok(LilyOutput {
        svg_pages,
        midi_files,
    })
}

fn include_directory(source_path: &Path) -> Result<PathBuf, String> {
    let parent = source_path
        .parent()
        .filter(|parent| !parent.as_os_str().is_empty())
        .unwrap_or_else(|| Path::new("."));
    let directory = absolute_path(parent)
        .map_err(|error| format!("Could not resolve saved source directory: {error}"))?;
    if !fs::metadata(&directory)
        .map_err(|error| format!("Could not inspect saved source directory: {error}"))?
        .is_dir()
    {
        return Err("Saved source parent is not a directory".to_owned());
    }
    Ok(directory)
}

fn create_job_directory(work_root: &Path) -> Result<JobDirectory, String> {
    let root = absolute_path(work_root)
        .map_err(|error| format!("Could not resolve LilyPond work root: {error}"))?;
    fs::create_dir_all(&root)
        .map_err(|error| format!("Could not create LilyPond work root: {error}"))?;
    let canonical_root = fs::canonicalize(&root)
        .map_err(|error| format!("Could not resolve LilyPond work root: {error}"))?;
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
            "lilypond-job-{}-{timestamp}-{id}",
            std::process::id()
        ));
        match builder.create(&path) {
            Ok(()) => {
                let canonical_path = fs::canonicalize(&path).map_err(|error| {
                    format!("Could not resolve LilyPond job directory: {error}")
                })?;
                if !canonical_path.starts_with(&canonical_root) {
                    let _ = fs::remove_dir_all(&path);
                    return Err("LilyPond job directory escaped its work root".to_owned());
                }
                return Ok(JobDirectory {
                    path,
                    canonical_path,
                });
            }
            Err(error) if error.kind() == io::ErrorKind::AlreadyExists => continue,
            Err(error) => return Err(format!("Could not create LilyPond job directory: {error}")),
        }
    }
    Err("Could not reserve a unique LilyPond job directory".to_owned())
}

fn absolute_path(path: &Path) -> io::Result<PathBuf> {
    if path.is_absolute() {
        Ok(path.to_path_buf())
    } else {
        Ok(std::env::current_dir()?.join(path))
    }
}

fn write_new_file(path: &Path, bytes: &[u8]) -> Result<(), String> {
    let mut file = create_new_file(path)?;
    file.write_all(bytes)
        .map_err(|error| format!("Could not write LilyPond source snapshot: {error}"))
}

fn create_new_file(path: &Path) -> Result<File, String> {
    OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(path)
        .map_err(|error| format!("Could not create private LilyPond file: {error}"))
}

fn stop_child(child: &mut Child, readers: LogReaders, reason: String) -> String {
    terminate_child(child);
    let wait_error = child.wait().err();
    let mut message = match readers.join() {
        Ok(logs) => error_with_diagnostics(&logs, reason),
        Err(error) => format!("{reason}; {error}"),
    };
    if let Some(error) = wait_error {
        message.push_str(&format!("; could not reap LilyPond process: {error}"));
    }
    message
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

fn error_with_diagnostics(logs: &CapturedLogs, reason: String) -> String {
    let display_len = logs.stderr.bytes.len().min(MAX_DISPLAYED_STDERR_BYTES);
    let diagnostic = String::from_utf8_lossy(&logs.stderr.bytes[..display_len])
        .trim()
        .to_owned();
    let mut message = if diagnostic.is_empty() {
        reason
    } else {
        format!("{reason}: {diagnostic}")
    };
    if logs.stderr.bytes.len() > MAX_DISPLAYED_STDERR_BYTES {
        message.push_str(" [stderr truncated]");
    }
    if logs.stdout.truncated {
        message.push_str(" [stdout capture capped at 1 MiB]");
    }
    if logs.stderr.truncated {
        message.push_str(" [stderr capture capped at 1 MiB]");
    }
    message
}

fn join_reader(
    reader: thread::JoinHandle<io::Result<CapturedStream>>,
    stream_name: &str,
) -> Result<CapturedStream, String> {
    reader
        .join()
        .map_err(|_| format!("Could not join LilyPond {stream_name} reader"))?
        .map_err(|error| format!("Could not read LilyPond {stream_name}: {error}"))
}

fn drain_stream(mut stream: impl Read) -> io::Result<CapturedStream> {
    let mut bytes = Vec::with_capacity(MAX_CAPTURED_DIAGNOSTIC_BYTES);
    let mut buffer = [0; 8192];
    let mut truncated = false;
    loop {
        let read = stream.read(&mut buffer)?;
        if read == 0 {
            break;
        }
        let retained = read.min(MAX_CAPTURED_DIAGNOSTIC_BYTES.saturating_sub(bytes.len()));
        bytes.extend_from_slice(&buffer[..retained]);
        truncated |= retained < read;
    }
    Ok(CapturedStream { bytes, truncated })
}

fn collect_outputs(job_root: &Path, canonical_job_root: &Path) -> Result<OutputInventory, String> {
    let mut outputs = OutputInventory::default();
    for entry in fs::read_dir(job_root)
        .map_err(|error| format!("Could not list LilyPond job output: {error}"))?
    {
        let entry = entry.map_err(|error| format!("Could not inspect LilyPond output: {error}"))?;
        let path = entry.path();
        let Some(kind) = output_kind(&path) else {
            continue;
        };
        let file_type = entry
            .file_type()
            .map_err(|error| format!("Could not inspect LilyPond output: {error}"))?;
        if !file_type.is_file() {
            return Err(format!(
                "LilyPond output is not a regular file: {}",
                path.display()
            ));
        }
        let canonical_path = fs::canonicalize(&path)
            .map_err(|error| format!("Could not resolve LilyPond output path: {error}"))?;
        if !canonical_path.starts_with(canonical_job_root) {
            return Err(format!(
                "LilyPond output escaped its job directory: {}",
                path.display()
            ));
        }
        let metadata = fs::metadata(&canonical_path)
            .map_err(|error| format!("Could not inspect LilyPond output size: {error}"))?;
        if !metadata.is_file() {
            return Err(format!(
                "LilyPond output is not a regular file: {}",
                path.display()
            ));
        }
        outputs.total_bytes = outputs
            .total_bytes
            .checked_add(metadata.len())
            .ok_or_else(|| "LilyPond output size overflowed".to_owned())?;
        let output = OutputFile {
            path: canonical_path,
            file_name: entry.file_name().to_string_lossy().into_owned(),
            length: metadata.len(),
        };
        match kind {
            OutputKind::Svg => outputs.svg_pages.push(output),
            OutputKind::Midi => outputs.midi_files.push(output),
        }
        if outputs.svg_pages.len() + outputs.midi_files.len() > MAX_OUTPUT_FILES {
            return Err(format!(
                "LilyPond produced more than {MAX_OUTPUT_FILES} output files"
            ));
        }
        if outputs.total_bytes > MAX_OUTPUT_BYTES {
            return Err(format!(
                "LilyPond outputs exceed the {} MiB byte limit",
                MAX_OUTPUT_BYTES / (1024 * 1024)
            ));
        }
    }
    Ok(outputs)
}

#[derive(Clone, Copy)]
enum OutputKind {
    Svg,
    Midi,
}

fn output_kind(path: &Path) -> Option<OutputKind> {
    let extension = path.extension()?.to_str()?;
    if extension.eq_ignore_ascii_case("svg") {
        Some(OutputKind::Svg)
    } else if extension.eq_ignore_ascii_case("mid") || extension.eq_ignore_ascii_case("midi") {
        Some(OutputKind::Midi)
    } else {
        None
    }
}

fn order_svg_pages(files: &mut Vec<OutputFile>) -> Result<(), String> {
    order_output_files(files, svg_order_key, "SVG page")
}

fn order_midi_files(files: &mut Vec<OutputFile>) -> Result<(), String> {
    order_output_files(files, midi_order_key, "MIDI output")
}

fn order_output_files(
    files: &mut Vec<OutputFile>,
    order_key: fn(&str) -> Result<(String, u32, u32), String>,
    kind: &str,
) -> Result<(), String> {
    let mut ordered = Vec::with_capacity(files.len());
    for file in files.drain(..) {
        let (prefix, book, page) = order_key(&file.file_name)?;
        ordered.push((prefix, (book, page), file));
    }
    if ordered
        .first()
        .is_some_and(|(prefix, _, _)| ordered.iter().any(|(other, _, _)| other != prefix))
    {
        return Err(format!(
            "LilyPond {kind} order is ambiguous across output names"
        ));
    }
    ordered.sort_by_key(|(_, key, _)| *key);
    for pair in ordered.windows(2) {
        if pair[0].1 == pair[1].1 {
            return Err(format!(
                "LilyPond {kind} order is ambiguous: {} and {}",
                pair[0].2.file_name, pair[1].2.file_name
            ));
        }
    }
    files.extend(ordered.into_iter().map(|(_, _, file)| file));
    Ok(())
}

fn svg_order_key(file_name: &str) -> Result<(String, u32, u32), String> {
    let stem = Path::new(file_name)
        .file_stem()
        .and_then(OsStr::to_str)
        .ok_or_else(|| format!("LilyPond produced an invalid SVG filename: {file_name}"))?;
    let (prefix, suffix) = numeric_suffix(stem)?;
    let (book, page) = match suffix.as_slice() {
        [] => (0, 1),
        [page] => (0, *page),
        [book, page] => (*book, *page),
        _ => return Err(format!("LilyPond SVG page order is ambiguous: {file_name}")),
    };
    Ok((prefix.to_owned(), book, page))
}

fn midi_order_key(file_name: &str) -> Result<(String, u32, u32), String> {
    let stem = Path::new(file_name)
        .file_stem()
        .and_then(OsStr::to_str)
        .ok_or_else(|| format!("LilyPond produced an invalid MIDI filename: {file_name}"))?;
    let (prefix, suffix) = numeric_suffix(stem)?;
    let output_number = match suffix.as_slice() {
        [] => 0,
        [output_number] => *output_number,
        _ => {
            return Err(format!(
                "LilyPond MIDI output order is ambiguous: {file_name}"
            ))
        }
    };
    Ok((prefix.to_owned(), 0, output_number))
}

// ponytail: page ordering supports verified LilyPond numeric suffixes; reject new naming layouts until their order is confirmed.
fn numeric_suffix(stem: &str) -> Result<(&str, Vec<u32>), String> {
    let mut prefix = stem;
    let mut suffix = Vec::new();
    while let Some((before, part)) = prefix.rsplit_once('-') {
        if part.is_empty() || !part.bytes().all(|byte| byte.is_ascii_digit()) {
            break;
        }
        let number = part
            .parse::<u32>()
            .map_err(|_| format!("LilyPond output number is out of range: {stem}"))?;
        suffix.push(number);
        prefix = before;
    }
    if prefix.is_empty() {
        return Err(format!("LilyPond output name is ambiguous: {stem}"));
    }
    suffix.reverse();
    Ok((prefix, suffix))
}

fn read_output_file(
    file: &OutputFile,
    canonical_job_root: &Path,
    remaining_bytes: u64,
) -> Result<Vec<u8>, String> {
    let canonical_path = fs::canonicalize(&file.path)
        .map_err(|error| format!("Could not resolve LilyPond output before reading: {error}"))?;
    if !canonical_path.starts_with(canonical_job_root) {
        return Err(format!(
            "LilyPond output escaped its job directory: {}",
            file.file_name
        ));
    }
    let metadata = fs::symlink_metadata(&canonical_path)
        .map_err(|error| format!("Could not inspect LilyPond output: {error}"))?;
    if !metadata.file_type().is_file() {
        return Err(format!(
            "LilyPond output is not a regular file: {}",
            file.file_name
        ));
    }
    if metadata.len() > remaining_bytes || metadata.len() > MAX_OUTPUT_BYTES {
        return Err(format!(
            "LilyPond outputs exceed the {} MiB byte limit",
            MAX_OUTPUT_BYTES / (1024 * 1024)
        ));
    }

    let read_limit = remaining_bytes.saturating_add(1);
    let mut bytes = Vec::with_capacity(file.length.min(read_limit) as usize);
    File::open(&canonical_path)
        .and_then(|file| file.take(read_limit).read_to_end(&mut bytes))
        .map_err(|error| format!("Could not read LilyPond output: {error}"))?;
    if bytes.len() as u64 > remaining_bytes {
        return Err(format!(
            "LilyPond outputs exceed the {} MiB byte limit",
            MAX_OUTPUT_BYTES / (1024 * 1024)
        ));
    }
    Ok(bytes)
}
