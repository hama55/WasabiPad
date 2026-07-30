// WasabiPad Tauri backend — wasabipad-core を薄くラップするコマンド層。
// 文書本体は core::Doc が所有し、フロントへは可視スライスだけを渡す (全文は渡さない)。
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod state;

use wasabipad_core::{
    self, BookmarkNode, Doc, DocInfo, EditManyItem, EditManyResult, EditResult, EncodingId,
    Eol, ExternalCheck, FindCursor, FindOutcome, FindResult, FolderEntry, PosC,
    ReplaceChunkResult, SaveOutcome, SearchOptions, WorkspaceSearchOutcome,
};
use state::{with_doc, DocState, State};
use std::collections::HashMap;
use std::path::PathBuf;
use std::process::Command;
use std::sync::{
    atomic::{AtomicBool, AtomicU64, Ordering},
    Arc, Mutex,
};
use tauri::{AppHandle, Emitter, Manager, WebviewUrl, WebviewWindowBuilder};

#[cfg(target_os = "windows")]
#[repr(C)]
struct OpenAsInfo {
    file: *const u16,
    class: *const u16,
    flags: u32,
}

#[cfg(target_os = "windows")]
#[link(name = "shell32")]
extern "system" {
    #[link_name = "SHOpenWithDialog"]
    fn sh_open_with_dialog(parent: *mut std::ffi::c_void, info: *const OpenAsInfo) -> i32;
}

// 受理する形式はこの enum が単一の定義。表示名はフロント (ui/format.ts) だけが持つ。
#[derive(Clone, Copy, serde::Serialize, serde::Deserialize, ts_rs::TS)]
#[ts(export)]
enum ViewerFormat {
    #[serde(rename = "csv")]
    Csv,
    #[serde(rename = "markdown")]
    Markdown,
}

#[derive(Clone, serde::Serialize, ts_rs::TS)]
#[ts(export)]
struct ViewerPayload {
    format: ViewerFormat,
    text: String,
    selection: Option<ViewerSelection>,
    // Markdown 内の相対パス画像は元ファイルの位置からしか解決できない (未保存なら None)
    source_path: Option<String>,
}

#[derive(Clone, serde::Serialize, serde::Deserialize, ts_rs::TS)]
#[ts(export)]
struct ViewerSelection {
    start: PosC,
    end: PosC,
}

struct ViewerStore(Mutex<HashMap<String, ViewerPayload>>);

// 進行中のフォルダ検索を止めるための共有フラグ。走査量は無制限を既定にしたため、
// 打ち切る手段がないと巨大フォルダで利用者がアプリを閉じるしかなくなる。
struct SearchCancel(Mutex<Arc<AtomicBool>>);

static VIEWER_ID: AtomicU64 = AtomicU64::new(1);

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
        .map_err(|error| error.to_string())?
        .ok_or_else(|| "no entry".into())
}

// ツリーの展開ボタン用。zip/xlsx/xls の中身一覧だけを安価に取得する (本文は読まない)。
// rel_path が空文字なら直接開いているアーカイブ自身、それ以外はフォルダ内の相対パス。
#[tauri::command]
fn list_archive_entries(rel_path: String, state: State) -> Result<Vec<String>, String> {
    with_doc(&state, |doc| doc.list_archive_entries(&rel_path))
        .map_err(|error| error.to_string())?
        .ok_or_else(|| "no entries".into())
}

// フォルダの展開時に、その直下だけを取得する。
#[tauri::command]
fn list_folder_entries(rel_dir: String, state: State) -> Result<Vec<FolderEntry>, String> {
    with_doc(&state, |doc| doc.list_folder_entries(&rel_dir))
        .map_err(|error| error.to_string())?
        .ok_or_else(|| "no entries".into())
}

// 直前の検索へ中止を通知し、今回の検索用のフラグを差し替える
fn take_over_search(cancel: &tauri::State<'_, SearchCancel>) -> Result<Arc<AtomicBool>, String> {
    let flag = Arc::new(AtomicBool::new(false));
    let mut slot = cancel.0.lock().map_err(|_| "検索を開始できません".to_string())?;
    slot.store(true, Ordering::Relaxed);
    *slot = flag.clone();
    Ok(flag)
}

// 検索中の途中経過。search_id はフロントが発行した世代番号で、
// 打ち切った検索の取りこぼしが次の検索へ混ざらないようにするためだけに載せる。
#[derive(Clone, serde::Serialize, ts_rs::TS)]
#[ts(export)]
struct WorkspaceSearchBatch {
    search_id: u32,
    results: Vec<wasabipad_core::WorkspaceSearchResult>,
}

