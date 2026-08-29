use std::io;
use std::path::Path;
use std::sync::Arc;

pub(crate) const PASSWORD_ERROR_MARKER: &str = crate::protocol::PASSWORD_ERROR_MARKER;

pub(crate) trait ArchiveWorkspacePort: Send {
    fn path(&self) -> &Path;
}

impl ArchiveWorkspacePort for crate::sevenz::ArchiveWorkspace {
    fn path(&self) -> &Path {
        self.path()
    }
}

// Doc が特定のアーカイバ実装へ直接依存しないための境界。
// 実運用では7zを使うが、文書状態のテストや別アーカイバの追加では差し替えられる。
pub(crate) trait ArchivePort: Send + Sync {
    fn supports_path(&self, path: &Path) -> bool;
    fn supports_legacy_zip_fallback(&self, path: &Path) -> bool;
    fn list(&self, archive: &Path, password: &str) -> io::Result<Vec<String>>;
    fn extract(&self, archive: &Path, entry: &str, password: &str) -> io::Result<Vec<u8>>;
    fn preserves_header_encryption(
        &self,
        archive: &Path,
        password: &str,
        is_7z: bool,
    ) -> io::Result<bool>;
    fn is_password_error(&self, error: &io::Error) -> bool;
    fn cleanup_stale_workspaces(&self, parent: &Path) -> io::Result<()>;
    fn new_workspace(&self, archive: &Path) -> io::Result<Box<dyn ArchiveWorkspacePort>>;
    fn update(
        &self,
        archive: &Path,
        entry: &str,
        data_root: &Path,
        password: &str,
        header_encrypted: bool,
    ) -> io::Result<()>;
    fn delete(&self, archive: &Path, entries: &[String], password: &str) -> io::Result<()>;
}

struct SevenZipArchivePort;

impl ArchivePort for SevenZipArchivePort {
    fn supports_path(&self, path: &Path) -> bool {
        crate::sevenz::is_updateable_archive_path(path)
    }

    fn supports_legacy_zip_fallback(&self, path: &Path) -> bool {
        crate::sevenz::is_zip_path(path)
    }

    fn list(&self, archive: &Path, password: &str) -> io::Result<Vec<String>> {
        crate::sevenz::list(archive, password)
    }

    fn extract(&self, archive: &Path, entry: &str, password: &str) -> io::Result<Vec<u8>> {
        crate::sevenz::extract(archive, entry, password)
    }

    fn preserves_header_encryption(
        &self,
        archive: &Path,
        password: &str,
        is_7z: bool,
    ) -> io::Result<bool> {
        if !is_7z || password.is_empty() {
            return Ok(false);
        }
        crate::sevenz::is_header_encrypted(archive)
    }

    fn is_password_error(&self, error: &io::Error) -> bool {
        error.kind() == io::ErrorKind::PermissionDenied
            && error.to_string().contains(PASSWORD_ERROR_MARKER)
    }

    fn cleanup_stale_workspaces(&self, parent: &Path) -> io::Result<()> {
        crate::sevenz::cleanup_stale_workspaces(parent)
    }

    fn new_workspace(&self, archive: &Path) -> io::Result<Box<dyn ArchiveWorkspacePort>> {
        Ok(Box::new(crate::sevenz::ArchiveWorkspace::new(archive)?))
    }

    fn update(
        &self,
        archive: &Path,
        entry: &str,
        data_root: &Path,
        password: &str,
        header_encrypted: bool,
    ) -> io::Result<()> {
        crate::sevenz::update(archive, entry, data_root, password, header_encrypted)
    }

    fn delete(&self, archive: &Path, entries: &[String], password: &str) -> io::Result<()> {
        crate::sevenz::delete(archive, entries, password)
    }
}

pub(crate) fn system() -> Arc<dyn ArchivePort> {
    Arc::new(SevenZipArchivePort)
}
