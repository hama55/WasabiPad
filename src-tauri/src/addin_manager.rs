use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::collections::{BTreeMap, HashSet};
use std::fs::{self, File, OpenOptions};
use std::io::{Read, Write};
use std::path::{Component, Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use zip::ZipArchive;

pub(crate) const ADDON_IDS: [&str; 2] = ["abc", "lilypond"];
pub(crate) const MAX_ARCHIVE_BYTES: u64 = 256 * 1024 * 1024;
const MAX_EXTRACTED_BYTES: u64 = 256 * 1024 * 1024;
const MAX_ARCHIVE_ENTRIES: usize = 4096;
const MAX_MANIFEST_BYTES: u64 = 1024 * 1024;
const ENTRY_POINT: &str = "dist/entry.js";
static NEXT_JOB_ID: AtomicU64 = AtomicU64::new(0);

type AddonState = BTreeMap<String, StateRecord>;

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
struct StateRecord {
    version: String,
    enabled: bool,
}

#[derive(Clone, Debug, PartialEq, Eq, serde::Serialize, ts_rs::TS)]
#[serde(rename_all = "camelCase")]
#[ts(rename_all = "camelCase")]
#[ts(export)]
pub struct LocalAddonStatus {
    pub id: String,
    pub version: Option<String>,
    pub installed: bool,
    pub enabled: bool,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct AddonManifest {
    id: String,
    version: String,
    entry: String,
    minimum_app_version: String,
}

struct StagingDirectory(PathBuf);

impl Drop for StagingDirectory {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}

pub fn install_verified_archive(
    app_data_root: &Path,
    id: &str,
    version: &str,
    archive_path: &Path,
    expected_sha256: &str,
) -> Result<(), String> {
    validate_id(id)?;
    validate_version(version)?;
    validate_sha256(expected_sha256)?;

    let addins_root = addins_root(app_data_root, true)?.expect("created addins directory");
    let mut state = read_state_at(&addins_root)?;
    let previous_version = state.get(id).map(|record| record.version.clone());
    let enabled = state.get(id).map_or(true, |record| record.enabled);
    let id_directory = addins_root.join(id);
    ensure_child_directory(&addins_root, &id_directory)?;

    let staging_parent = addins_root.join(".staging");
    ensure_child_directory(&addins_root, &staging_parent)?;
    let staging = StagingDirectory(create_staging_directory(&staging_parent, id, version)?);
    let package_directory = staging.0.join("package");
    fs::create_dir(&package_directory)
        .map_err(|error| format!("create staging package: {error}"))?;
    let archive_copy = staging.0.join("verified.zip");
    copy_verified_archive(archive_path, &archive_copy, expected_sha256)?;
    extract_archive(&archive_copy, &package_directory)?;
    validate_manifest(&package_directory, id, version)?;
    fs::remove_file(&archive_copy)
        .map_err(|error| format!("remove verified archive copy: {error}"))?;
    write_ready_marker(&package_directory)?;

    let target = id_directory.join(version);
    let backup = staging.0.join("previous");
    let target_exists = match fs::symlink_metadata(&target) {
        Ok(_) => true,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => false,
        Err(error) => return Err(format!("inspect addin version directory: {error}")),
    };
    let replace_same_installed_version = previous_version.as_deref() == Some(version);
    if target_exists && !replace_same_installed_version {
        return Err("addin target version already exists outside the current state".into());
    }
    if target_exists {
        ensure_managed_directory(&addins_root, &target)?;
        fs::rename(&target, &backup)
            .map_err(|error| format!("stage previous addin version: {error}"))?;
    }
    if let Err(error) = fs::rename(&package_directory, &target) {
        if target_exists {
            let _ = fs::rename(&backup, &target);
        }
        return Err(format!("publish addin package: {error}"));
    }

    state.insert(
        id.to_owned(),
        StateRecord {
            version: version.to_owned(),
            enabled,
        },
    );
    if let Err(error) = write_state(&addins_root, &state) {
        let rollback_new = fs::rename(&target, &package_directory);
        let rollback_old = if target_exists {
            fs::rename(&backup, &target)
        } else {
            Ok(())
        };
        if let Err(rollback_error) = rollback_new {
            return Err(format!(
                "save addin state failed ({error}); rollback of new package failed: {rollback_error}"
            ));
        }
        if let Err(rollback_error) = rollback_old {
            return Err(format!(
                "save addin state failed ({error}); rollback of previous package failed: {rollback_error}"
            ));
        }
        return Err(error);
    }

    if let Some(previous) = previous_version {
        if previous != version {
            let _ = remove_managed_version(&addins_root, id, &previous);
        }
    }
    Ok(())
}

pub fn list_local_status(app_data_root: &Path) -> Result<Vec<LocalAddonStatus>, String> {
    let addins = addins_root(app_data_root, false)?;
    let state = match &addins {
        Some(path) => read_state_at(path)?,
        None => AddonState::new(),
    };
    Ok(ADDON_IDS
        .iter()
        .map(|id| {
            let record = state.get(*id);
            let installed = match (&addins, record) {
                (Some(path), Some(record)) => {
                    package_is_ready(path, id, &record.version).unwrap_or(false)
                }
                _ => false,
            };
            LocalAddonStatus {
                id: (*id).to_owned(),
                version: record.map(|record| record.version.clone()),
                installed,
                enabled: record.map_or(false, |record| record.enabled && installed),
            }
        })
        .collect())
}

pub fn set_enabled(app_data_root: &Path, id: &str, enabled: bool) -> Result<(), String> {
    validate_id(id)?;
    let addins = addins_root(app_data_root, false)?
        .ok_or_else(|| "no local addins are installed".to_owned())?;
    let mut state = read_state_at(&addins)?;
    let record = state
        .get_mut(id)
        .ok_or_else(|| format!("addin {id} is not installed"))?;
    if enabled && !package_is_ready(&addins, id, &record.version)? {
        return Err(format!(
            "addin {id} does not have a ready installed version"
        ));
    }
    record.enabled = enabled;
    write_state(&addins, &state)
}

pub fn remove(app_data_root: &Path, id: &str) -> Result<(), String> {
    validate_id(id)?;
    let Some(addins) = addins_root(app_data_root, false)? else {
        return Ok(());
    };
    let mut state = read_state_at(&addins)?;
    if !state.contains_key(id) {
        return Ok(());
    }
    remove_managed_addon(&addins, id)?;
    state.remove(id);
    write_state(&addins, &state)
}

pub(crate) fn is_enabled_version(
    app_data_root: &Path,
    id: &str,
    version: &str,
) -> Result<bool, String> {
    validate_id(id)?;
    validate_version(version)?;
    let Some(addins) = addins_root(app_data_root, false)? else {
        return Ok(false);
    };
    let state = read_state_at(&addins)?;
    let Some(record) = state.get(id) else {
        return Ok(false);
    };
    Ok(record.enabled && record.version == version && package_is_ready(&addins, id, version)?)
}

fn addins_root(app_data_root: &Path, create: bool) -> Result<Option<PathBuf>, String> {
    match fs::symlink_metadata(app_data_root) {
        Ok(metadata) if metadata.file_type().is_symlink() || !metadata.is_dir() => {
            return Err("app data root must be a regular directory".into());
        }
        Ok(_) => {}
        Err(error) if error.kind() == std::io::ErrorKind::NotFound && !create => return Ok(None),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            fs::create_dir_all(app_data_root)
                .map_err(|error| format!("create app data root: {error}"))?;
        }
        Err(error) => return Err(format!("inspect app data root: {error}")),
    }
    let canonical_root = fs::canonicalize(app_data_root)
        .map_err(|error| format!("resolve app data root: {error}"))?;
    let path = canonical_root.join("addins");
    match fs::symlink_metadata(&path) {
        Ok(metadata) if metadata.file_type().is_symlink() || !metadata.is_dir() => {
            return Err("addins root must be a regular directory".into());
        }
        Ok(_) => {}
        Err(error) if error.kind() == std::io::ErrorKind::NotFound && !create => return Ok(None),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            fs::create_dir(&path).map_err(|error| format!("create addins root: {error}"))?;
        }
        Err(error) => return Err(format!("inspect addins root: {error}")),
    }
    let canonical_addins =
        fs::canonicalize(&path).map_err(|error| format!("resolve addins root: {error}"))?;
    if !canonical_addins.starts_with(&canonical_root) {
        return Err("addins root resolves outside app data root".into());
    }
    Ok(Some(canonical_addins))
}

