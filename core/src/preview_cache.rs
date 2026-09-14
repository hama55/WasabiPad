use std::fs::{self, File, OpenOptions};
use std::io::{self, Read, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};

const CACHE_DIRECTORY: &str = ".wasabipad-preview-cache";
const CACHE_SUFFIX: &str = ".wasabipad-preview";
const CACHE_MAGIC: &[u8] = b"WASABIPAD-PREVIEW-CACHE\0";
const MAX_CACHE_PAYLOAD_BYTES: u64 = crate::ziptext::MAX_ENTRY as u64;
const MAX_FINGERPRINT_BYTES: usize = 4096;
const MAX_CACHE_FILE_BYTES: u64 = MAX_CACHE_PAYLOAD_BYTES
    + CACHE_MAGIC.len() as u64
    + std::mem::size_of::<u64>() as u64
    + MAX_FINGERPRINT_BYTES as u64;
static NEXT_TEMP_ID: AtomicU64 = AtomicU64::new(0);

/// 外部プレビューキャッシュを管理する。保存先は利用者が選んだディレクトリで、
/// 実データは専用の子ディレクトリにだけ保存する。
pub struct PreviewCache {
    root: PathBuf,
}

impl PreviewCache {
    pub fn default_root() -> io::Result<PathBuf> {
        let local = std::env::var_os("LOCALAPPDATA").ok_or_else(|| {
            io::Error::new(io::ErrorKind::NotFound, "LOCALAPPDATA が取得できません")
        })?;
        Ok(PathBuf::from(local).join("WasabiPad"))
    }

    pub fn new(root: PathBuf) -> Self {
        Self { root }
    }

    pub fn directory(&self) -> PathBuf {
        self.storage_root()
    }

    pub fn load(&self, key: &str, fingerprint: &str) -> io::Result<Option<Vec<u8>>> {
        let path = self.cache_path(key);
        let mut file = match File::open(path) {
            Ok(file) => file,
            Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(None),
            Err(error) => return Err(error),
        };
        if file.metadata()?.len() > MAX_CACHE_FILE_BYTES {
            return Ok(None);
        }
        let mut encoded = Vec::new();
        file.read_to_end(&mut encoded)?;
        let Some(payload) = decode_cache(&encoded, fingerprint) else {
            return Ok(None);
        };
        Ok(Some(payload.to_vec()))
    }

    pub fn save(&self, key: &str, fingerprint: &str, bytes: &[u8]) -> io::Result<()> {
        if bytes.len() as u64 > MAX_CACHE_PAYLOAD_BYTES {
            return Err(io::Error::new(
                io::ErrorKind::FileTooLarge,
                "プレビューキャッシュの資産サイズが大きすぎます",
            ));
        }
        if fingerprint.len() > MAX_FINGERPRINT_BYTES {
            return Err(io::Error::new(
                io::ErrorKind::InvalidInput,
                "プレビューキャッシュの識別情報が長すぎます",
            ));
        }
        let directory = self.storage_root();
        fs::create_dir_all(&directory)?;
        let path = self.cache_path(key);
        let id = NEXT_TEMP_ID.fetch_add(1, Ordering::Relaxed);
        let temp = directory.join(format!(
            ".{file_name}.tmp-{}-{id}",
            std::process::id(),
            file_name = path.file_name().and_then(|name| name.to_str()).unwrap_or("entry"),
        ));
        let result = (|| {
            let mut file = OpenOptions::new()
                .create_new(true)
                .write(true)
                .open(&temp)?;
            file.write_all(CACHE_MAGIC)?;
            file.write_all(&(fingerprint.len() as u64).to_le_bytes())?;
            file.write_all(fingerprint.as_bytes())?;
            file.write_all(bytes)?;
            file.sync_all()?;
            replace_file(&temp, &path)
        })();
        if result.is_err() {
            let _ = fs::remove_file(&temp);
        }
        result
    }

