// WasabiPad コア: UI非依存の文書モデルと編集エンジン。
// buffer/hugebuf/fileio が mmap+overlay の省メモリ文書を、undo が編集履歴を、
// doc が Tauri/GUI から叩く高レベルAPI(可視行取得・編集・検索・保存)を提供する。
mod archive;
mod archive_port;
mod bookmarks;
mod buffer;
mod doc;
mod fileio;
mod filename;
mod folder;
mod fuzzy;
mod hugebuf;
mod search;
mod settings;
mod sevenz;
mod undo;
mod workspace_search;
mod xlstext;
mod ziptext;

pub use bookmarks::{load as load_bookmarks, save as save_bookmarks, Node as BookmarkNode};
pub use doc::{
    Doc, DocInfo, EditManyItem, EditManyResult, EditResult, ExternalCheck, FindCursor,
    FindOutcome, FindResult, FolderEntry, PosC, ReplaceChunkResult, SaveOutcome,
    WorkspaceSearchResult,
};
pub use fileio::{Encoding, EncodingId, Eol};
pub use filename::{next_available_path, validate_windows_file_name};
pub use settings::{load as load_settings, update as update_setting};
pub use workspace_search::{search_workspace, FileNameMatchMode, SearchOptions, WorkspaceSearchOutcome};