pub(crate) fn create_download_temp_file(app_data_root: &Path) -> Result<(PathBuf, File), String> {
    let addins_root = addins_root(app_data_root, true)?.expect("created addins directory");
    let downloads = addins_root.join(".downloads");
    ensure_child_directory(&addins_root, &downloads)?;
    for _ in 0..64 {
        let nonce = NEXT_JOB_ID.fetch_add(1, Ordering::Relaxed);
        let tick = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap_or_default()
            .as_nanos();
        let path = downloads.join(format!(
            "download-{}-{tick}-{nonce}.zip",
            std::process::id()
        ));
        match OpenOptions::new().write(true).create_new(true).open(&path) {
            Ok(file) => return Ok((path, file)),
            Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => continue,
            Err(error) => return Err(format!("create addin download file: {error}")),
        }
    }
    Err("could not allocate a unique addin download file".into())
}

fn read_state_at(addins_root: &Path) -> Result<AddonState, String> {
    let path = addins_root.join("state.json");
    let metadata = match fs::symlink_metadata(&path) {
        Ok(metadata) if metadata.file_type().is_symlink() || !metadata.is_file() => {
            return Err("addin state must be a regular file".into());
        }
        Ok(metadata) => metadata,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(AddonState::new()),
        Err(error) => return Err(format!("inspect addin state: {error}")),
    };
    if metadata.len() > 1024 * 1024 {
        return Err("addin state exceeds the size limit".into());
    }
    let bytes = fs::read(path).map_err(|error| format!("read addin state: {error}"))?;
    let state = serde_json::from_slice::<AddonState>(&bytes)
        .map_err(|error| format!("parse addin state: {error}"))?;
    for (id, record) in &state {
        validate_id(id)?;
        validate_version(&record.version)?;
    }
    Ok(state)
}

