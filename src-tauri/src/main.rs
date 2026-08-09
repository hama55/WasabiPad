// WasabiPad Tauri backend — wasabipad-core を薄くラップするコマンド層。
// 文書本体は core::Doc が所有し、フロントへは可視スライスだけを渡す (全文は渡さない)。
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod commands;
mod instance;
mod state;
mod viewer;

use commands::{document, search, system};
use instance::{
    forward_to_latest_instance, initial_window_request as read_initial_window_request,
    launch_new_instance as spawn_new_instance, parse_window_request,
    take_pending_window_requests as drain_pending_window_requests, InstanceServer,
};
use state::{DocState, State};
use std::collections::HashMap;
use std::sync::Mutex;
use tauri::{AppHandle, Manager};
use viewer::ViewerStore;
use wasabipad_core::{
    self, BookmarkNode, Doc, DocInfo, EditManyItem, EditManyResult, EditResult, EncodingId, Eol,
    ExternalCheck, FindCursor, FindOutcome, FindResult, FolderEntry, PosC, ReplaceChunkResult,
    SaveOutcome, SearchOptions, WorkspaceSearchOutcome,
};

const EVENT_EXTERNAL_WINDOW_REQUEST: &str = "external-window-request";
const EVENT_WORKSPACE_SEARCH_BATCH: &str = "workspace-search-batch";
pub(crate) const EVENT_DOCUMENT_LOAD_PROGRESS: &str = "document-load-progress";
const EVENT_VIEWER_UPDATE: &str = "viewer-update";

fn viewer_label(id: u64) -> String {
    format!("viewer-{}", id)
}

#[derive(Clone, serde::Serialize, serde::Deserialize, ts_rs::TS)]
#[ts(export)]
#[serde(rename_all = "camelCase")]
#[ts(rename_all = "camelCase")]
struct EditorViewState {
    anchor: PosC,
    caret: PosC,
    top_line: f64,
    wrap_intra_line_px: f64,
    scroll_left: f64,
}

#[derive(Clone, Default, serde::Serialize, serde::Deserialize, ts_rs::TS)]
#[ts(export)]
#[serde(rename_all = "camelCase")]
#[ts(rename_all = "camelCase")]
struct WindowRequest {
    secondary: bool,
    path: Option<String>,
    goto: Option<PosC>,
    selected_rel_path: Option<String>,
    view_state: Option<EditorViewState>,
}

#[derive(Clone, serde::Serialize, ts_rs::TS)]
#[ts(export)]
struct WorkspaceSearchBatch {
    search_id: u32,
    results: Vec<wasabipad_core::WorkspaceSearchResult>,
}

// 受理する形式はこの enum が単一の定義。表示名はフロント (ui/format.ts) だけが持つ。
#[derive(Clone, Copy, serde::Serialize, serde::Deserialize, ts_rs::TS)]
#[ts(export)]
enum ViewerFormat {
    #[serde(rename = "csv")]
    Csv,
    #[serde(rename = "markdown")]
    Markdown,
    #[serde(rename = "image")]
    Image,
}

#[derive(Clone, serde::Serialize, ts_rs::TS)]
#[ts(export)]
struct ViewerPayload {
    format: ViewerFormat,
    text: String,
    selection: Option<ViewerSelection>,
    // Markdown 内の相対パス画像は元ファイルの位置からしか解決できない (未保存なら None)
    source_path: Option<String>,
    // アーカイブ内メモの画像は、アーカイブエントリを IPC 経由で読む。
    archive_path: Option<String>,
    archive_entry: Option<String>,
}

#[derive(Clone, serde::Serialize, serde::Deserialize, ts_rs::TS)]
#[ts(export)]
struct ViewerSelection {
    start: PosC,
    end: PosC,
}

#[tauri::command]
fn open_path(path: String, state: State, app: AppHandle) -> Result<DocInfo, String> {
    document::open_path(path, state, app)
}

#[tauri::command]
fn new_doc(state: State) -> Result<(), String> {
    document::new_doc(state)
}

#[tauri::command]
fn close_doc(state: State) -> Result<(), String> {
    document::close_doc(state)
}

#[tauri::command]
fn lines(start: usize, count: usize, state: State) -> Result<Vec<String>, String> {
    document::lines(start, count, state)
}

