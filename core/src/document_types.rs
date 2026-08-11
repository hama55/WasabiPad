use crate::fileio::{EncodingId, Eol};
use crate::folder::FolderEntry;
use serde::Serialize;

#[derive(Serialize, Clone, Copy, PartialEq, Eq, Debug, ts_rs::TS)]
#[serde(rename_all = "lowercase")]
#[ts(export)]
pub enum DocKind {
    Text,
    Archive,
}

#[derive(Serialize, ts_rs::TS)]
#[ts(export)]
pub struct DocInfo {
    pub kind: DocKind,
    pub line_count: usize,
    pub enc: EncodingId,
    pub eol: Eol,
    pub path: String,
    pub entries: Option<Vec<String>>,
    pub folder_entries: Option<Vec<FolderEntry>>,
    pub folder_root: Option<String>,
    pub view_only: bool,
    pub byte_len: u64,
    pub is_huge: bool,
    pub modified_at: Option<u64>,
}

#[derive(Serialize, serde::Deserialize, Clone, Copy, ts_rs::TS)]
#[ts(export, rename = "Pos")]
pub struct PosC {
    pub line: usize,
    pub col: usize,
}

#[derive(Serialize, ts_rs::TS)]
#[ts(export)]
pub struct EditResult {
    pub caret: PosC,
    pub line_count: usize,
}

#[derive(serde::Deserialize, ts_rs::TS)]
#[ts(export)]
pub struct EditManyItem {
    pub start: PosC,
    pub end: PosC,
    pub text: String,
}

#[derive(Serialize, ts_rs::TS)]
#[ts(export)]
pub struct EditManyResult {
    pub carets: Vec<PosC>,
    pub line_count: usize,
}

#[derive(Serialize, ts_rs::TS)]
#[ts(export)]
pub struct FindResult {
    pub start: PosC,
    pub end: PosC,
}

#[derive(Serialize, Clone, ts_rs::TS)]
#[ts(export)]
pub struct WorkspaceSearchResult {
    pub rel_path: String,
    pub line: usize,
    pub col: usize,
    pub preview: String,
    pub highlights: Vec<[usize; 2]>,
    pub is_filename: bool,
    pub score: i32,
}

#[derive(Serialize, serde::Deserialize, Clone, Copy, ts_rs::TS)]
#[ts(export)]
pub struct FindCursor {
    pub wrapped: bool,
    pub line: usize,
}

#[derive(Serialize, ts_rs::TS)]
#[serde(tag = "kind")]
#[ts(export)]
pub enum FindOutcome {
    Found { start: PosC, end: PosC },
    More { cursor: FindCursor },
    NotFound,
}

#[derive(Serialize, ts_rs::TS)]
#[serde(tag = "kind", rename_all = "lowercase")]
#[ts(export)]
pub enum ExternalCheck {
    Unchanged,
    Reloaded { info: DocInfo },
    Conflict,
}

#[derive(Serialize, Clone, ts_rs::TS)]
#[ts(export)]
pub struct ExternalMergeChange {
    pub start_line: usize,
    pub mine: Vec<String>,
    pub theirs: Vec<String>,
    pub conflict: bool,
}

#[derive(Serialize, Clone, ts_rs::TS)]
#[ts(export)]
pub struct ExternalMergePreview {
    pub changes: Vec<ExternalMergeChange>,
    pub conflict_count: usize,
    pub modified_at: Option<u64>,
}

#[derive(Serialize, Debug, ts_rs::TS)]
#[serde(tag = "kind", rename_all = "lowercase")]
#[ts(export)]
pub enum SaveOutcome {
    Saved,
    SavedWithWarning { warning: String },
    Conflict { saved_to: String },
}

#[derive(Serialize, ts_rs::TS)]
#[ts(export)]
pub struct ReplaceChunkResult {
    pub done: bool,
    pub count: usize,
    pub caret: PosC,
    pub line_count: usize,
}