fn write_state(addins_root: &Path, state: &AddonState) -> Result<(), String> {
    let path = addins_root.join("state.json");
    if let Ok(metadata) = fs::symlink_metadata(&path) {
        if metadata.file_type().is_symlink() || !metadata.is_file() {
            return Err("addin state must be a regular file".into());
        }
    }
    let bytes = serde_json::to_vec_pretty(state)
        .map_err(|error| format!("serialize addin state: {error}"))?;
    wasabipad_core::atomic_write(&path, &[&bytes])
        .map_err(|error| format!("save addin state: {error}"))
}

pub(crate) fn validate_id(id: &str) -> Result<(), String> {
    if ADDON_IDS.contains(&id) {
        Ok(())
    } else {
        Err(format!("unsupported official addin id: {id}"))
    }
}

pub(crate) fn validate_version(version: &str) -> Result<(), String> {
    parse_release_version(version).map(|_| ())
}

pub(crate) fn parse_release_version(version: &str) -> Result<(u64, u64, u64), String> {
    let parts: Vec<&str> = version.split('.').collect();
    if parts.len() != 3 {
        return Err(format!("invalid release version: {version}"));
    }
    let mut parsed = [0; 3];
    for (index, part) in parts.iter().enumerate() {
        if part.is_empty()
            || !part.bytes().all(|byte| byte.is_ascii_digit())
            || (part.len() > 1 && part.starts_with('0'))
        {
            return Err(format!("invalid release version: {version}"));
        }
        parsed[index] = part
            .parse()
            .map_err(|_| format!("invalid release version: {version}"))?;
    }
    Ok((parsed[0], parsed[1], parsed[2]))
}

pub(crate) fn validate_sha256(expected_sha256: &str) -> Result<(), String> {
    if expected_sha256.len() == 64 && expected_sha256.bytes().all(|byte| byte.is_ascii_hexdigit()) {
        Ok(())
    } else {
        Err("expected SHA-256 must be exactly 64 hexadecimal characters".into())
    }
}

