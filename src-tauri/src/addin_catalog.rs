use reqwest::blocking::{Client, Response};
use reqwest::Url;
use serde::Deserialize;
use std::collections::HashSet;
use std::fs::File;
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::time::Duration;

const OFFICIAL_CATALOG_URL: &str =
    "https://raw.githubusercontent.com/hama55/WasabiPad/main/addins/catalog.json";
const MAX_CATALOG_BYTES: u64 = 1024 * 1024;

#[derive(Clone, Debug, PartialEq, Eq, serde::Serialize, ts_rs::TS)]
#[serde(rename_all = "camelCase")]
#[ts(rename_all = "camelCase")]
#[ts(export)]
pub struct OfficialAddon {
    pub id: String,
    pub version: String,
    pub minimum_app_version: String,
    pub compatible: bool,
    pub archive_url: String,
    pub sha256: String,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct CatalogDocument {
    schema: u32,
    addons: Vec<CatalogAddon>,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
#[serde(rename_all = "camelCase")]
struct CatalogAddon {
    id: String,
    version: String,
    minimum_app_version: String,
    archive_url: String,
    sha256: String,
}

struct TemporaryArchive(PathBuf);

impl Drop for TemporaryArchive {
    fn drop(&mut self) {
        let _ = std::fs::remove_file(&self.0);
    }
}

pub fn fetch_official_catalog() -> Result<Vec<OfficialAddon>, String> {
    fetch_catalog_from_url(OFFICIAL_CATALOG_URL)
}

#[cfg(test)]
pub(crate) fn fetch_official_catalog_at(url: &str) -> Result<Vec<OfficialAddon>, String> {
    fetch_catalog_from_url(url)
}

fn fetch_catalog_from_url(url: &str) -> Result<Vec<OfficialAddon>, String> {
    let response = client()?
        .get(url)
        .send()
        .map_err(|error| format!("download official addin catalog: {error}"))?
        .error_for_status()
        .map_err(|error| format!("official addin catalog request failed: {error}"))?;
    let bytes = read_limited(response, MAX_CATALOG_BYTES, "official addin catalog")?;
    parse_catalog(&bytes)
}

pub fn install_or_update_official(app_data_root: &Path, id: &str) -> Result<(), String> {
    install_from_catalog(app_data_root, id, fetch_official_catalog()?, None)
}

#[cfg(test)]
pub(crate) fn install_or_update_official_at(
    app_data_root: &Path,
    id: &str,
    catalog_url: &str,
    archive_download_url: &str,
) -> Result<(), String> {
    install_from_catalog(
        app_data_root,
        id,
        fetch_official_catalog_at(catalog_url)?,
        Some(archive_download_url),
    )
}

fn install_from_catalog(
    app_data_root: &Path,
    id: &str,
    catalog: Vec<OfficialAddon>,
    archive_download_url: Option<&str>,
) -> Result<(), String> {
    super::addin_manager::validate_id(id)?;
    let addon = catalog
        .into_iter()
        .find(|addon| addon.id == id)
        .ok_or_else(|| format!("official addin catalog has no entry for {id}"))?;
    if !addon.compatible {
        return Err(format!("addin {id} requires a newer WasabiPad version"));
    }
    let download_url = archive_download_url.unwrap_or(&addon.archive_url);
    download_archive_and_install(app_data_root, &addon, download_url)
}

fn download_archive_and_install(
    app_data_root: &Path,
    addon: &OfficialAddon,
    download_url: &str,
) -> Result<(), String> {
    let response = client()?
        .get(download_url)
        .send()
        .map_err(|error| format!("download official addin archive: {error}"))?
        .error_for_status()
        .map_err(|error| format!("official addin archive request failed: {error}"))?;
    if response
        .content_length()
        .is_some_and(|length| length > super::addin_manager::MAX_ARCHIVE_BYTES)
    {
        return Err("official addin archive exceeds the size limit".into());
    }

    let (path, file) = super::addin_manager::create_download_temp_file(app_data_root)?;
    let temporary = TemporaryArchive(path.clone());
    stream_archive(response, file)?;
    super::addin_manager::install_verified_archive(
        app_data_root,
        &addon.id,
        &addon.version,
        &temporary.0,
        &addon.sha256,
    )
}

fn stream_archive(mut response: Response, mut file: File) -> Result<(), String> {
    let mut total = 0_u64;
    let mut buffer = [0_u8; 64 * 1024];
    loop {
        let read = response
            .read(&mut buffer)
            .map_err(|error| format!("read official addin archive: {error}"))?;
        if read == 0 {
            break;
        }
        total = total.saturating_add(read as u64);
        if total > super::addin_manager::MAX_ARCHIVE_BYTES {
            return Err("official addin archive exceeds the size limit".into());
        }
        file.write_all(&buffer[..read])
            .map_err(|error| format!("write temporary addin archive: {error}"))?;
    }
    file.sync_all()
        .map_err(|error| format!("flush temporary addin archive: {error}"))
}

fn parse_catalog(bytes: &[u8]) -> Result<Vec<OfficialAddon>, String> {
    let document = serde_json::from_slice::<CatalogDocument>(bytes)
        .map_err(|error| format!("parse official addin catalog: {error}"))?;
    if document.schema != 1 {
        return Err("unsupported official addin catalog schema".into());
    }
    if document.addons.len() > 2 {
        return Err("official addin catalog has too many entries".into());
    }
    let current_app = super::addin_manager::parse_release_version(env!("CARGO_PKG_VERSION"))?;
    let mut ids = HashSet::new();
    let mut addons = Vec::with_capacity(document.addons.len());
    for addon in document.addons {
        super::addin_manager::validate_id(&addon.id)?;
        if !ids.insert(addon.id.clone()) {
            return Err(format!("duplicate official addin id: {}", addon.id));
        }
        super::addin_manager::validate_version(&addon.version)?;
        let minimum_app = super::addin_manager::parse_release_version(&addon.minimum_app_version)?;
        super::addin_manager::validate_sha256(&addon.sha256)?;
        validate_archive_url(&addon.archive_url)?;
        addons.push(OfficialAddon {
            id: addon.id,
            version: addon.version,
            minimum_app_version: addon.minimum_app_version,
            compatible: minimum_app <= current_app,
            archive_url: addon.archive_url,
            sha256: addon.sha256.to_ascii_lowercase(),
        });
    }
    Ok(addons)
}

fn validate_archive_url(value: &str) -> Result<(), String> {
    let url = Url::parse(value).map_err(|_| "invalid official addin archive URL".to_owned())?;
    if url.scheme() != "https"
        || url.host_str() != Some("github.com")
        || url.port().is_some_and(|port| port != 443)
        || !url.username().is_empty()
        || url.password().is_some()
        || url.query().is_some()
        || url.fragment().is_some()
    {
        return Err("addin archive URL must use the official GitHub releases host".into());
    }
    let segments: Vec<_> = url
        .path_segments()
        .ok_or_else(|| "invalid official addin archive URL path".to_owned())?
        .collect();
    if segments.len() != 6
        || segments[..4] != ["hama55", "WasabiPad", "releases", "download"]
        || !safe_release_component(segments[4])
        || !safe_release_component(segments[5])
        || !segments[5]
            .strip_suffix(".zip")
            .is_some_and(|filename| !filename.is_empty())
    {
        return Err("addin archive URL must name a safe official release ZIP".into());
    }
    Ok(())
}

fn safe_release_component(value: &str) -> bool {
    !value.is_empty()
        && value != "."
        && value != ".."
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'_' | b'+' | b'-'))
        && !value.ends_with('.')
}

fn read_limited(response: Response, limit: u64, label: &str) -> Result<Vec<u8>, String> {
    if response
        .content_length()
        .is_some_and(|length| length > limit)
    {
        return Err(format!("{label} exceeds the size limit"));
    }
    let mut bytes = Vec::new();
    response
        .take(limit + 1)
        .read_to_end(&mut bytes)
        .map_err(|error| format!("read {label}: {error}"))?;
    if bytes.len() as u64 > limit {
        return Err(format!("{label} exceeds the size limit"));
    }
    Ok(bytes)
}

fn client() -> Result<Client, String> {
    Client::builder()
        .connect_timeout(Duration::from_secs(10))
        .timeout(Duration::from_secs(120))
        .build()
        .map_err(|error| format!("create official addin HTTP client: {error}"))
}
