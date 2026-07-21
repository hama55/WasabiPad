// PetaPad Tauri backend — petapad-core を薄くラップするコマンド層。
// 文書本体は core::Doc が所有し、フロントへは可視スライスだけを渡す (全文は渡さない)。
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use petapad_core::bookmarks;
use petapad_core::doc::{
    Doc, DocInfo, EditResult, FindCursor, FindOutcome, FindResult, FolderEntry, PosC,
    ReplaceChunkResult, WorkspaceSearchResult,
};
use petapad_core::fileio::{EncodingId, Eol};
use std::path::PathBuf;
use std::process::Command;
use std::sync::Mutex;

// HugeBuf は mmap の生ポインタ / Rc キャッシュを持つため自動では Send にならないが、
// 常に Mutex 越しの排他アクセスで、ポインタは mmap 領域 (プロセス内で有効) を指すのみ。
struct DocState(Doc);
unsafe impl Send for DocState {}

type State<'a> = tauri::State<'a, Mutex<DocState>>;

#[tauri::command]
fn open_path(path: String, state: State) -> Result<DocInfo, String> {
    let d = Doc::open(&PathBuf::from(&path)).map_err(|e| e.to_string())?;
    // フォルダを開いた場合 d.path は先頭の実ファイルを指す (フォルダ自体は保存先を持たない)
    let info_path = d
        .path()
        .map(|p| p.to_string_lossy().into_owned())
        .unwrap_or(path);
    let info = d.info(info_path);
    state.lock().unwrap().0 = d;
    Ok(info)
}

#[tauri::command]
fn new_doc(state: State) {
    state.lock().unwrap().0 = Doc::empty();
}

#[tauri::command]
fn close_doc(state: State) {
    state.lock().unwrap().0 = Doc::empty(); // mmap解放 (ファイルロック解除)
}

#[tauri::command]
fn lines(start: usize, count: usize, state: State) -> Vec<String> {
    state.lock().unwrap().0.lines(start, count)
}

#[tauri::command]
fn line_char_len(line: usize, state: State) -> usize {
    state.lock().unwrap().0.line_char_len(line)
}

#[tauri::command]
fn select_entry(rel_path: String, state: State) -> Result<DocInfo, String> {
    state
        .lock()
        .unwrap()
        .0
        .select_entry(&rel_path)
        .ok_or_else(|| "no entry".into())
}

// ツリーの展開ボタン用。zip/xlsx/xls の中身一覧だけを安価に取得する (本文は読まない)。
// rel_path が空文字なら直接開いているアーカイブ自身、それ以外はフォルダ内の相対パス。
#[tauri::command]
fn list_archive_entries(rel_path: String, state: State) -> Result<Vec<String>, String> {
    state
        .lock()
        .unwrap()
        .0
        .list_archive_entries(&rel_path)
        .ok_or_else(|| "no entries".into())
}

// フォルダの展開時に、その直下だけを取得する。
#[tauri::command]
fn list_folder_entries(rel_dir: String, state: State) -> Result<Vec<FolderEntry>, String> {
    state
        .lock()
        .unwrap()
        .0
        .list_folder_entries(&rel_dir)
        .ok_or_else(|| "no entries".into())
}

#[tauri::command]
fn workspace_search(pat: String, match_case: bool, state: State) -> Result<Vec<WorkspaceSearchResult>, String> {
    let root = state
        .lock()
        .unwrap()
        .0
        .workspace_root()
        .ok_or_else(|| "folder is not open".to_string())?;
    Ok(petapad_core::doc::search_workspace(&root, &pat, match_case))
}

#[tauri::command]
fn create_note(dir: Option<String>, name: String, state: State) -> Result<DocInfo, String> {
    state
        .lock()
        .unwrap()
        .0
        .create_note(dir.as_deref(), &name)
        .map_err(|e| e.to_string())
}

#[tauri::command]
fn rename_entry(rel_path: String, new_name: String, state: State) -> Result<DocInfo, String> {
    state
        .lock()
        .unwrap()
        .0
        .rename_entry(&rel_path, &new_name)
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
    state
        .lock()
        .unwrap()
        .0
        .edit(start, end, caret_before, &text, coalesce)
}

#[tauri::command]
fn undo(state: State) -> Option<EditResult> {
    state.lock().unwrap().0.undo()
}

#[tauri::command]
fn redo(state: State) -> Option<EditResult> {
    state.lock().unwrap().0.redo()
}

#[tauri::command]
fn find(
    pat: String,
    from: PosC,
    forward: bool,
    match_case: bool,
    state: State,
) -> Option<FindResult> {
    state
        .lock()
        .unwrap()
        .0
        .find(&pat, from, forward, match_case)
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
    state
        .lock()
        .unwrap()
        .0
        .find_step(&pat, from, match_case, cursor, budget)
}

#[tauri::command]
fn replace_all_chunk(
    pat: String,
    rep: String,
    match_case: bool,
    budget: usize,
    state: State,
) -> ReplaceChunkResult {
    state
        .lock()
        .unwrap()
        .0
        .replace_all_chunk(&pat, &rep, match_case, budget)
}

#[tauri::command]
fn replace_all_cancel(state: State) -> EditResult {
    state.lock().unwrap().0.replace_all_cancel()
}

#[tauri::command]
fn save_file(path: String, enc: EncodingId, eol: Eol, state: State) -> Result<(), String> {
    state
        .lock()
        .unwrap()
        .0
        .save(&PathBuf::from(path), enc.into(), eol)
        .map_err(|e| e.to_string())
}

#[tauri::command]
fn set_encoding(enc: EncodingId, state: State) {
    state.lock().unwrap().0.set_enc(enc.into());
}

#[tauri::command]
fn set_eol(eol: Eol, state: State) {
    state.lock().unwrap().0.set_eol(eol);
}

#[tauri::command]
fn load_bookmarks() -> Vec<bookmarks::Node> {
    bookmarks::load()
}

#[tauri::command]
fn save_bookmarks(nodes: Vec<bookmarks::Node>) -> Result<(), String> {
    bookmarks::save(&nodes).map_err(|e| e.to_string())
}

#[tauri::command]
fn path_is_directory(path: String) -> bool {
    PathBuf::from(path).is_dir()
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
            undo,
            redo,
            find,
            find_step,
            replace_all_chunk,
            replace_all_cancel,
            save_file,
            set_encoding,
            set_eol,
            load_bookmarks,
            save_bookmarks,
            path_is_directory,
            initial_path,
            launch_new,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