fn copy_verified_archive(
    source: &Path,
    destination: &Path,
    expected_sha256: &str,
) -> Result<(), String> {
    let metadata =
        fs::symlink_metadata(source).map_err(|error| format!("inspect addin archive: {error}"))?;
    if metadata.file_type().is_symlink() || !metadata.is_file() {
        return Err("addin archive must be a regular file".into());
    }
    if metadata.len() > MAX_ARCHIVE_BYTES {
        return Err("addin archive exceeds the compressed size limit".into());
    }
    let mut input = File::open(source).map_err(|error| format!("open addin archive: {error}"))?;
    let mut output = OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(destination)
        .map_err(|error| format!("create verified archive copy: {error}"))?;
    let mut digest = Sha256::new();
    let mut total = 0u64;
    let mut buffer = [0u8; 64 * 1024];
    loop {
        let read = input
            .read(&mut buffer)
            .map_err(|error| format!("read addin archive: {error}"))?;
        if read == 0 {
            break;
        }
        total = total.saturating_add(read as u64);
        if total > MAX_ARCHIVE_BYTES {
            return Err("addin archive exceeds the compressed size limit".into());
        }
        digest.update(&buffer[..read]);
        output
            .write_all(&buffer[..read])
            .map_err(|error| format!("copy addin archive: {error}"))?;
    }
    output
        .sync_all()
        .map_err(|error| format!("flush verified archive copy: {error}"))?;
    let actual = format!("{:x}", digest.finalize());
    if !actual.eq_ignore_ascii_case(expected_sha256) {
        return Err("addin archive SHA-256 does not match".into());
    }
    Ok(())
}

fn extract_archive(archive_path: &Path, package_root: &Path) -> Result<(), String> {
    let file = File::open(archive_path).map_err(|error| format!("open verified ZIP: {error}"))?;
    let mut archive = ZipArchive::new(file).map_err(|error| format!("read addin ZIP: {error}"))?;
    if archive.len() > MAX_ARCHIVE_ENTRIES {
        return Err("addin archive contains too many entries".into());
    }
    let mut seen = HashSet::new();
    let mut extracted = 0u64;
    let mut has_manifest = false;
    let canonical_package = fs::canonicalize(package_root)
        .map_err(|error| format!("resolve staging package: {error}"))?;

    for index in 0..archive.len() {
        let mut entry = archive
            .by_index(index)
            .map_err(|error| format!("read ZIP entry {index}: {error}"))?;
        let raw_name = std::str::from_utf8(entry.name_raw())
            .map_err(|_| "addin ZIP paths must be valid UTF-8".to_owned())?
            .to_owned();
        let is_directory = entry.is_dir();
        let relative_path = validate_archive_path(&raw_name, is_directory)?;
        let key = relative_path.to_string_lossy().to_lowercase();
        if !seen.insert(key) {
            return Err(format!("duplicate addin ZIP path: {raw_name}"));
        }
        if relative_path == Path::new(".ready") {
            return Err("addin ZIP must not provide the ready marker".into());
        }
        if let Some(mode) = entry.unix_mode() {
            match mode & 0o170000 {
                0 => {}
                0o040000 if is_directory => {}
                0o100000 if !is_directory => {}
                _ => return Err(format!("special file in addin ZIP: {raw_name}")),
            }
        }

        let destination = package_root.join(&relative_path);
        if !destination.starts_with(package_root) {
            return Err(format!("addin ZIP path escapes staging root: {raw_name}"));
        }
        if is_directory {
            if entry.size() != 0 {
                return Err(format!("directory entry contains data: {raw_name}"));
            }
            fs::create_dir_all(&destination)
                .map_err(|error| format!("create extracted directory: {error}"))?;
            continue;
        }

        if entry.size() > MAX_EXTRACTED_BYTES.saturating_sub(extracted) {
            return Err("addin archive exceeds the expanded size limit".into());
        }
        if relative_path == Path::new("addon.json") {
            has_manifest = true;
        }
        let parent = destination
            .parent()
            .ok_or_else(|| "invalid addin ZIP destination".to_owned())?;
        fs::create_dir_all(parent)
            .map_err(|error| format!("create extracted directory: {error}"))?;
        if !fs::canonicalize(parent)
            .map_err(|error| format!("resolve extracted directory: {error}"))?
            .starts_with(&canonical_package)
        {
            return Err(format!("addin ZIP path escapes staging root: {raw_name}"));
        }
        let mut output = OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&destination)
            .map_err(|error| format!("create extracted file {raw_name}: {error}"))?;
        let expected_size = entry.size();
        let mut written = 0u64;
        let mut buffer = [0u8; 64 * 1024];
        loop {
            let read = entry
                .read(&mut buffer)
                .map_err(|error| format!("extract ZIP entry {raw_name}: {error}"))?;
            if read == 0 {
                break;
            }
            let next = written.saturating_add(read as u64);
            if next > expected_size || next > MAX_EXTRACTED_BYTES.saturating_sub(extracted) {
                return Err("addin archive exceeds the expanded size limit".into());
            }
            output
                .write_all(&buffer[..read])
                .map_err(|error| format!("write extracted file: {error}"))?;
            written = next;
        }
        if written != expected_size {
            return Err(format!("truncated ZIP entry: {raw_name}"));
        }
        output
            .sync_all()
            .map_err(|error| format!("flush extracted file: {error}"))?;
        extracted = extracted.saturating_add(written);
    }
    if !has_manifest {
        return Err("addin ZIP is missing addon.json".into());
    }
    Ok(())
}

