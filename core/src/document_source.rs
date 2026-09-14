use crate::fileio::FileStamp;
use crate::protocol;
use crate::ziptext::Entry;
use std::fs::File;
use std::path::{Path, PathBuf};

// 文書の所在・閲覧対象だけを担当する。本文・Undo・検索状態は所有しない。
pub(crate) enum Target {
    None,
    File {
        path: PathBuf,
        source_file: Option<File>,
        stamp: Option<FileStamp>,
    },
    Archive {
        path: PathBuf,
        source_file: Option<File>,
        entries: Option<Vec<Entry>>,
        editable_entry: Option<String>,
    },
}

pub(crate) struct DocumentSource {
    pub(crate) root: Option<PathBuf>,
    pub(crate) target: Target,
}

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub(crate) enum SourceKind {
    Text,
    Archive,
}

impl DocumentSource {
    pub(crate) fn untitled() -> Self {
        Self {
            root: None,
            target: Target::None,
        }
    }

    pub(crate) fn file(path: PathBuf, source_file: Option<File>, stamp: Option<FileStamp>) -> Self {
        Self {
            root: None,
            target: Target::File {
                path,
                source_file,
                stamp,
            },
        }
    }

    pub(crate) fn path(&self) -> Option<&Path> {
        match &self.target {
            Target::File { path, .. } => Some(path),
            _ => None,
        }
    }

    pub(crate) fn folder_root(&self) -> Option<&Path> {
        self.root.as_deref()
    }

    pub(crate) fn entries(&self) -> Option<&[Entry]> {
        match &self.target {
            Target::Archive {
                entries: Some(entries),
                ..
            } => Some(entries),
            _ => None,
        }
    }

    pub(crate) fn is_view_only_with_extension(&self, effective_extension: Option<&str>) -> bool {
        matches!(
            &self.target,
            Target::Archive {
                editable_entry: None,
                ..
            }
        ) || matches!(&self.target, Target::File { path, .. } if is_binary_image_with_extension(path, effective_extension))
    }

    #[cfg(test)]
    pub(crate) fn is_view_only(&self) -> bool {
        self.is_view_only_with_extension(None)
    }

    pub(crate) fn kind(&self) -> SourceKind {
        if self.root.is_none() && matches!(self.target, Target::Archive { .. }) {
            SourceKind::Archive
        } else {
            SourceKind::Text
        }
    }

    pub(crate) fn display_path(&self) -> Option<&Path> {
        match &self.target {
            Target::File { path, .. } | Target::Archive { path, .. } => Some(path),
            Target::None => None,
        }
    }

    pub(crate) fn set_source_file(&mut self, source: Option<File>) {
        if let Target::File { source_file, .. } = &mut self.target {
            *source_file = source;
        }
    }

    pub(crate) fn take_source_file(&mut self) -> Option<File> {
        match &mut self.target {
            Target::File { source_file, .. } => source_file.take(),
            _ => None,
        }
    }

    pub(crate) fn stamp(&self) -> Option<FileStamp> {
        match &self.target {
            Target::File { stamp, .. } => *stamp,
            _ => None,
        }
    }

    pub(crate) fn set_stamp(&mut self, new: Option<FileStamp>) {
        if let Target::File { stamp, .. } = &mut self.target {
            *stamp = new;
        }
    }
}

pub(crate) fn is_binary_image_path(path: &Path) -> bool {
    is_binary_image_with_extension(path, None)
}

pub(crate) fn is_binary_image_with_extension(path: &Path, effective_extension: Option<&str>) -> bool {
    effective_extension
        .or_else(|| path.extension().and_then(|ext| ext.to_str()))
        .is_some_and(|ext| !ext.eq_ignore_ascii_case("svg") && protocol::is_image_extension(ext))
}