#[tauri::command]
async fn workspace_search(
    pat: String,
    options: SearchOptions,
    search_id: u32,
    app: AppHandle,
    state: State<'_>,
    cancel: tauri::State<'_, SearchCancel>,
) -> Result<WorkspaceSearchOutcome, String> {
    let root = with_doc(&state, |doc| doc.workspace_root())
        .ok_or_else(|| "folder is not open".to_string())?;
    let flag = take_over_search(&cancel)?;
    tauri::async_runtime::spawn_blocking(move || {
        let emit = |results| {
            let _ = app.emit("workspace-search-batch", WorkspaceSearchBatch { search_id, results });
        };
        wasabipad_core::search_workspace(&root, &pat, &options, &flag, &emit)
    })
    .await
    .map_err(|error| error.to_string())
}

#[tauri::command]
fn workspace_search_cancel(cancel: tauri::State<'_, SearchCancel>) -> Result<(), String> {
    take_over_search(&cancel).map(|_| ())
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
fn open_in_other_app(path: String) -> Result<(), String> {
    #[cfg(target_os = "windows")]
    {
        use std::os::windows::ffi::OsStrExt;

        let target = PathBuf::from(path);
        if !target.is_file() {
            return Err("対象ファイルが見つかりません".to_string());
        }
        let wide: Vec<u16> = target.as_os_str().encode_wide().chain(std::iter::once(0)).collect();
        let info = OpenAsInfo {
            file: wide.as_ptr(),
            class: std::ptr::null(),
            // 選択したアプリで対象ファイルを開く。既定アプリの変更は要求しない。
            flags: 0x0000_0004,
        };
        let result = unsafe { sh_open_with_dialog(std::ptr::null_mut(), &info) };
        return if result >= 0 {
            Ok(())
        } else {
            Err(format!("アプリ選択画面を開けませんでした (HRESULT: 0x{result:08X})"))
        };
    }
    #[cfg(not(target_os = "windows"))]
    {
        let _ = path;
        Err("この機能はWindowsでのみ使用できます".to_string())
    }
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
    with_doc(&state, |doc| doc.edit(start, end, caret_before, &text, coalesce))
        .ok_or_else(|| "閲覧専用の文書は編集できません".to_string())
}

#[tauri::command]
fn edit_many(
    edits: Vec<EditManyItem>,
    caret_before: PosC,
    primary_index: usize,
    state: State,
) -> Result<EditManyResult, String> {
    with_doc(&state, |doc| doc.edit_many(edits, caret_before, primary_index))
        .ok_or_else(|| "閲覧専用の文書は編集できません".to_string())
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
fn save_file(path: String, enc: EncodingId, eol: Eol, state: State) -> Result<SaveOutcome, String> {
    with_doc(&state, |doc| doc.save(&PathBuf::from(path), enc.into(), eol))
        .map_err(|e| e.to_string())
}

// 外部変更ポーリング (フロントの定期タイマーから呼ぶ)。dirty はフロントが管理する
// 未保存フラグ。小/巨大ファイルの区別も含め、判定はすべて core 側が持つ。
#[tauri::command]
fn poll_external(dirty: bool, state: State) -> ExternalCheck {
    with_doc(&state, |doc| doc.poll_external(dirty))
}

#[tauri::command]
fn reload_from_disk(state: State) -> Result<DocInfo, String> {
    with_doc(&state, |doc| doc.reload_from_disk()).map_err(|e| e.to_string())
}

#[tauri::command]
fn ack_external(state: State) {
    with_doc(&state, Doc::ack_external);
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

// 設定値はJSONとして扱い、キー単位で更新して別プロセスの変更を巻き戻さない。
#[tauri::command]
fn load_settings() -> String {
    wasabipad_core::load_settings()
}

#[tauri::command]
fn update_setting(key: String, value_json: String) -> Result<(), String> {
    wasabipad_core::update_setting(&key, &value_json).map_err(|e| e.to_string())
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
    wasabipad_core::next_available_path(&PathBuf::from(directory), &stem, &extension)
        .map(|path| path.to_string_lossy().into_owned())
        .map_err(|e| e.to_string())
}

#[tauri::command]
fn launch_new_instance(mut request: WindowRequest) -> Result<(), String> {
    request.secondary = true;
    let executable = std::env::current_exe().map_err(|error| error.to_string())?;
    let json = serde_json::to_string(&request).map_err(|error| error.to_string())?;
    let mut command = Command::new(executable);
    command.args(["--wasabipad-window-request", &json]);
    command.spawn().map(|_| ()).map_err(|error| error.to_string())
}

fn parse_window_request(mut args: impl Iterator<Item = String>) -> Result<WindowRequest, String> {
    let Some(first) = args.next() else {
        return Ok(WindowRequest::default());
    };
    if first == "--wasabipad-window-request" {
        let json = args.next().ok_or_else(|| "ウィンドウ要求がありません".to_string())?;
        return serde_json::from_str(&json).map_err(|error| error.to_string());
    }
    let goto = args.next().and_then(|arg| {
        let (line, col) = arg.strip_prefix('+')?.split_once(':')?;
        Some(PosC { line: line.parse().ok()?, col: col.parse().ok()? })
    });
    Ok(WindowRequest { path: Some(first), goto, ..WindowRequest::default() })
}

#[tauri::command]
fn initial_window_request() -> Result<WindowRequest, String> {
    parse_window_request(std::env::args().skip(1))
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
        let request = parse_window_request(
            [r"C:\work\memo.txt".to_string(), "+8:2".to_string()].into_iter(),
        )
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
    state: tauri::State<'_, ViewerStore>,
) -> Result<String, String> {
    // 形式名入りのタイトルは payload 受信後にフロントが設定する。ここは生成時の暫定表示。
    let title = app.package_info().name.clone();
    let label = format!("viewer-{}", VIEWER_ID.fetch_add(1, Ordering::Relaxed));
    state
        .0
        .lock()
        .map_err(|_| "ビューの準備に失敗しました".to_string())?
        .insert(label.clone(), ViewerPayload { format, text, selection, source_path });

    let window = match WebviewWindowBuilder::new(&app, &label, WebviewUrl::App("viewer.html".into()))
        .title(title)
        .decorations(false)
        .inner_size(960.0, 700.0)
        .build()
    {
        Ok(window) => window,
        Err(error) => {
            if let Ok(mut payloads) = state.0.lock() {
                payloads.remove(&label);
            }
            return Err(error.to_string());
        }
    };
    let cleanup_app = app.clone();
    let cleanup_label = label.clone();
    window.on_window_event(move |event| {
        if matches!(event, tauri::WindowEvent::Destroyed) {
            if let Ok(mut payloads) = cleanup_app.state::<ViewerStore>().0.lock() {
                payloads.remove(&cleanup_label);
            }
        }
    });
    Ok(label)
}

#[tauri::command]
fn take_viewer_payload(
    label: String,
    state: tauri::State<'_, ViewerStore>,
) -> Result<ViewerPayload, String> {
    state
        .0
        .lock()
        .map_err(|_| "ビューの読込みに失敗しました".to_string())?
        .get(&label)
        .cloned()
        .ok_or_else(|| "表示内容が見つかりません".to_string())
}

#[tauri::command]
fn update_viewer(
    label: String,
    text: String,
    selection: Option<ViewerSelection>,
    app: AppHandle,
    state: tauri::State<'_, ViewerStore>,
) -> Result<bool, String> {
    let Some(window) = app.get_webview_window(&label) else {
        state
            .0
            .lock()
            .map_err(|_| "ビューの更新に失敗しました".to_string())?
            .remove(&label);
        return Ok(false);
    };
    let payload = {
        let mut payloads = state
            .0
            .lock()
            .map_err(|_| "ビューの更新に失敗しました".to_string())?;
        let Some(payload) = payloads.get_mut(&label) else {
            return Ok(false);
        };
        payload.text = text;
        payload.selection = selection;
        payload.clone()
    };
    window.emit("viewer-update", payload).map_err(|e| e.to_string())?;
    Ok(true)
}

fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_clipboard_manager::init())
        .plugin(tauri_plugin_dialog::init())
        .manage(Mutex::new(DocState(Doc::empty())))
        .manage(ViewerStore(Mutex::new(HashMap::new())))
        .manage(SearchCancel(Mutex::new(Arc::new(AtomicBool::new(false)))))
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
            workspace_search_cancel,
            create_note,
            rename_entry,
            reveal_in_explorer,
            open_in_other_app,
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
            open_viewer,
            take_viewer_payload,
            update_viewer,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