fn validate_archive_path(name: &str, is_directory: bool) -> Result<PathBuf, String> {
    if name.is_empty()
        || name.starts_with('/')
        || name.starts_with('\\')
        || name.contains('\\')
        || name.contains(':')
        || name.chars().any(char::is_control)
        || name.ends_with('/') != is_directory
    {
        return Err(format!("unsafe addin ZIP path: {name}"));
    }
    let normalized = if is_directory {
        name.strip_suffix('/').unwrap_or(name)
    } else {
        name
    };
    let mut path = PathBuf::new();
    for segment in normalized.split('/') {
        if segment.is_empty()
            || segment == "."
            || segment == ".."
            || segment.ends_with(['.', ' '])
            || is_windows_device_name(segment)
        {
            return Err(format!("unsafe addin ZIP path: {name}"));
        }
        path.push(segment);
    }
    if path
        .components()
        .any(|component| !matches!(component, Component::Normal(_)))
    {
        return Err(format!("unsafe addin ZIP path: {name}"));
    }
    Ok(path)
}

fn is_windows_device_name(segment: &str) -> bool {
    let base = segment
        .split('.')
        .next()
        .unwrap_or(segment)
        .to_ascii_uppercase();
    matches!(base.as_str(), "CON" | "PRN" | "AUX" | "NUL")
        || (base.len() == 4
            && (base.starts_with("COM") || base.starts_with("LPT"))
            && matches!(base.as_bytes()[3], b'1'..=b'9'))
}

fn validate_manifest(package_root: &Path, id: &str, version: &str) -> Result<(), String> {
    let manifest_path = package_root.join("addon.json");
    let metadata = fs::symlink_metadata(&manifest_path)
        .map_err(|error| format!("inspect addon.json: {error}"))?;
    if metadata.file_type().is_symlink() || !metadata.is_file() {
        return Err("addon.json must be a regular file".into());
    }
    if metadata.len() > MAX_MANIFEST_BYTES {
        return Err("addon.json exceeds the size limit".into());
    }
    let manifest = serde_json::from_slice::<AddonManifest>(
        &fs::read(&manifest_path).map_err(|error| format!("read addon.json: {error}"))?,
    )
    .map_err(|error| format!("parse addon.json: {error}"))?;
    if manifest.id != id || manifest.version != version {
        return Err("addon.json id/version does not match the requested package".into());
    }
    let _ = parse_release_version(&manifest.version)?;
    if manifest.entry != ENTRY_POINT {
        return Err(format!("unsupported addon entry: {}", manifest.entry));
    }
    let minimum_app = parse_release_version(&manifest.minimum_app_version)
        .map_err(|_| "addon.json minimumAppVersion must be a stable x.y.z version".to_owned())?;
    let current_app = parse_release_version(env!("CARGO_PKG_VERSION"))
        .map_err(|_| "application version must be a stable x.y.z version".to_owned())?;
    if minimum_app > current_app {
        return Err("addin requires a newer WasabiPad version".into());
    }
    let entry_path = package_root.join(ENTRY_POINT);
    let entry_metadata = fs::symlink_metadata(&entry_path)
        .map_err(|error| format!("inspect addon entry: {error}"))?;
    if entry_metadata.file_type().is_symlink() || !entry_metadata.is_file() {
        return Err("addon entry must be a regular file".into());
    }
    let canonical_root = fs::canonicalize(package_root)
        .map_err(|error| format!("resolve staging package: {error}"))?;
    let canonical_entry =
        fs::canonicalize(&entry_path).map_err(|error| format!("resolve addon entry: {error}"))?;
    if !canonical_entry.starts_with(&canonical_root) {
        return Err("addon entry resolves outside its package".into());
    }
    Ok(())
}

fn write_ready_marker(package_root: &Path) -> Result<(), String> {
    OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(package_root.join(".ready"))
        .and_then(|mut file| file.write_all(b"ready\n"))
        .map_err(|error| format!("write addin ready marker: {error}"))
}