#[tauri::command]
fn line_char_len(line: usize, state: State) -> Result<usize, String> {
    document::line_char_len(line, state)
}

#[tauri::command]
fn select_entry(rel_path: String, state: State) -> Result<DocInfo, String> {
    document::select_entry(rel_path, state)
}

// ツリーの展開ボタン用。アーカイブの中身一覧だけを安価に取得する (本文は読まない)。
// rel_path が空文字なら直接開いているアーカイブ自身、それ以外はフォルダ内の相対パス。
#[tauri::command]
fn list_archive_entries(rel_path: String, state: State) -> Result<Vec<String>, String> {
    document::list_archive_entries(rel_path, state)
}

// パスワード付き 7z/zip 用。入力されたパスワードを記憶させ、UI が失敗した操作を再試行する。
#[tauri::command]
fn set_archive_password(rel_path: String, password: String, state: State) -> Result<(), String> {
    document::set_archive_password(rel_path, password, state)
}

// フォルダの展開時に、その直下だけを取得する。
#[tauri::command]
fn list_folder_entries(rel_dir: String, state: State) -> Result<Vec<FolderEntry>, String> {
    document::list_folder_entries(rel_dir, state)
}

#[tauri::command]
async fn workspace_search(
    pat: String,
    options: SearchOptions,
    search_id: u32,
    app: AppHandle,
    state: State<'_>,
    cancel: tauri::State<'_, search::SearchCancel>,
) -> Result<WorkspaceSearchOutcome, String> {
    search::workspace_search(pat, options, search_id, app, state, cancel).await
}

#[tauri::command]
fn workspace_search_cancel(
    search_id: u32,
    cancel: tauri::State<'_, search::SearchCancel>,
) -> Result<(), String> {
    search::workspace_search_cancel(search_id, cancel)
}

#[tauri::command]
fn create_note(dir: Option<String>, name: String, state: State) -> Result<DocInfo, String> {
    document::create_note(dir, name, state)
}

#[tauri::command]
fn rename_entry(rel_path: String, new_name: String, state: State) -> Result<DocInfo, String> {
    document::rename_entry(rel_path, new_name, state)
}

#[tauri::command]
fn delete_entry(rel_path: String, state: State) -> Result<DocInfo, String> {
    document::delete_entry(rel_path, state)
}

#[tauri::command]
fn save_pasted_image(bytes: Vec<u8>, mime_type: String, state: State) -> Result<String, String> {
    document::save_pasted_image(bytes, mime_type, state)
}

#[tauri::command]
fn cleanup_unused_images(path: String, state: State) -> Result<(), String> {
    document::cleanup_unused_images(path, state)
}

// サイドバーの「エクスプローラで開く」用。状態を持たないので Doc へは委譲しない。
#[tauri::command]
fn reveal_in_explorer(path: String, is_dir: bool) -> Result<(), String> {
    system::reveal_in_explorer(path, is_dir)
}

#[tauri::command]
fn open_in_other_app(path: String) -> Result<(), String> {
    system::open_in_other_app(path)
}

#[tauri::command]
fn run_external_command(command: String, path: String) -> Result<(), String> {
    system::run_external_command(command, path)
}

#[tauri::command]
fn edit(
    start: PosC,
    end: PosC,
    caret_before: PosC,
    text: String,
    coalesce: bool,
    state: State,
) -> Result<EditResult, String> {
    document::edit(start, end, caret_before, text, coalesce, state)
}

#[tauri::command]
fn edit_many(
    edits: Vec<EditManyItem>,
    caret_before: PosC,
    primary_index: usize,
    state: State,
) -> Result<EditManyResult, String> {
    document::edit_many(edits, caret_before, primary_index, state)
}

#[tauri::command]
fn undo(state: State) -> Result<Option<EditResult>, String> {
    document::undo(state)
}

#[tauri::command]
fn redo(state: State) -> Result<Option<EditResult>, String> {
    document::redo(state)
}

#[tauri::command]
fn find(
    pat: String,
    from: PosC,
    forward: bool,
    match_case: bool,
    state: State,
) -> Result<Option<FindResult>, String> {
    document::find(pat, from, forward, match_case, state)
}

