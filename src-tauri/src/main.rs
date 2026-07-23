// WasabiPad Tauri backend — wasabipad-core を薄くラップするコマンド層。
// 文書本体は core::Doc が所有し、フロントへは可視スライスだけを渡す (全文は渡さない)。
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod state;

use wasabipad_core::{
    self, BookmarkNode, Doc, DocInfo, EditManyItem, EditManyResult, EditResult, EncodingId,
    Eol, FindCursor, FindOutcome, FindResult, FolderEntry, PosC, ReplaceChunkResult,
    WorkspaceSearchResult,
};
use state::{with_doc, DocState, State};
use std::path::PathBuf;
use std::process::Command;
use std::sync::Mutex;

#[tauri::command]
fn open_path(path: String, state: State) -> Result<DocInfo, String> {
    let d = Doc::open(&PathBuf::from(&path)).map_err(|e| e.to_string())?;
    // フォルダを開いた場合 d.path は先頭の実ファイルを指す (フォルダ自体は保存先を持たない)
    let info_path = d
        .path()
        .map(|p| p.to_string_lossy().into_owned())
        .unwrap_or(path);
    let info = d.info(info_path);
    with_doc(&state, |doc| *doc = d);
    Ok(info)
}

#[tauri::command]
fn new_doc(state: State) {
    with_doc(&state, |doc| *doc = Doc::empty());
}

#[tauri::command]
fn close_doc(state: State) {
    with_doc(&state, |doc| *doc = Doc::empty()); // mmap解放 (ファイルロック解除)
}

#[tauri::command]
fn lines(start: usize, count: usize, state: State) -> Vec<String> {
    with_doc(&state, |doc| doc.lines(start, count))
}

#[tauri::command]
fn line_char_len(line: usize, state: State) -> usize {
    with_doc(&state, |doc| doc.line_char_len(line))
}

#[tauri::command]
fn select_entry(rel_path: String, state: State) -> Result<DocInfo, String> {
    with_doc(&state, |doc| doc.select_entry(&rel_path))
        .ok_or_else(|| "no entry".into())
}

// ツリーの展開ボタン用。zip/xlsx/xls の中身一覧だけを安価に取得する (本文は読まない)。
// rel_path が空文字なら直接開いているアーカイブ自身、それ以外はフォルダ内の相対パス。
#[tauri::command]
fn list_archive_entries(rel_path: String, state: State) -> Result<Vec<String>, String> {
    with_doc(&state, |doc| doc.list_archive_entries(&rel_path))
        .ok_or_else(|| "no entries".into())
}

// フォルダの展開時に、その直下だけを取得する。
#[tauri::command]
fn list_folder_entries(rel_dir: String, state: State) -> Result<Vec<FolderEntry>, String> {
    with_doc(&state, |doc| doc.list_folder_entries(&rel_dir))
        .ok_or_else(|| "no entries".into())
}

#[tauri::command]
fn workspace_search(pat: String, match_case: bool, state: State) -> Result<Vec<WorkspaceSearchResult>, String> {
    let root = with_doc(&state, |doc| doc.workspace_root())
        .ok_or_else(|| "folder is not open".to_string())?;
    Ok(wasabipad_core::search_workspace(&root, &pat, match_case))
}

#[tauri::command]
fn create_note(dir: Option<String>, name: String, state: State) -> Result<DocInfo, String> {
    with_doc(&state, |doc| doc.create_note(dir.as_deref(), &name))
        .map_err(|e| e.to_string())
}

#[tauri::command]
fn rename_entry(rel_path: String, new_name: String, state: State) -> Result<DocInfo, String> {
    with_doc(&state, |doc| doc.rename_entry(&rel_path, &new_name))
        .map_err(|e| e.to_string())
}