    pub fn clear(&self) -> io::Result<()> {
        let directory = self.storage_root();
        let entries = match fs::read_dir(&directory) {
            Ok(entries) => entries,
            Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(()),
            Err(error) => return Err(error),
        };
        for entry in entries {
            let entry = entry?;
            let path = entry.path();
            let metadata = fs::symlink_metadata(&path)?;
            if metadata.file_type().is_file()
                && path
                    .file_name()
                    .and_then(|name| name.to_str())
                    .is_some_and(|name| name.ends_with(CACHE_SUFFIX))
            {
                fs::remove_file(path)?;
            }
        }
        Ok(())
    }

    pub fn total_bytes(&self) -> io::Result<u64> {
        let directory = self.storage_root();
        let entries = match fs::read_dir(&directory) {
            Ok(entries) => entries,
            Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(0),
            Err(error) => return Err(error),
        };
        let mut total: u64 = 0;
        for entry in entries {
            let entry = entry?;
            let path = entry.path();
            let metadata = fs::symlink_metadata(&path)?;
            if metadata.file_type().is_file()
                && path
                    .file_name()
                    .and_then(|name| name.to_str())
                    .is_some_and(|name| name.ends_with(CACHE_SUFFIX))
            {
                total = total.saturating_add(metadata.len());
            }
        }
        Ok(total)
    }

    fn storage_root(&self) -> PathBuf {
        self.root.join(CACHE_DIRECTORY)
    }

    fn cache_path(&self, key: &str) -> PathBuf {
        let first = stable_hash(key.as_bytes(), 0xcbf29ce484222325);
        let second = stable_hash(key.as_bytes(), 0x84222325cbf29ce4);
        self.storage_root()
            .join(format!("{first:016x}{second:016x}{CACHE_SUFFIX}"))
    }
}

fn stable_hash(bytes: &[u8], mut hash: u64) -> u64 {
    for byte in bytes {
        hash ^= u64::from(*byte);
        hash = hash.wrapping_mul(0x100000001b3);
    }
    hash
}

fn decode_cache<'a>(encoded: &'a [u8], fingerprint: &str) -> Option<&'a [u8]> {
    if !encoded.starts_with(CACHE_MAGIC) {
        return None;
    }
    let length_start = CACHE_MAGIC.len();
    let length_end = length_start.checked_add(std::mem::size_of::<u64>())?;
    let length_bytes: [u8; 8] = encoded.get(length_start..length_end)?.try_into().ok()?;
    let fingerprint_len = usize::try_from(u64::from_le_bytes(length_bytes)).ok()?;
    let fingerprint_start = length_end;
    let payload_start = fingerprint_start.checked_add(fingerprint_len)?;
    let stored = encoded.get(fingerprint_start..payload_start)?;
    (stored == fingerprint.as_bytes()).then(|| encoded.get(payload_start..)).flatten()
}

#[cfg(target_os = "windows")]
fn replace_file(source: &Path, target: &Path) -> io::Result<()> {
    use std::os::windows::ffi::OsStrExt;
    use windows_sys::Win32::Storage::FileSystem::{
        MoveFileExW, MOVEFILE_REPLACE_EXISTING, MOVEFILE_WRITE_THROUGH,
    };

    let source: Vec<u16> = source.as_os_str().encode_wide().chain(Some(0)).collect();
    let target: Vec<u16> = target.as_os_str().encode_wide().chain(Some(0)).collect();
    let moved = unsafe {
        MoveFileExW(
            source.as_ptr(),
            target.as_ptr(),
            MOVEFILE_REPLACE_EXISTING | MOVEFILE_WRITE_THROUGH,
        )
    };
    if moved == 0 {
        Err(io::Error::last_os_error())
    } else {
        Ok(())
    }
}

#[cfg(not(target_os = "windows"))]
fn replace_file(source: &Path, target: &Path) -> io::Result<()> {
    fs::rename(source, target)
}

#[cfg(test)]
mod tests {
    use super::PreviewCache;
    use std::fs;
    use std::path::PathBuf;
    use std::time::{SystemTime, UNIX_EPOCH};

    fn test_root(name: &str) -> PathBuf {
        let nonce = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        std::env::temp_dir().join(format!("wasabipad-preview-cache-{name}-{nonce}"))
    }