#[tauri::command]
fn find_step(
    pat: String,
    from: PosC,
    match_case: bool,
    cursor: Option<FindCursor>,
    budget: usize,
    state: State,
) -> Result<FindOutcome, String> {
    document::find_step(pat, from, match_case, cursor, budget, state)
}

#[tauri::command]
fn replace_all_chunk(
    pat: String,
    rep: String,
    match_case: bool,
    budget: usize,
    state: State,
) -> Result<ReplaceChunkResult, String> {
    document::replace_all_chunk(pat, rep, match_case, budget, state)
}

#[tauri::command]
fn replace_all_cancel(state: State) -> Result<EditResult, String> {
    document::replace_all_cancel(state)
}

#[tauri::command]
fn save_file(path: String, enc: EncodingId, eol: Eol, state: State) -> Result<SaveOutcome, String> {
    document::save_file(path, enc, eol, state)
}

// 外部変更ポーリング (フロントの定期タイマーから呼ぶ)。dirty はフロントが管理する
// 未保存フラグ。小/巨大ファイルの区別も含め、判定はすべて core 側が持つ。
#[tauri::command]
fn poll_external(dirty: bool, state: State) -> Result<ExternalCheck, String> {
    document::poll_external(dirty, state)
}

#[tauri::command]
fn reload_from_disk(state: State) -> Result<DocInfo, String> {
    document::reload_from_disk(state)
}

#[tauri::command]
fn ack_external(state: State) -> Result<(), String> {
    document::ack_external(state)
}

#[tauri::command]
fn set_encoding(enc: EncodingId, state: State) -> Result<(), String> {
    document::set_encoding(enc, state)
}

#[tauri::command]
fn set_eol(eol: Eol, state: State) -> Result<(), String> {
    document::set_eol(eol, state)
}

#[tauri::command]
fn load_bookmarks() -> Result<Vec<BookmarkNode>, String> {
    system::load_bookmarks()
}

#[tauri::command]
fn save_bookmarks(nodes: Vec<BookmarkNode>) -> Result<(), String> {
    system::save_bookmarks(nodes)
}

// 設定値はJSONとして扱い、キー単位で更新して別プロセスの変更を巻き戻さない。
#[tauri::command]
fn load_settings() -> Result<String, String> {
    system::load_settings()
}

#[tauri::command]
fn update_setting(key: String, value_json: String) -> Result<(), String> {
    system::update_setting(key, value_json)
}

#[tauri::command]
fn path_is_directory(path: String) -> bool {
    system::path_is_directory(path)
}

#[tauri::command]
fn reload_with_encoding(enc: EncodingId, state: State) -> Result<DocInfo, String> {
    document::reload_with_encoding(enc, state)
}

#[tauri::command]
fn next_memo_path(directory: String, stem: String, extension: String) -> Result<String, String> {
    system::next_memo_path(directory, stem, extension)
}

#[tauri::command]
fn launch_new_instance(request: WindowRequest) -> Result<(), String> {
    spawn_new_instance(request)
}

#[tauri::command]
fn initial_window_request() -> Result<WindowRequest, String> {
    read_initial_window_request()
}

#[tauri::command]
fn read_archive_asset(
    archive_path: String,
    entry: String,
    state: State,
) -> Result<Vec<u8>, String> {
    document::read_archive_asset(archive_path, entry, state)
}

#[tauri::command]
fn take_pending_window_requests(state: tauri::State<'_, InstanceServer>) -> Vec<WindowRequest> {
    drain_pending_window_requests(&state)
}

#[cfg(test)]
mod window_request_tests {
    use super::parse_window_request;

    #[test]
    fn internal_request_round_trips_as_one_json_argument() {
        let json = r#"{"secondary":true,"path":"C:\\日本語 folder\\memo.txt","goto":{"line":3,"col":4},"selectedRelPath":"sub\\memo.txt","viewState":{"anchor":{"line":1,"col":2},"caret":{"line":3,"col":4},"topLine":1.5,"wrapIntraLinePx":2,"scrollLeft":80}}"#;
        let request = parse_window_request(
            ["--wasabipad-window-request".to_string(), json.to_string()].into_iter(),
        )
        .unwrap();
        assert!(request.secondary);
        assert_eq!(request.path.as_deref(), Some(r"C:\日本語 folder\memo.txt"));
        assert_eq!(request.goto.unwrap().line, 3);
        assert_eq!(request.selected_rel_path.as_deref(), Some(r"sub\memo.txt"));
        assert_eq!(request.view_state.unwrap().scroll_left, 80.0);
    }

