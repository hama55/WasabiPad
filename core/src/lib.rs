// WasabiPad コア: UI非依存の文書モデルと編集エンジン。
// buffer/hugebuf/fileio が mmap+overlay の省メモリ文書を、undo が編集履歴を、
// doc が Tauri/GUI から叩く高レベルAPI(可視行取得・編集・検索・保存)を提供する。
mod archive;
mod bookmarks;
mod buffer;
mod doc;
mod fileio;
mod hugebuf;
mod undo;
mod workspace_search;
mod xlstext;
mod ziptext;

pub use bookmarks::{load as load_bookmarks, save as save_bookmarks, Node as BookmarkNode};
pub use doc::{
    Doc, DocInfo, EditManyItem, EditManyResult, EditResult, FindCursor, FindOutcome,
    FindResult, FolderEntry, PosC, ReplaceChunkResult, WorkspaceSearchResult,
};
pub use fileio::{Encoding, EncodingId, Eol};
pub use workspace_search::search_workspace;