    // Feature: プレビューキャッシュ
    // Scenario: 保存した資産を同じfingerprintで読み込む
    // Given: 空のプレビューキャッシュStoreがある
    // When: キー、fingerprint、資産バイト列を保存してから読み込む
    // Then: 保存した資産バイト列を返す
    #[test]
    fn saves_and_loads_bytes_for_the_same_fingerprint() {
        let root = test_root("roundtrip");
        let cache = PreviewCache::new(root.clone());

        cache.save("C:\\docs\\manual.pdf::page", "stamp-a", b"pdf-bytes").unwrap();

        assert_eq!(
            cache.load("C:\\docs\\manual.pdf::page", "stamp-a").unwrap(),
            Some(b"pdf-bytes".to_vec()),
        );
        let _ = fs::remove_dir_all(root);
    }

    // Feature: プレビューキャッシュ
    // Scenario: 元データが変更された資産を再利用しない
    // Given: fingerprint `stamp-a`の資産を保存している
    // When: fingerprint `stamp-b`で同じキーを読み込む
    // Then: キャッシュミスとしてNoneを返す
    #[test]
    fn misses_when_the_fingerprint_changes() {
        let root = test_root("fingerprint");
        let cache = PreviewCache::new(root.clone());
        cache.save("manual.pdf", "stamp-a", b"old").unwrap();

        assert_eq!(cache.load("manual.pdf", "stamp-b").unwrap(), None);
        let _ = fs::remove_dir_all(root);
    }

    // Feature: プレビューキャッシュ
    // Scenario: キャッシュ容量を確認して全削除する
    // Given: 2つのプレビュー資産を保存している
    // When: 容量を取得してから全削除する
    // Then: 保存中の容量が正しく、削除後は0になる
    #[test]
    fn reports_size_and_clears_only_preview_cache_files() {
        let root = test_root("clear");
        let cache = PreviewCache::new(root.clone());
        cache.save("one", "a", b"123").unwrap();
        cache.save("two", "b", b"4567").unwrap();
        fs::write(root.join("keep.txt"), b"keep").unwrap();

        assert!(cache.total_bytes().unwrap() >= 7);
        cache.clear().unwrap();
        assert_eq!(cache.total_bytes().unwrap(), 0);
        assert!(root.join("keep.txt").is_file());
        let _ = fs::remove_dir_all(root);
    }

    // Feature: プレビューキャッシュ
    // Scenario: 危険なキーを保存してもキャッシュ場所の外へ出ない
    // Given: 区切り文字と親ディレクトリ記号を含むキーがある
    // When: そのキーで資産を保存する
    // Then: ルート直下の専用ファイルだけが作られ、ルート外には作られない
    #[test]
    fn keeps_unsafe_keys_inside_the_cache_root() {
        let root = test_root("unsafe-key");
        let cache = PreviewCache::new(root.clone());
        let outside = root.parent().unwrap().join("outside");

        cache.save(r"..\outside\secret", "stamp", b"secret").unwrap();

        assert!(!outside.exists());
        assert!(cache.total_bytes().unwrap() > 0);
        let _ = fs::remove_dir_all(root);
    }

    // Feature: プレビューキャッシュの資産上限
    // Scenario: 通常の資産上限を超えるキャッシュを保存・読み込みしない
    // Given: 通常の資産上限を超えるバイト列と異常に大きいキャッシュファイルがある
    // When: 保存と読み込みを実行する
    // Then: 保存はFileTooLargeになり、読み込みはNoneを返す
    #[test]
    fn rejects_cache_entries_over_the_asset_limit() {
        let root = test_root("size-limit");
        let cache = PreviewCache::new(root.clone());
        let oversized = vec![0u8; crate::ziptext::MAX_ENTRY + 1];

        assert_eq!(
            cache.save("oversized", "stamp", &oversized).unwrap_err().kind(),
            std::io::ErrorKind::FileTooLarge
        );

        fs::create_dir_all(cache.directory()).unwrap();
        let path = cache.cache_path("oversized-file");
        fs::File::create(path)
            .unwrap()
            .set_len(super::MAX_CACHE_FILE_BYTES + 1)
            .unwrap();
        assert_eq!(cache.load("oversized-file", "stamp").unwrap(), None);

        let _ = fs::remove_dir_all(root);
    }
}