fn ensure_child_directory(parent: &Path, path: &Path) -> Result<(), String> {
    match fs::symlink_metadata(path) {
        Ok(metadata) if metadata.file_type().is_symlink() || !metadata.is_dir() => {
            return Err(format!(
                "managed directory is not a regular directory: {}",
                path.display()
            ));
        }
        Ok(_) => {}
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            fs::create_dir(path).map_err(|error| format!("create managed directory: {error}"))?;
        }
        Err(error) => return Err(format!("inspect managed directory: {error}")),
    }
    let canonical_parent = fs::canonicalize(parent)
        .map_err(|error| format!("resolve managed directory parent: {error}"))?;
    let canonical_path =
        fs::canonicalize(path).map_err(|error| format!("resolve managed directory: {error}"))?;
    if !canonical_path.starts_with(canonical_parent) {
        return Err(format!(
            "managed directory escapes its parent: {}",
            path.display()
        ));
    }
    Ok(())
}

fn create_staging_directory(parent: &Path, id: &str, version: &str) -> Result<PathBuf, String> {
    for _ in 0..64 {
        let nonce = NEXT_JOB_ID.fetch_add(1, Ordering::Relaxed);
        let tick = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap_or_default()
            .as_nanos();
        let path = parent.join(format!(
            "{id}-{version}-{}-{tick}-{nonce}",
            std::process::id()
        ));
        match fs::create_dir(&path) {
            Ok(()) => return Ok(path),
            Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => continue,
            Err(error) => return Err(format!("create addin staging directory: {error}")),
        }
    }
    Err("could not allocate a unique addin staging directory".into())
}

fn package_is_ready(addins_root: &Path, id: &str, version: &str) -> Result<bool, String> {
    let id_directory = addins_root.join(id);
    let package = id_directory.join(version);
    if !is_managed_directory(addins_root, &id_directory)? {
        return Ok(false);
    }
    if !is_managed_directory(addins_root, &package)? {
        return Ok(false);
    }
    let marker = package.join(".ready");
    match fs::symlink_metadata(&marker) {
        Ok(metadata) => Ok(!metadata.file_type().is_symlink() && metadata.is_file()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(false),
        Err(error) => Err(format!("inspect addin ready marker: {error}")),
    }
}

fn is_managed_directory(root: &Path, path: &Path) -> Result<bool, String> {
    let metadata = match fs::symlink_metadata(path) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(false),
        Err(error) => return Err(format!("inspect managed addin directory: {error}")),
    };
    if metadata.file_type().is_symlink() || !metadata.is_dir() {
        return Ok(false);
    }
    let canonical = fs::canonicalize(path)
        .map_err(|error| format!("resolve managed addin directory: {error}"))?;
    if !canonical.starts_with(root) {
        return Err("managed addin directory resolves outside addins root".into());
    }
    Ok(true)
}

fn ensure_managed_directory(root: &Path, path: &Path) -> Result<(), String> {
    if is_managed_directory(root, path)? {
        Ok(())
    } else {
        Err("addin version directory is not a managed regular directory".into())
    }
}

fn remove_managed_version(addins_root: &Path, id: &str, version: &str) -> Result<(), String> {
    let id_directory = addins_root.join(id);
    if !is_managed_directory(addins_root, &id_directory)? {
        return Ok(());
    }
    let package = id_directory.join(version);
    if !is_managed_directory(addins_root, &package)? {
        return Ok(());
    }
    let canonical_package = fs::canonicalize(&package)
        .map_err(|error| format!("resolve addin version to remove: {error}"))?;
    if canonical_package == addins_root || !canonical_package.starts_with(addins_root) {
        return Err("refusing to remove a path outside the addins root".into());
    }
    fs::remove_dir_all(canonical_package)
        .map_err(|error| format!("remove local addin version: {error}"))
}

fn remove_managed_addon(addins_root: &Path, id: &str) -> Result<(), String> {
    let addon_directory = addins_root.join(id);
    if !is_managed_directory(addins_root, &addon_directory)? {
        return Ok(());
    }
    let canonical_addon = fs::canonicalize(&addon_directory)
        .map_err(|error| format!("resolve addin directory to remove: {error}"))?;
    if canonical_addon == addins_root || !canonical_addon.starts_with(addins_root) {
        return Err("refusing to remove a path outside the addins root".into());
    }
    fs::remove_dir_all(canonical_addon).map_err(|error| format!("remove local addin: {error}"))
}
