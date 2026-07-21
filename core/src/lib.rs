// PetaPad コア: UI非依存の文書モデルと編集エンジン。
// buffer/hugebuf/fileio が mmap+overlay の省メモリ文書を、undo が編集履歴を、
// doc が Tauri/GUI から叩く高レベルAPI(可視行取得・編集・検索・保存)を提供する。
pub mod bookmarks;
mod archive;
pub mod buffer;
pub mod doc;
pub mod fileio;
pub mod hugebuf;
pub mod undo;
pub mod xlstext;
pub mod ziptext;