// サイドバーの「エクスプローラで開く」用。状態を持たないので Doc へは委譲しない。
#[tauri::command]
fn reveal_in_explorer(path: String, is_dir: bool) -> Result<(), String> {
    let mut cmd = std::process::Command::new("explorer");
    if is_dir {
        cmd.arg(&path);
    } else {
        // 空白入りパスでも explorer の legacy parser がパス部分だけを正しく引用できるよう分離する
        cmd.arg("/select,").arg(&path);
    }
    // explorer は既存ウィンドウへ委譲した場合など正常時でも非0を返すことがあるため終了コードは見ない
    cmd.spawn().map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
fn edit(
    start: PosC,
    end: PosC,
    caret_before: PosC,
    text: String,
    coalesce: bool,
    state: State,
) -> EditResult {
    with_doc(&state, |doc| doc.edit(start, end, caret_before, &text, coalesce))
}

#[tauri::command]
fn edit_many(
    edits: Vec<EditManyItem>,
    caret_before: PosC,
    primary_index: usize,
    state: State,
) -> EditManyResult {
    with_doc(&state, |doc| doc.edit_many(edits, caret_before, primary_index))
}

#[tauri::command]
fn undo(state: State) -> Option<EditResult> {
    with_doc(&state, Doc::undo)
}

#[tauri::command]
fn redo(state: State) -> Option<EditResult> {
    with_doc(&state, Doc::redo)
}

#[tauri::command]
fn find(
    pat: String,
    from: PosC,
    forward: bool,
    match_case: bool,
    state: State,
) -> Option<FindResult> {
    with_doc(&state, |doc| doc.find(&pat, from, forward, match_case))
}

#[tauri::command]
fn find_step(
    pat: String,
    from: PosC,
    match_case: bool,
    cursor: Option<FindCursor>,
    budget: usize,
    state: State,
) -> FindOutcome {
    with_doc(&state, |doc| doc.find_step(&pat, from, match_case, cursor, budget))
}

#[tauri::command]
fn replace_all_chunk(
    pat: String,
    rep: String,
    match_case: bool,
    budget: usize,
    state: State,
) -> ReplaceChunkResult {
    with_doc(&state, |doc| doc.replace_all_chunk(&pat, &rep, match_case, budget))
}

#[tauri::command]
fn replace_all_cancel(state: State) -> EditResult {
    with_doc(&state, Doc::replace_all_cancel)
}

#[tauri::command]
fn save_file(path: String, enc: EncodingId, eol: Eol, state: State) -> Result<(), String> {
    with_doc(&state, |doc| doc.save(&PathBuf::from(path), enc.into(), eol))
        .map_err(|e| e.to_string())
}

#[tauri::command]
fn set_encoding(enc: EncodingId, state: State) {
    with_doc(&state, |doc| doc.set_enc(enc.into()));
}

#[tauri::command]
fn set_eol(eol: Eol, state: State) {
    with_doc(&state, |doc| doc.set_eol(eol));
}

#[tauri::command]
fn load_bookmarks() -> Vec<BookmarkNode> {
    wasabipad_core::load_bookmarks()
}

#[tauri::command]
fn save_bookmarks(nodes: Vec<BookmarkNode>) -> Result<(), String> {
    wasabipad_core::save_bookmarks(&nodes).map_err(|e| e.to_string())
}

#[tauri::command]
fn path_is_directory(path: String) -> bool {
    PathBuf::from(path).is_dir()
}

#[tauri::command]
fn reload_with_encoding(enc: EncodingId, state: State) -> Result<DocInfo, String> {
    with_doc(&state, |doc| doc.reload_with_encoding(enc.into())).map_err(|e| e.to_string())
}

#[tauri::command]
fn next_memo_path(directory: String, stem: String, extension: String) -> Result<String, String> {
    let stem = stem.trim();
    if stem.is_empty() || stem == "." || stem == ".." || stem.contains(['/', '\\']) {
        return Err("ファイル名が正しくありません".into());
    }
    let dir = PathBuf::from(directory);
    let ext = extension.trim_start_matches('.');
    for number in 1.. {
        let numbered = if number == 1 { stem.to_string() } else { format!("{stem}{number}") };
        let name = if ext.is_empty() { numbered } else { format!("{numbered}.{ext}") };
        let candidate = dir.join(name);
        if !candidate.exists() {
            return Ok(candidate.to_string_lossy().into_owned());
        }
    }
    unreachable!()
}

#[tauri::command]
fn initial_path() -> Option<String> {
    std::env::args().nth(1)
}

#[tauri::command]
fn launch_new(path: String) -> Result<(), String> {
    let exe = std::env::current_exe().map_err(|e| e.to_string())?;
    Command::new(exe).arg(path).spawn().map(|_| ()).map_err(|e| e.to_string())
}

fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .manage(Mutex::new(DocState(Doc::empty())))
        .invoke_handler(tauri::generate_handler![
            open_path,
            new_doc,
            close_doc,
            lines,
            line_char_len,
            select_entry,
            list_archive_entries,
            list_folder_entries,
            workspace_search,
            create_note,
            rename_entry,
            reveal_in_explorer,
            edit,
            edit_many,
            undo,
            redo,
            find,
            find_step,
            replace_all_chunk,
            replace_all_cancel,
            save_file,
            reload_with_encoding,
            set_encoding,
            set_eol,
            load_bookmarks,
            save_bookmarks,
            path_is_directory,
            next_memo_path,
            initial_path,
            launch_new,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