    #[test]
    fn legacy_file_association_is_normalized_to_the_same_request() {
        let request =
            parse_window_request([r"C:\work\memo.txt".to_string(), "+8:2".to_string()].into_iter())
                .unwrap();
        assert!(!request.secondary);
        assert_eq!(request.path.as_deref(), Some(r"C:\work\memo.txt"));
        assert_eq!(request.goto.unwrap().col, 2);
    }
}

// Windowsでは同期command中のWebView生成がイベントループを塞ぐためasyncで実行する。
#[tauri::command]
async fn open_viewer(
    format: ViewerFormat,
    text: String,
    selection: Option<ViewerSelection>,
    source_path: Option<String>,
    app: AppHandle,
    doc_state: State<'_>,
    state: tauri::State<'_, ViewerStore>,
) -> Result<String, String> {
    viewer::open_viewer(format, text, selection, source_path, app, doc_state, state).await
}

#[tauri::command]
fn take_viewer_payload(
    label: String,
    state: tauri::State<'_, ViewerStore>,
) -> Result<ViewerPayload, String> {
    viewer::take_viewer_payload(label, state)
}

#[tauri::command]
fn update_viewer(
    label: String,
    text: String,
    selection: Option<ViewerSelection>,
    app: AppHandle,
    state: tauri::State<'_, ViewerStore>,
) -> Result<bool, String> {
    viewer::update_viewer(label, text, selection, app, state)
}

#[tauri::command]
fn close_viewer(
    label: String,
    app: AppHandle,
    state: tauri::State<'_, ViewerStore>,
) -> Result<(), String> {
    viewer::close_viewer(label, app, state)
}

fn main() {
    let initial_request = match parse_window_request(std::env::args().skip(1)) {
        Ok(request) => request,
        Err(error) => {
            eprintln!("WasabiPadの起動引数を解釈できません: {error}");
            return;
        }
    };
    if !initial_request.secondary
        && initial_request.path.is_some()
        && forward_to_latest_instance(&initial_request)
    {
        return;
    }

    let instance_server = match InstanceServer::new() {
        Ok(server) => server,
        Err(error) => {
            eprintln!("WasabiPadのインスタンス受付を初期化できません: {error}");
            return;
        }
    };
    let app = match tauri::Builder::default()
        .plugin(tauri_plugin_clipboard_manager::init())
        .plugin(tauri_plugin_dialog::init())
        .manage(Mutex::new(DocState(Doc::empty())))
        .manage(ViewerStore(Mutex::new(HashMap::new())))
        .manage(search::SearchCancel(Mutex::new(None)))
        .manage(instance_server)
        .setup(|app| {
            app.state::<InstanceServer>().start(app.handle());
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            open_path,
            new_doc,
            close_doc,
            lines,
            line_char_len,
            select_entry,
            list_archive_entries,
            set_archive_password,
            list_folder_entries,
            workspace_search,
            workspace_search_cancel,
            create_note,
            rename_entry,
            delete_entry,
            save_pasted_image,
            cleanup_unused_images,
            read_archive_asset,
            reveal_in_explorer,
            open_in_other_app,
            run_external_command,
            edit,
            edit_many,
            undo,
            redo,
            find,
            find_step,
            replace_all_chunk,
            replace_all_cancel,
            save_file,
            poll_external,
            reload_from_disk,
            ack_external,
            reload_with_encoding,
            set_encoding,
            set_eol,
            load_bookmarks,
            save_bookmarks,
            load_settings,
            update_setting,
            path_is_directory,
            next_memo_path,
            launch_new_instance,
            initial_window_request,
            take_pending_window_requests,
            open_viewer,
            take_viewer_payload,
            update_viewer,
            close_viewer,
        ])
        .build(tauri::generate_context!())
    {
        Ok(app) => app,
        Err(error) => {
            eprintln!("WasabiPadの起動準備に失敗しました: {error}");
            return;
        }
    };
    app.run(|app, event| {
        if matches!(event, tauri::RunEvent::Exit) {
            app.state::<InstanceServer>().remove_endpoint();
        }
    });
}
