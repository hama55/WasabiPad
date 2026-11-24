// WasabiPad Tauri backend — wasabipad-core を薄くラップするコマンド層。
// 文書本体は core::Doc が所有し、フロントへは可視スライスだけを渡す (全文は渡さない)。
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod access;
mod commands;
mod external_html_preview;
mod external_preview_runner;
mod html_preview;
mod instance;
mod pdf_preview;
mod state;
mod viewer;

use commands::{document, search, system};
use instance::{
    forward_to_latest_instance, initial_window_request as read_initial_window_request,
    launch_new_instance as spawn_new_instance, parse_window_request,
    take_pending_window_requests as drain_pending_window_requests, InstanceServer,
};
use state::{DocState, DocumentOpenGeneration, State};
use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::Mutex;
use tauri::{AppHandle, Manager};
use viewer::{FindShortcutGuard, ViewerStore};
use wasabipad_core::{
    self, read_sqlite_preview as read_sqlite_preview_core, BookmarkNode, Doc, DocInfo,
    EditManyItem, EditManyResult, EditResult, EncodingId, Eol, ExternalCheck, ExternalMergePreview,
    FindCursor, FindOutcome, FindResult, FolderEntry, OpenAs, PosC, PreviewCache,
    ReplaceChunkResult, SaveOutcome, SearchOptions, SqlitePreview, WorkspaceSearchOutcome,
    EVENT_DOCUMENT_LOAD_PROGRESS, EVENT_EXTERNAL_WINDOW_REQUEST,
    EVENT_VIEWER_UPDATE, EVENT_WORKSPACE_SEARCH_BATCH,
};

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

#[derive(Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct PreviewCacheInfo {
    directory: String,
    bytes: u64,
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
    #[serde(rename = "pdf")]
    Pdf,
    #[serde(rename = "html")]
    Html,
    #[serde(rename = "sqlite")]
    Sqlite,
    #[serde(rename = "video")]
    Video,
    #[serde(rename = "git")]
    Git,
}

#[derive(Clone, serde::Serialize, ts_rs::TS)]
#[ts(export)]
struct ViewerPayload {
    format: ViewerFormat,
    text: String,
    selection: Option<ViewerSelection>,
    // Markdown 内の相対パス画像は元ファイルの位置からしか解決できない (未保存なら None)
    source_path: Option<String>,
    // 形式指定で開いた場合も、実パスは資産読込用にそのまま保持する。
    effective_extension: Option<String>,
    // アーカイブ内メモの画像は、アーカイブエントリを IPC 経由で読む。
    archive_path: Option<String>,
    archive_entry: Option<String>,
    // 外部プレビューが生成した、WasabiPad所有の一時生成物。
    external_output_path: Option<String>,
}

#[derive(Clone, serde::Serialize, serde::Deserialize, ts_rs::TS)]
#[ts(export)]
struct ViewerSelection {
    start: PosC,
    end: PosC,
}

#[tauri::command]
async fn open_path(
    path: String,
    open_as: Option<OpenAs>,
    window: tauri::WebviewWindow,
    app: AppHandle,
) -> Result<DocInfo, String> {
    access::require_main_window(&window)?;
    let generation = app.state::<DocumentOpenGeneration>().advance();
    tauri::async_runtime::spawn_blocking(move || {
        let state = app.state::<Mutex<DocState>>();
        let info = document::open_path(path, open_as, state, &app, generation)?;
        access::allow_asset_scope_for_path(&app, std::path::Path::new(&info.path));
        Ok(info)
    })
    .await
    .map_err(|error| error.to_string())?
}

#[tauri::command]
fn cancel_document_open(
    window: tauri::WebviewWindow,
    generation: tauri::State<'_, DocumentOpenGeneration>,
) {
    if access::require_main_window(&window).is_err() {
        return;
    }
    generation.advance();
}

#[tauri::command]
fn new_doc(
    window: tauri::WebviewWindow,
    state: State,
    generation: tauri::State<'_, DocumentOpenGeneration>,
) -> Result<(), String> {
    access::require_main_window(&window)?;
    generation.advance();
    document::new_doc(state)
}

#[tauri::command]
fn close_doc(
    window: tauri::WebviewWindow,
    state: State,
    generation: tauri::State<'_, DocumentOpenGeneration>,
) -> Result<(), String> {
    access::require_main_window(&window)?;
    generation.advance();
    document::close_doc(state)
}

#[tauri::command]
async fn lines(
    start: usize,
    count: usize,
    window: tauri::WebviewWindow,
    app: AppHandle,
) -> Result<Vec<String>, String> {
    access::require_main_window(&window)?;
    tauri::async_runtime::spawn_blocking(move || {
        document::lines(start, count, app.state::<Mutex<DocState>>())
    })
    .await
    .map_err(|error| error.to_string())?
}

#[tauri::command]
async fn line_char_len(
    line: usize,
    window: tauri::WebviewWindow,
    app: AppHandle,
) -> Result<usize, String> {
    access::require_main_window(&window)?;
    tauri::async_runtime::spawn_blocking(move || {
        document::line_char_len(line, app.state::<Mutex<DocState>>())
    })
    .await
    .map_err(|error| error.to_string())?
}

#[tauri::command]
async fn select_entry(
    rel_path: String,
    open_as: Option<OpenAs>,
    cache_directory: Option<String>,
    window: tauri::WebviewWindow,
    app: AppHandle,
) -> Result<DocInfo, String> {
    access::require_main_window(&window)?;
    let generation = app.state::<DocumentOpenGeneration>().advance();
    tauri::async_runtime::spawn_blocking(move || {
        let state = app.state::<Mutex<DocState>>();
        let info = document::select_entry(rel_path, open_as, cache_directory, state, &app.state(), generation)?;
        access::allow_asset_scope_for_path(&app, std::path::Path::new(&info.path));
        Ok(info)
    })
    .await
    .map_err(|error| error.to_string())?
}

// ツリーの展開ボタン用。アーカイブの中身一覧だけを安価に取得する (本文は読まない)。
// rel_path が空文字なら直接開いているアーカイブ自身、それ以外はフォルダ内の相対パス。
#[tauri::command]
async fn list_archive_entries(
    rel_path: String,
    window: tauri::WebviewWindow,
    app: AppHandle,
) -> Result<Vec<String>, String> {
    access::require_main_window(&window)?;
    tauri::async_runtime::spawn_blocking(move || {
        let state = app.state::<Mutex<DocState>>();
        document::list_archive_entries(rel_path, state)
    })
    .await
    .map_err(|error| error.to_string())?
}

// パスワード付き 7z/zip 用。入力されたパスワードを記憶させ、UI が失敗した操作を再試行する。
#[tauri::command]
fn set_archive_password(
    rel_path: String,
    password: String,
    window: tauri::WebviewWindow,
    state: State,
) -> Result<(), String> {
    access::require_main_window(&window)?;
    document::set_archive_password(rel_path, password, state)
}

// フォルダの展開時に、その直下だけを取得する。
#[tauri::command]
async fn list_folder_entries(
    rel_dir: String,
    window: tauri::WebviewWindow,
    app: AppHandle,
) -> Result<Vec<FolderEntry>, String> {
    access::require_main_window(&window)?;
    tauri::async_runtime::spawn_blocking(move || {
        let state = app.state::<Mutex<DocState>>();
        document::list_folder_entries(rel_dir, state)
    })
    .await
    .map_err(|error| error.to_string())?
}

#[tauri::command]
async fn folder_metadata(
    paths: Vec<String>,
    include_counts: bool,
    window: tauri::WebviewWindow,
    state: State<'_>,
) -> Result<Vec<wasabipad_core::TreeMetadata>, String> {
    access::require_main_window(&window)?;
    let root = state::with_doc(&state, |doc| doc.workspace_root())?
        .ok_or_else(|| "no folder".to_string())?;
    tauri::async_runtime::spawn_blocking(move || {
        paths.into_iter().map(|path| {
            let relative = std::path::Path::new(&path);
            if relative.components().any(|c| !matches!(c, std::path::Component::Normal(_))) {
                return Err("invalid path".to_string());
            }
            Ok(wasabipad_core::tree_metadata(&root.join(relative), include_counts))
        }).collect()
    }).await.map_err(|e| e.to_string())?
}

#[tauri::command]
async fn workspace_search(
    pat: String,
    options: SearchOptions,
    search_id: u32,
    window: tauri::WebviewWindow,
    app: AppHandle,
    state: State<'_>,
    cancel: tauri::State<'_, search::SearchCancel>,
) -> Result<WorkspaceSearchOutcome, String> {
    access::require_main_window(&window)?;
    search::workspace_search(pat, options, search_id, app, state, cancel).await
}

#[tauri::command]
fn workspace_search_cancel(
    search_id: u32,
    window: tauri::WebviewWindow,
    cancel: tauri::State<'_, search::SearchCancel>,
) -> Result<(), String> {
    access::require_main_window(&window)?;
    search::workspace_search_cancel(search_id, cancel)
}

#[tauri::command]
async fn create_note(
    dir: Option<String>,
    name: String,
    enc: EncodingId,
    eol: Eol,
    window: tauri::WebviewWindow,
    app: AppHandle,
) -> Result<DocInfo, String> {
    access::require_main_window(&window)?;
    tauri::async_runtime::spawn_blocking(move || {
        let state = app.state::<Mutex<DocState>>();
        document::create_note(dir, name, enc, eol, state)
    })
    .await
    .map_err(|error| error.to_string())?
}

#[tauri::command]
async fn create_folder(
    rel_dir: String,
    name: String,
    window: tauri::WebviewWindow,
    app: AppHandle,
) -> Result<String, String> {
    access::require_main_window(&window)?;
    tauri::async_runtime::spawn_blocking(move || {
        let state = app.state::<Mutex<DocState>>();
        document::create_folder(rel_dir, name, state)
    })
    .await
    .map_err(|error| error.to_string())?
}

#[tauri::command]
async fn rename_entry(
    rel_path: String,
    new_name: String,
    window: tauri::WebviewWindow,
    app: AppHandle,
) -> Result<DocInfo, String> {
    access::require_main_window(&window)?;
    tauri::async_runtime::spawn_blocking(move || {
        let state = app.state::<Mutex<DocState>>();
        document::rename_entry(rel_path, new_name, state)
    })
    .await
    .map_err(|error| error.to_string())?
}

#[tauri::command]
async fn move_entry(
    source_rel_path: String,
    target_rel_dir: String,
    window: tauri::WebviewWindow,
    app: AppHandle,
) -> Result<DocInfo, String> {
    access::require_main_window(&window)?;
    tauri::async_runtime::spawn_blocking(move || {
        let state = app.state::<Mutex<DocState>>();
        document::move_entry(source_rel_path, target_rel_dir, state)
    })
    .await
    .map_err(|error| error.to_string())?
}

#[tauri::command]
async fn copy_entry(
    source_rel_path: String,
    target_rel_dir: String,
    window: tauri::WebviewWindow,
    app: AppHandle,
) -> Result<DocInfo, String> {
    access::require_main_window(&window)?;
    tauri::async_runtime::spawn_blocking(move || {
        let state = app.state::<Mutex<DocState>>();
        document::copy_entry(source_rel_path, target_rel_dir, state)
    })
    .await
    .map_err(|error| error.to_string())?
}

#[tauri::command]
async fn copy_entry_as(
    source_rel_path: String,
    target_rel_dir: String,
    target_name: String,
    overwrite: bool,
    window: tauri::WebviewWindow,
    app: AppHandle,
) -> Result<DocInfo, String> {
    access::require_main_window(&window)?;
    tauri::async_runtime::spawn_blocking(move || {
        let state = app.state::<Mutex<DocState>>();
        document::copy_entry_as(
            source_rel_path,
            target_rel_dir,
            target_name,
            overwrite,
            state,
        )
    })
    .await
    .map_err(|error| error.to_string())?
}

#[tauri::command]
async fn move_entry_as(
    source_rel_path: String,
    target_rel_dir: String,
    target_name: String,
    overwrite: bool,
    window: tauri::WebviewWindow,
    app: AppHandle,
) -> Result<DocInfo, String> {
    access::require_main_window(&window)?;
    tauri::async_runtime::spawn_blocking(move || {
        let state = app.state::<Mutex<DocState>>();
        document::move_entry_as(
            source_rel_path,
            target_rel_dir,
            target_name,
            overwrite,
            state,
        )
    })
    .await
    .map_err(|error| error.to_string())?
}

#[tauri::command]
async fn delete_entry(
    rel_path: String,
    window: tauri::WebviewWindow,
    app: AppHandle,
) -> Result<DocInfo, String> {
    access::require_main_window(&window)?;
    tauri::async_runtime::spawn_blocking(move || {
        let state = app.state::<Mutex<DocState>>();
        document::delete_entry(rel_path, state)
    })
    .await
    .map_err(|error| error.to_string())?
}

#[tauri::command]
async fn delete_entry_without_backup(
    rel_path: String,
    window: tauri::WebviewWindow,
    app: AppHandle,
) -> Result<DocInfo, String> {
    access::require_main_window(&window)?;
    tauri::async_runtime::spawn_blocking(move || {
        let state = app.state::<Mutex<DocState>>();
        document::delete_entry_without_backup(rel_path, state)
    })
    .await
    .map_err(|error| error.to_string())?
}

#[tauri::command]
async fn restore_deleted_entry(
    rel_path: String,
    window: tauri::WebviewWindow,
    app: AppHandle,
) -> Result<DocInfo, String> {
    access::require_main_window(&window)?;
    tauri::async_runtime::spawn_blocking(move || {
        let state = app.state::<Mutex<DocState>>();
        document::restore_deleted_entry(rel_path, state)
    })
    .await
    .map_err(|error| error.to_string())?
}

#[tauri::command]
async fn save_pasted_image(
    bytes: Vec<u8>,
    mime_type: String,
    window: tauri::WebviewWindow,
    app: AppHandle,
) -> Result<String, String> {
    access::require_main_window(&window)?;
    tauri::async_runtime::spawn_blocking(move || {
        let state = app.state::<Mutex<DocState>>();
        document::save_pasted_image(bytes, mime_type, state)
    })
    .await
    .map_err(|error| error.to_string())?
}

#[tauri::command]
async fn save_diagram_image(
    bytes: Vec<u8>,
    mime_type: String,
    shared: bool,
    source_path: String,
    archive_entry: Option<String>,
    window: tauri::WebviewWindow,
    app: AppHandle,
) -> Result<String, String> {
    access::require_main_window(&window)?;
    tauri::async_runtime::spawn_blocking(move || {
        let state = app.state::<Mutex<DocState>>();
        document::save_diagram_image(bytes, mime_type, shared, source_path, archive_entry, state)
    })
    .await
    .map_err(|error| error.to_string())?
}

#[tauri::command]
async fn finish_diagram_assets(
    source_path: String,
    archive_entry: Option<String>,
    window: tauri::WebviewWindow,
    app: AppHandle,
) -> Result<(), String> {
    access::require_main_window(&window)?;
    tauri::async_runtime::spawn_blocking(move || {
        let state = app.state::<Mutex<DocState>>();
        document::finish_diagram_assets(source_path, archive_entry, state)
    })
    .await
    .map_err(|error| error.to_string())?
}

#[tauri::command]
async fn read_diagram_asset(
    path: String,
    source_path: String,
    window: tauri::WebviewWindow,
    app: AppHandle,
) -> Result<tauri::ipc::Response, String> {
    access::require_viewer_or_main(&window)?;
    let bytes = tauri::async_runtime::spawn_blocking(move || {
        let state = app.state::<Mutex<DocState>>();
        document::read_diagram_asset(path, source_path, state)
    }).await.map_err(|error| error.to_string())??;
    Ok(tauri::ipc::Response::new(bytes))
}

#[tauri::command]
#[allow(clippy::too_many_arguments)]
async fn apply_diagram_edit(
    start: PosC,
    end: PosC,
    caret_before: PosC,
    text: String,
    expected: String,
    expected_line: String,
    source_path: String,
    archive_entry: Option<String>,
    window: tauri::WebviewWindow,
    app: AppHandle,
) -> Result<EditResult, String> {
    access::require_main_window(&window)?;
    tauri::async_runtime::spawn_blocking(move || {
        let state = app.state::<Mutex<DocState>>();
        document::apply_diagram_edit(start, end, caret_before, text, expected, expected_line, source_path, archive_entry, state)
    })
    .await
    .map_err(|error| error.to_string())?
}

#[tauri::command]
async fn cleanup_unused_images(
    path: String,
    window: tauri::WebviewWindow,
    app: AppHandle,
) -> Result<(), String> {
    access::require_main_window(&window)?;
    tauri::async_runtime::spawn_blocking(move || {
        let state = app.state::<Mutex<DocState>>();
        document::cleanup_unused_images(path, state)
    })
    .await
    .map_err(|error| error.to_string())?
}

// サイドバーの「エクスプローラで開く」用。状態を持たないので Doc へは委譲しない。
#[tauri::command]
fn reveal_in_explorer(
    path: String,
    is_dir: bool,
    window: tauri::WebviewWindow,
) -> Result<(), String> {
    access::require_main_window(&window)?;
    system::reveal_in_explorer(path, is_dir)
}

#[tauri::command]
fn open_in_other_app(path: String, window: tauri::WebviewWindow) -> Result<(), String> {
    access::require_main_window(&window)?;
    system::open_in_other_app(path)
}

#[tauri::command]
fn open_in_default_browser(
    path: String,
    effective_extension: Option<String>,
    window: tauri::WebviewWindow,
    app: AppHandle,
) -> Result<(), String> {
    access::require_viewer_or_main(&window)?;
    let authorized = resolve_authorized_source_path(
        &app,
        window.label(),
        &path,
        false,
        "既定のブラウザで開く権限がありません",
    )?;
    system::open_in_default_browser(
        access::strip_windows_verbatim_prefix(&authorized),
        effective_extension,
    )
}

#[tauri::command]
fn open_external_url(url: String, window: tauri::WebviewWindow) -> Result<(), String> {
    access::require_viewer_or_main(&window)?;
    system::open_external_url(url)
}

#[tauri::command]
fn run_external_command(
    request: system::ExternalCommandRequest,
    window: tauri::WebviewWindow,
) -> Result<(), String> {
    access::require_main_window(&window)?;
    system::run_external_command(request)
}

fn resolve_authorized_source_path(
    app: &AppHandle,
    label: &str,
    requested_path: &str,
    allow_any_for_main: bool,
    denied_message: &str,
) -> Result<PathBuf, String> {
    let expected = if access::is_main_window_label(label) {
        if allow_any_for_main {
            None
        } else {
            let doc_state = app.state::<Mutex<DocState>>();
            state::with_doc(&doc_state, |doc| doc.path().map(PathBuf::from))?
        }
    } else {
        let viewer_store = app.state::<ViewerStore>();
        let path = viewer_store
            .0
            .lock()
            .map_err(|_| "ビュー状態の参照に失敗しました".to_owned())?
            .get(label)
            .and_then(|payload| payload.source_path.as_deref().map(PathBuf::from));
        path
    };
    access::authorize_scoped_path(
        label,
        requested_path,
        expected.as_deref(),
        allow_any_for_main,
        denied_message,
    )
}

#[tauri::command]
async fn register_html_preview(
    id: String,
    html: String,
    source_path: Option<String>,
    window: tauri::WebviewWindow,
    app: AppHandle,
) -> Result<(), String> {
    access::require_viewer_or_main(&window)?;
    let label = window.label().to_owned();
    tauri::async_runtime::spawn_blocking(move || {
        let authorized_source = match source_path {
            Some(path) => Some(
                resolve_authorized_source_path(
                    &app,
                    &label,
                    &path,
                    false,
                    "HTML preview path is not the active document.",
                )?
                .to_string_lossy()
                .into_owned(),
            ),
            None => None,
        };
        app.state::<html_preview::HtmlPreviews>()
            .register(id, html, authorized_source, label)
    })
    .await
    .map_err(|error| error.to_string())?
}

#[tauri::command]
fn release_html_preview(
    id: String,
    window: tauri::WebviewWindow,
    state: tauri::State<'_, html_preview::HtmlPreviews>,
) -> Result<(), String> {
    access::require_viewer_or_main(&window)?;
    state.remove(&id)
}

#[tauri::command]
async fn register_external_html_preview(
    id: String,
    entry_path: String,
    window: tauri::WebviewWindow,
    app: AppHandle,
) -> Result<(), String> {
    access::require_viewer_or_main(&window)?;
    let label = window.label().to_owned();
    tauri::async_runtime::spawn_blocking(move || {
        let candidate = PathBuf::from(&entry_path);
        let canonical = candidate
            .canonicalize()
            .map_err(|error| format!("External HTML preview path could not be resolved: {error}"))?;
        let operations = app.state::<external_preview_runner::ExternalPreviewOperations>();
        let allowed = operations.is_managed_output(&canonical) || {
            let doc_state = app.state::<Mutex<DocState>>();
            let current_doc_path = state::with_doc(&doc_state, |doc| doc.path().map(PathBuf::from))?;
            current_doc_path.is_some_and(|doc_path| {
                let matches_saved = external_preview_runner::saved_output(
                    &doc_path,
                    external_preview_runner::ExternalPreviewFormat::Html,
                )
                .ok()
                .flatten()
                .and_then(|saved| saved.canonicalize().ok())
                .is_some_and(|saved| saved == canonical);
                let matches_sibling = external_preview_runner::existing_output(
                    &doc_path,
                    external_preview_runner::ExternalPreviewFormat::Html,
                )
                .and_then(|existing| existing.canonicalize().ok())
                .is_some_and(|existing| existing == canonical);
                matches_saved || matches_sibling
            })
        };
        if !allowed {
            return Err("External HTML preview path is not authorized.".to_owned());
        }
        app.state::<external_html_preview::ExternalHtmlPreviews>()
            .register(id, canonical, label)
    })
    .await
    .map_err(|error| error.to_string())?
}

#[tauri::command]
fn release_external_html_preview(
    id: String,
    window: tauri::WebviewWindow,
    state: tauri::State<'_, external_html_preview::ExternalHtmlPreviews>,
) -> Result<(), String> {
    access::require_viewer_or_main(&window)?;
    state.remove(&id)
}

#[tauri::command]
async fn register_pdf_preview(
    id: String,
    path: String,
    window: tauri::WebviewWindow,
    app: AppHandle,
) -> Result<(), String> {
    access::require_viewer_or_main(&window)?;
    let label = window.label().to_owned();
    tauri::async_runtime::spawn_blocking(move || {
        let canonical = resolve_authorized_source_path(
            &app,
            &label,
            &path,
            false,
            "PDF preview path is not the active document.",
        )?;
        app.state::<pdf_preview::PdfPreviews>()
            .register(id, canonical, label)
    })
    .await
    .map_err(|error| error.to_string())?
}

#[tauri::command]
fn release_pdf_preview(
    id: String,
    window: tauri::WebviewWindow,
    state: tauri::State<'_, pdf_preview::PdfPreviews>,
) -> Result<(), String> {
    access::require_viewer_or_main(&window)?;
    state.remove(&id)
}

#[tauri::command]
async fn external_preview_resolve(
    request: external_preview_runner::ExternalPreviewResolveRequest,
    window: tauri::WebviewWindow,
    app: AppHandle,
    operations: tauri::State<'_, external_preview_runner::ExternalPreviewOperations>,
) -> Result<Option<external_preview_runner::ExternalPreviewResolved>, String> {
    access::require_main_window(&window)?;
    let settings = wasabipad_core::load_settings().map_err(|error| error.to_string())?;
    access::validate_external_preview_adapter_against_settings(
        &settings,
        &request.adapter_id,
        &request.executable,
        &request.args,
        request.output_format,
        false,
    )?;
    let operations = operations.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        let resolved = operations.resolve_reusable_output(
            std::path::Path::new(&request.input_path),
            &request.executable,
            &request.args,
            request.output_format,
        )?;
        if let Some(ref resolved) = resolved {
            access::allow_asset_scope_for_path(&app, std::path::Path::new(&resolved.output_path));
        }
        Ok(resolved)
    })
    .await
    .map_err(|error| error.to_string())?
}

#[tauri::command]
async fn external_preview_generate(
    request: external_preview_runner::ExternalPreviewRequest,
    displayed_output_path: Option<String>,
    window: tauri::WebviewWindow,
    app: AppHandle,
    operations: tauri::State<'_, external_preview_runner::ExternalPreviewOperations>,
) -> Result<String, String> {
    access::require_main_window(&window)?;
    if request
        .work_root
        .as_deref()
        .is_some_and(|root| root.trim().is_empty())
    {
        return Err("External preview work root cannot be empty.".to_owned());
    }
    let settings = wasabipad_core::load_settings().map_err(|error| error.to_string())?;
    access::validate_external_preview_request_against_settings(&settings, &request)?;
    let operations = operations.inner().clone();
    let request_id = request.request_id.clone();
    let input_path = PathBuf::from(&request.input_path);
    let work_root = request
        .work_root
        .map(PathBuf::from)
        .unwrap_or_else(external_preview_runner::default_work_root);
    let (cancelled, input_path) = operations.register(&request_id, &input_path)?;
    let guard = operations.guard(request_id, cancelled.clone());
    tauri::async_runtime::spawn_blocking(move || {
        let _guard = guard;
        let pre_sha256 = external_preview_runner::hash_input_file(&input_path)?;
        let executable = PathBuf::from(&request.executable);
        let result = external_preview_runner::run_external_preview(
            &executable,
            &request.args,
            &input_path,
            request.output_format,
            &work_root,
            &cancelled,
        )?;
        let post_sha256 = external_preview_runner::hash_input_file(&input_path).ok();
        let session_record = (post_sha256 == Some(pre_sha256)).then(|| {
            (
                pre_sha256,
                external_preview_runner::ExternalPreviewConfigKey::normalized(
                    &request.executable,
                    &request.args,
                    request.output_format,
                ),
            )
        });
        operations.finish_session_success(
            &request.request_id,
            &cancelled,
            &result.output_path,
            &work_root,
            session_record,
            displayed_output_path.as_deref().map(std::path::Path::new),
        )?;
        access::allow_asset_scope_for_path(&app, &result.output_path);
        Ok(access::strip_windows_verbatim_prefix(&result.output_path))
    })
    .await
    .map_err(|error| format!("External preview generation failed: {error}"))?
}

#[tauri::command]
async fn external_preview_save(
    input_path: String,
    output_path: String,
    output_format: external_preview_runner::ExternalPreviewFormat,
    overwrite: bool,
    window: tauri::WebviewWindow,
    app: AppHandle,
) -> Result<external_preview_runner::ExternalPreviewSaveOutcome, String> {
    access::require_main_window(&window)?;
    let label = window.label().to_owned();
    tauri::async_runtime::spawn_blocking(move || {
        let _ = resolve_authorized_source_path(
            &app,
            &label,
            &input_path,
            false,
            "保存対象の外部プレビューが現在開いている文書と一致しません。",
        )?;
        let operations = app.state::<external_preview_runner::ExternalPreviewOperations>();
        let outcome = operations.save_external_preview(
            std::path::Path::new(&input_path),
            std::path::Path::new(&output_path),
            output_format,
            overwrite,
        )?;
        if let external_preview_runner::ExternalPreviewSaveOutcome::Saved { ref output_path } =
            outcome
        {
            access::allow_asset_scope_for_path(&app, std::path::Path::new(output_path));
        }
        Ok(outcome)
    })
    .await
    .map_err(|error| error.to_string())?
}

#[tauri::command]
fn external_preview_cancel(
    request_id: String,
    window: tauri::WebviewWindow,
    operations: tauri::State<'_, external_preview_runner::ExternalPreviewOperations>,
) -> Result<(), String> {
    access::require_main_window(&window)?;
    operations.cancel(&request_id)
}

#[tauri::command]
async fn external_preview_cleanup(
    output_path: String,
    window: tauri::WebviewWindow,
    app: AppHandle,
) -> Result<(), String> {
    access::require_main_window(&window)?;
    tauri::async_runtime::spawn_blocking(move || {
        let operations = app.state::<external_preview_runner::ExternalPreviewOperations>();
        let output_path = PathBuf::from(output_path);
        operations.cleanup_retired_output(&output_path)
    })
    .await
    .map_err(|error| error.to_string())?
}

#[tauri::command]
async fn external_preview_discard(
    output_path: String,
    window: tauri::WebviewWindow,
    app: AppHandle,
) -> Result<(), String> {
    access::require_main_window(&window)?;
    tauri::async_runtime::spawn_blocking(move || {
        let operations = app.state::<external_preview_runner::ExternalPreviewOperations>();
        let output_path = PathBuf::from(output_path);
        operations.discard_output(&output_path)
    })
    .await
    .map_err(|error| error.to_string())?
}

#[tauri::command]
async fn external_preview_cleanup_all(
    window: tauri::WebviewWindow,
    app: AppHandle,
) -> Result<(), String> {
    access::require_main_window(&window)?;
    tauri::async_runtime::spawn_blocking(move || {
        let operations = app.state::<external_preview_runner::ExternalPreviewOperations>();
        operations.cleanup_all()
    })
    .await
    .map_err(|error| error.to_string())?
}

#[tauri::command]
async fn external_preview_cleanup_stale(
    work_roots: Vec<String>,
    window: tauri::WebviewWindow,
    app: AppHandle,
) -> Result<(), String> {
    access::require_main_window(&window)?;
    tauri::async_runtime::spawn_blocking(move || {
        let settings_json = wasabipad_core::load_settings().map_err(|error| error.to_string())?;
        let validated_roots = access::validate_external_preview_cleanup_roots_against_settings(
            &settings_json,
            &work_roots,
        )?;
        let operations = app.state::<external_preview_runner::ExternalPreviewOperations>();
        let mut roots = vec![external_preview_runner::default_work_root()];
        roots.extend(validated_roots);
        operations.cleanup_stale_roots(&roots)
    })
    .await
    .map_err(|error| error.to_string())?
}

#[tauri::command]
fn edit(
    start: PosC,
    end: PosC,
    caret_before: PosC,
    text: String,
    coalesce: bool,
    window: tauri::WebviewWindow,
    state: State,
) -> Result<EditResult, String> {
    access::require_main_window(&window)?;
    document::edit(start, end, caret_before, text, coalesce, state)
}

#[tauri::command]
fn edit_many(
    edits: Vec<EditManyItem>,
    caret_before: PosC,
    primary_index: usize,
    window: tauri::WebviewWindow,
    state: State,
) -> Result<EditManyResult, String> {
    access::require_main_window(&window)?;
    document::edit_many(edits, caret_before, primary_index, state)
}

#[tauri::command]
fn undo(window: tauri::WebviewWindow, state: State) -> Result<Option<EditResult>, String> {
    access::require_main_window(&window)?;
    document::undo(state)
}

#[tauri::command]
fn redo(window: tauri::WebviewWindow, state: State) -> Result<Option<EditResult>, String> {
    access::require_main_window(&window)?;
    document::redo(state)
}

#[tauri::command]
#[allow(clippy::too_many_arguments)]
async fn find(
    pat: String,
    from: PosC,
    forward: bool,
    match_case: bool,
    use_regex: bool,
    whole_word: bool,
    window: tauri::WebviewWindow,
    app: AppHandle,
) -> Result<Option<FindResult>, String> {
    access::require_main_window(&window)?;
    tauri::async_runtime::spawn_blocking(move || {
        let state = app.state::<Mutex<DocState>>();
        document::find(pat, from, forward, match_case, use_regex, whole_word, state)
    })
    .await
    .map_err(|error| error.to_string())?
}

#[tauri::command]
#[allow(clippy::too_many_arguments)]
async fn find_all_in_range(
    pat: String,
    first_line: usize,
    last_line: usize,
    match_case: bool,
    use_regex: bool,
    whole_word: bool,
    max_matches: usize,
    window: tauri::WebviewWindow,
    app: AppHandle,
) -> Result<Vec<FindResult>, String> {
    access::require_main_window(&window)?;
    tauri::async_runtime::spawn_blocking(move || {
        let state = app.state::<Mutex<DocState>>();
        document::find_all_in_range(
            pat,
            first_line,
            last_line,
            match_case,
            use_regex,
            whole_word,
            max_matches,
            state,
        )
    })
    .await
    .map_err(|error| error.to_string())?
}

#[tauri::command]
#[allow(clippy::too_many_arguments)]
async fn find_step(
    pat: String,
    from: PosC,
    match_case: bool,
    cursor: Option<FindCursor>,
    budget: usize,
    use_regex: bool,
    whole_word: bool,
    window: tauri::WebviewWindow,
    app: AppHandle,
) -> Result<FindOutcome, String> {
    access::require_main_window(&window)?;
    tauri::async_runtime::spawn_blocking(move || {
        let state = app.state::<Mutex<DocState>>();
        document::find_step(pat, from, match_case, cursor, budget, use_regex, whole_word, state)
    })
    .await
    .map_err(|error| error.to_string())?
}

#[tauri::command]
#[allow(clippy::too_many_arguments)]
async fn replace_all_chunk(
    pat: String,
    rep: String,
    match_case: bool,
    budget: usize,
    use_regex: bool,
    whole_word: bool,
    window: tauri::WebviewWindow,
    app: AppHandle,
) -> Result<ReplaceChunkResult, String> {
    access::require_main_window(&window)?;
    tauri::async_runtime::spawn_blocking(move || {
        let state = app.state::<Mutex<DocState>>();
        document::replace_all_chunk(pat, rep, match_case, budget, use_regex, whole_word, state)
    })
    .await
    .map_err(|error| error.to_string())?
}

#[tauri::command]
async fn replace_all_cancel(window: tauri::WebviewWindow, app: AppHandle) -> Result<EditResult, String> {
    access::require_main_window(&window)?;
    tauri::async_runtime::spawn_blocking(move || {
        let state = app.state::<Mutex<DocState>>();
        document::replace_all_cancel(state)
    })
    .await
    .map_err(|error| error.to_string())?
}

#[tauri::command]
async fn save_file(
    path: String,
    enc: EncodingId,
    eol: Eol,
    window: tauri::WebviewWindow,
    app: AppHandle,
) -> Result<SaveOutcome, String> {
    access::require_main_window(&window)?;
    tauri::async_runtime::spawn_blocking(move || {
        let state = app.state::<Mutex<DocState>>();
        document::save_file(path, enc, eol, state)
    })
    .await
    .map_err(|error| error.to_string())?
}

// 外部変更ポーリング (フロントの定期タイマーから呼ぶ)。dirty はフロントが管理する
// 未保存フラグ。小/巨大ファイルの区別も含め、判定はすべて core 側が持つ。
#[tauri::command]
async fn poll_external(
    dirty: bool,
    window: tauri::WebviewWindow,
    app: AppHandle,
) -> Result<ExternalCheck, String> {
    access::require_main_window(&window)?;
    tauri::async_runtime::spawn_blocking(move || {
        let state = app.state::<Mutex<DocState>>();
        document::poll_external(dirty, state)
    })
    .await
    .map_err(|error| error.to_string())?
}

#[tauri::command]
async fn reload_from_disk(window: tauri::WebviewWindow, app: AppHandle) -> Result<DocInfo, String> {
    access::require_main_window(&window)?;
    tauri::async_runtime::spawn_blocking(move || {
        let state = app.state::<Mutex<DocState>>();
        document::reload_from_disk(state)
    })
    .await
    .map_err(|error| error.to_string())?
}

#[tauri::command]
async fn ack_external(window: tauri::WebviewWindow, app: AppHandle) -> Result<DocInfo, String> {
    access::require_main_window(&window)?;
    tauri::async_runtime::spawn_blocking(move || {
        let state = app.state::<Mutex<DocState>>();
        document::ack_external(state)
    })
    .await
    .map_err(|error| error.to_string())?
}

#[tauri::command]
async fn external_merge_preview(
    window: tauri::WebviewWindow,
    app: AppHandle,
) -> Result<ExternalMergePreview, String> {
    access::require_main_window(&window)?;
    tauri::async_runtime::spawn_blocking(move || {
        let state = app.state::<Mutex<DocState>>();
        document::external_merge_preview(state)
    })
    .await
    .map_err(|error| error.to_string())?
}

#[tauri::command]
async fn merge_external(window: tauri::WebviewWindow, app: AppHandle) -> Result<DocInfo, String> {
    access::require_main_window(&window)?;
    tauri::async_runtime::spawn_blocking(move || {
        let state = app.state::<Mutex<DocState>>();
        document::merge_external(state)
    })
    .await
    .map_err(|error| error.to_string())?
}

#[tauri::command]
fn set_encoding(
    enc: EncodingId,
    window: tauri::WebviewWindow,
    state: State,
) -> Result<(), String> {
    access::require_main_window(&window)?;
    document::set_encoding(enc, state)
}

#[tauri::command]
fn set_eol(eol: Eol, window: tauri::WebviewWindow, state: State) -> Result<(), String> {
    access::require_main_window(&window)?;
    document::set_eol(eol, state)
}

#[tauri::command]
fn load_bookmarks(window: tauri::WebviewWindow) -> Result<Vec<BookmarkNode>, String> {
    access::require_main_window(&window)?;
    system::load_bookmarks()
}

#[tauri::command]
fn save_bookmarks(
    nodes: Vec<BookmarkNode>,
    window: tauri::WebviewWindow,
) -> Result<(), String> {
    access::require_main_window(&window)?;
    system::save_bookmarks(nodes)
}

// 設定値はJSONとして扱い、キー単位で更新して別プロセスの変更を巻き戻さない。
#[tauri::command]
fn load_settings(window: tauri::WebviewWindow) -> Result<String, String> {
    access::require_viewer_or_main(&window)?;
    system::load_settings()
}

#[tauri::command]
fn update_setting(
    key: String,
    value_json: String,
    window: tauri::WebviewWindow,
) -> Result<(), String> {
    access::require_setting_update_allowed(&window, &key)?;
    system::update_setting(key, value_json)
}

#[tauri::command]
fn path_is_directory(path: String, window: tauri::WebviewWindow) -> bool {
    if access::require_main_window(&window).is_err() {
        return false;
    }
    system::path_is_directory(path)
}

#[tauri::command]
async fn reload_with_encoding(
    enc: EncodingId,
    window: tauri::WebviewWindow,
    app: AppHandle,
) -> Result<DocInfo, String> {
    access::require_main_window(&window)?;
    tauri::async_runtime::spawn_blocking(move || {
        let state = app.state::<Mutex<DocState>>();
        document::reload_with_encoding(enc, state)
    })
    .await
    .map_err(|error| error.to_string())?
}

#[tauri::command]
fn next_memo_path(
    directory: String,
    stem: String,
    extension: String,
    window: tauri::WebviewWindow,
) -> Result<String, String> {
    access::require_main_window(&window)?;
    system::next_memo_path(directory, stem, extension)
}

#[tauri::command]
fn launch_new_instance(
    request: WindowRequest,
    window: tauri::WebviewWindow,
) -> Result<(), String> {
    access::require_main_window(&window)?;
    spawn_new_instance(request)
}

#[tauri::command]
fn initial_window_request(window: tauri::WebviewWindow) -> Result<WindowRequest, String> {
    access::require_main_window(&window)?;
    read_initial_window_request()
}

#[tauri::command]
async fn read_archive_asset(
    archive_path: String,
    entry: String,
    cache_directory: Option<String>,
    window: tauri::WebviewWindow,
    app: AppHandle,
) -> Result<tauri::ipc::Response, String> {
    access::require_viewer_or_main(&window)?;
    let bytes = tauri::async_runtime::spawn_blocking(move || {
        let state = app.state::<Mutex<DocState>>();
        document::read_archive_asset(archive_path, entry, cache_directory, state)
    })
    .await
    .map_err(|error| error.to_string())??;
    Ok(tauri::ipc::Response::new(bytes))
}

#[tauri::command]
async fn read_file_asset(
    path: String,
    cache_directory: Option<String>,
    window: tauri::WebviewWindow,
    app: AppHandle,
) -> Result<tauri::ipc::Response, String> {
    access::require_viewer_or_main(&window)?;
    let bytes = tauri::async_runtime::spawn_blocking(move || {
        let state = app.state::<Mutex<DocState>>();
        document::read_file_asset(path, cache_directory, state)
    })
    .await
    .map_err(|error| error.to_string())??;
    Ok(tauri::ipc::Response::new(bytes))
}

fn preview_cache_from_directory(cache_directory: Option<String>) -> Result<PreviewCache, String> {
    let root = cache_directory
        .filter(|directory| !directory.trim().is_empty())
        .map(PathBuf::from)
        .or_else(|| PreviewCache::default_root().ok())
        .ok_or_else(|| "プレビューキャッシュの既定保存場所を取得できません".to_string())?;
    Ok(PreviewCache::new(root))
}

fn preview_cache_info_impl(cache_directory: Option<String>) -> Result<PreviewCacheInfo, String> {
    let cache = preview_cache_from_directory(cache_directory)?;
    std::fs::create_dir_all(cache.directory()).map_err(|error| error.to_string())?;
    let bytes = cache.total_bytes().map_err(|error| error.to_string())?;
    Ok(PreviewCacheInfo {
        directory: cache.directory().to_string_lossy().into_owned(),
        bytes,
    })
}

fn validated_preview_cache(cache_directory: Option<String>) -> Result<PreviewCache, String> {
    let settings_json = wasabipad_core::load_settings().map_err(|error| error.to_string())?;
    let validated = access::validate_preview_cache_directory_against_settings(
        &settings_json,
        cache_directory.as_deref(),
    )?;
    let root = validated
        .or_else(|| PreviewCache::default_root().ok())
        .ok_or_else(|| "プレビューキャッシュの既定保存場所を取得できません".to_string())?;
    Ok(PreviewCache::new(root))
}

#[tauri::command]
async fn preview_cache_info(
    cache_directory: Option<String>,
    window: tauri::WebviewWindow,
) -> Result<PreviewCacheInfo, String> {
    access::require_main_window(&window)?;
    tauri::async_runtime::spawn_blocking(move || {
        let cache = validated_preview_cache(cache_directory)?;
        std::fs::create_dir_all(cache.directory()).map_err(|error| error.to_string())?;
        let bytes = cache.total_bytes().map_err(|error| error.to_string())?;
        Ok(PreviewCacheInfo {
            directory: cache.directory().to_string_lossy().into_owned(),
            bytes,
        })
    })
    .await
    .map_err(|error| error.to_string())?
}

#[tauri::command]
async fn clear_preview_cache(
    cache_directory: Option<String>,
    window: tauri::WebviewWindow,
) -> Result<(), String> {
    access::require_main_window(&window)?;
    tauri::async_runtime::spawn_blocking(move || {
        validated_preview_cache(cache_directory)?
            .clear()
            .map_err(|error| error.to_string())
    })
    .await
    .map_err(|error| error.to_string())?
}

#[tauri::command]
fn take_pending_window_requests(
    window: tauri::WebviewWindow,
    state: tauri::State<'_, InstanceServer>,
) -> Vec<WindowRequest> {
    if access::require_main_window(&window).is_err() {
        return Vec::new();
    }
    drain_pending_window_requests(&state)
}

#[cfg(test)]
mod window_request_tests {
    use super::{parse_window_request, preview_cache_info_impl};
    use std::time::{SystemTime, UNIX_EPOCH};

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

    // Feature: 外部プレビューキャッシュ保存場所
    // Scenario: 保存場所の情報確認で未作成のキャッシュフォルダを用意する
    // Given: まだ存在しないプレビューキャッシュ保存場所が指定されている
    // When: 保存場所と使用量を取得する
    // Then: 表示対象のキャッシュフォルダが作成される
    #[test]
    fn preview_cache_info_creates_missing_storage_directory() {
        let root = std::env::temp_dir().join(format!(
            "wasabipad-preview-info-{}-{}",
            std::process::id(),
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap()
                .as_nanos(),
        ));
        let info = preview_cache_info_impl(Some(root.to_string_lossy().into_owned())).unwrap();

        assert!(std::path::Path::new(&info.directory).is_dir());
        let _ = std::fs::remove_dir_all(root);
    }
}

// Windowsでは同期command中のWebView生成がイベントループを塞ぐためasyncで実行する。
#[tauri::command]
#[allow(clippy::too_many_arguments)]
async fn open_viewer(
    format: ViewerFormat,
    text: String,
    selection: Option<ViewerSelection>,
    source_path: Option<String>,
    effective_extension: Option<String>,
    window: tauri::WebviewWindow,
    app: AppHandle,
    doc_state: State<'_>,
    state: tauri::State<'_, ViewerStore>,
) -> Result<String, String> {
    access::require_main_window(&window)?;
    viewer::open_viewer(
        format,
        text,
        selection,
        source_path,
        effective_extension,
        app,
        doc_state,
        state,
    )
    .await
}

#[tauri::command]
fn set_inline_preview_focus(
    focused: bool,
    window: tauri::WebviewWindow,
    state: tauri::State<'_, FindShortcutGuard>,
) {
    if access::require_main_window(&window).is_err() {
        return;
    }
    state.set(focused);
}

#[tauri::command]
fn take_viewer_payload(
    label: String,
    window: tauri::WebviewWindow,
    state: tauri::State<'_, ViewerStore>,
) -> Result<ViewerPayload, String> {
    access::require_matching_viewer_label(&window, &label)?;
    viewer::take_viewer_payload(label, state)
}

#[tauri::command]
fn update_viewer(
    label: String,
    text: String,
    selection: Option<ViewerSelection>,
    window: tauri::WebviewWindow,
    app: AppHandle,
    state: tauri::State<'_, ViewerStore>,
) -> Result<bool, String> {
    access::require_main_window(&window)?;
    viewer::update_viewer(label, text, selection, app, state)
}

#[tauri::command]
fn close_viewer(
    label: String,
    window: tauri::WebviewWindow,
    app: AppHandle,
    state: tauri::State<'_, ViewerStore>,
) -> Result<(), String> {
    access::require_main_window(&window)?;
    viewer::close_viewer(label, app, state)
}

#[tauri::command]
async fn probe_sqlite_preview(
    path: String,
    window: tauri::WebviewWindow,
) -> Result<bool, String> {
    access::require_main_window(&window)?;
    tauri::async_runtime::spawn_blocking(move || {
        wasabipad_core::is_sqlite_preview_eligible(std::path::Path::new(&path))
    })
    .await
    .map_err(|error| error.to_string())
}

#[tauri::command]
async fn read_sqlite_preview(
    path: String,
    selected_name: Option<String>,
    offset: usize,
    limit: usize,
    include_metadata: bool,
    query_sql: Option<String>,
    window: tauri::WebviewWindow,
    app: AppHandle,
) -> Result<SqlitePreview, String> {
    access::require_viewer_or_main(&window)?;
    let label = window.label().to_owned();
    tauri::async_runtime::spawn_blocking(move || {
        let authorized = resolve_authorized_source_path(
            &app,
            &label,
            &path,
            false,
            "SQLite preview path is not the active document.",
        )?;
        read_sqlite_preview_core(
            &authorized,
            selected_name.as_deref(),
            offset,
            limit,
            include_metadata,
            query_sql.as_deref(),
        )
    })
    .await
    .map_err(|error| error.to_string())?
}

async fn spawn_git_preview<T, F>(
    path: String,
    window: tauri::WebviewWindow,
    app: AppHandle,
    operation: F,
) -> Result<T, String>
where
    T: Send + 'static,
    F: FnOnce(&str) -> Result<T, String> + Send + 'static,
{
    access::require_viewer_or_main(&window)?;
    let label = window.label().to_owned();
    tauri::async_runtime::spawn_blocking(move || {
        let authorized = resolve_authorized_source_path(
            &app,
            &label,
            &path,
            true,
            "Git preview path is not authorized for this viewer.",
        )?;
        operation(&authorized.to_string_lossy())
    })
    .await
    .map_err(|error| error.to_string())?
}

#[tauri::command]
async fn read_git_history(
    path: String,
    head: Option<String>,
    offset: usize,
    window: tauri::WebviewWindow,
    app: AppHandle,
) -> Result<wasabipad_core::GitHistory, String> {
    spawn_git_preview(path, window, app, move |authorized| {
        wasabipad_core::read_git_history(authorized, head.as_deref(), offset)
    })
    .await
}

#[tauri::command]
async fn read_git_branches(
    path: String,
    window: tauri::WebviewWindow,
    app: AppHandle,
) -> Result<Vec<wasabipad_core::GitBranch>, String> {
    spawn_git_preview(path, window, app, wasabipad_core::read_git_branches).await
}

#[tauri::command]
async fn resolve_git_worktree_file(
    path: String,
    commit: String,
    file: String,
    window: tauri::WebviewWindow,
) -> Result<String, String> {
    access::require_main_window(&window)?;
    tauri::async_runtime::spawn_blocking(move || wasabipad_core::resolve_git_worktree_file(&path, &commit, &file))
        .await.map_err(|error| error.to_string())?
}

#[tauri::command]
async fn read_git_worktree_files(
    path: String,
    window: tauri::WebviewWindow,
    app: AppHandle,
) -> Result<Vec<wasabipad_core::GitChangedFile>, String> {
    spawn_git_preview(path, window, app, wasabipad_core::read_git_worktree_files).await
}

#[tauri::command]
async fn read_git_worktree_diff(
    path: String,
    file: String,
    window: tauri::WebviewWindow,
    app: AppHandle,
) -> Result<wasabipad_core::GitFileDiff, String> {
    spawn_git_preview(path, window, app, move |authorized| {
        wasabipad_core::read_git_worktree_diff(authorized, &file)
    })
    .await
}

#[tauri::command]
async fn read_git_files(
    path: String,
    commit: String,
    window: tauri::WebviewWindow,
    app: AppHandle,
) -> Result<Vec<wasabipad_core::GitChangedFile>, String> {
    spawn_git_preview(path, window, app, move |authorized| {
        wasabipad_core::read_git_files(authorized, &commit)
    })
    .await
}

#[tauri::command]
async fn read_git_diff(
    path: String,
    commit: String,
    file: String,
    window: tauri::WebviewWindow,
    app: AppHandle,
) -> Result<wasabipad_core::GitFileDiff, String> {
    spawn_git_preview(path, window, app, move |authorized| {
        wasabipad_core::read_git_diff(authorized, &commit, &file)
    })
    .await
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
            eprintln!("WasabiPadのインスタンス受付を初期化できないため転送無効で起動します: {error}");
            InstanceServer::disabled()
        }
    };
    let app = match tauri::Builder::default()
        .plugin(tauri_plugin_clipboard_manager::init())
        .plugin(tauri_plugin_dialog::init())
        .manage(Mutex::new(DocState(Doc::empty())))
        .manage(DocumentOpenGeneration::default())
        .manage(ViewerStore(Mutex::new(HashMap::new())))
        .manage(external_preview_runner::ExternalPreviewOperations::default())
        .manage(html_preview::HtmlPreviews::default())
        .manage(external_html_preview::ExternalHtmlPreviews::default())
        .manage(pdf_preview::PdfPreviews::default())
        .register_asynchronous_uri_scheme_protocol("wasabi-html", |context, request, responder| {
            let app = context.app_handle().clone();
            tauri::async_runtime::spawn_blocking(move || {
                responder.respond(app.state::<html_preview::HtmlPreviews>().serve(request));
            });
        })
        .register_asynchronous_uri_scheme_protocol("wasabi-ext", |context, request, responder| {
            let app = context.app_handle().clone();
            tauri::async_runtime::spawn_blocking(move || {
                responder.respond(
                    app.state::<external_html_preview::ExternalHtmlPreviews>()
                        .serve(request),
                );
            });
        })
        .register_asynchronous_uri_scheme_protocol("wasabi-pdf", |context, request, responder| {
            let app = context.app_handle().clone();
            tauri::async_runtime::spawn_blocking(move || {
                responder.respond(app.state::<pdf_preview::PdfPreviews>().serve(request));
            });
        })
        .manage(FindShortcutGuard::default())
        .manage(search::SearchCancel(Mutex::new(None)))
        .manage(instance_server)
        .on_window_event(|window, event| {
            if matches!(event, tauri::WindowEvent::Destroyed) {
                let label = window.label();
                let app = window.app_handle();
                app.state::<html_preview::HtmlPreviews>().remove_for_owner(label);
                app.state::<external_html_preview::ExternalHtmlPreviews>()
                    .remove_for_owner(label);
                app.state::<pdf_preview::PdfPreviews>().remove_for_owner(label);
                if access::is_main_window_label(label) {
                    let _ = app
                        .state::<external_preview_runner::ExternalPreviewOperations>()
                        .cleanup_all();
                }
            }
        })
        .setup(|app| {
            app.state::<InstanceServer>().start(app.handle());
            if let Some(window) = app.get_webview_window("main") {
                viewer::install_find_shortcut_guard(
                    &window,
                    app.state::<FindShortcutGuard>().0.clone(),
                );
            }
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            open_path,
            cancel_document_open,
            new_doc,
            close_doc,
            lines,
            line_char_len,
            select_entry,
            list_archive_entries,
            set_archive_password,
            list_folder_entries,
            folder_metadata,
            workspace_search,
            workspace_search_cancel,
            create_note,
            create_folder,
            rename_entry,
            move_entry,
            copy_entry,
            copy_entry_as,
            move_entry_as,
            delete_entry,
            delete_entry_without_backup,
            restore_deleted_entry,
            save_pasted_image,
            save_diagram_image,
            finish_diagram_assets,
            read_diagram_asset,
            apply_diagram_edit,
            cleanup_unused_images,
            read_archive_asset,
            read_file_asset,
            preview_cache_info,
            clear_preview_cache,
            reveal_in_explorer,
            open_in_other_app,
            open_in_default_browser,
            open_external_url,
            run_external_command,
            register_html_preview,
            release_html_preview,
            register_external_html_preview,
            release_external_html_preview,
            register_pdf_preview,
            release_pdf_preview,
            external_preview_resolve,
            external_preview_generate,
            external_preview_save,
            external_preview_cancel,
            external_preview_cleanup,
            external_preview_discard,
            external_preview_cleanup_all,
            external_preview_cleanup_stale,
            edit,
            edit_many,
            undo,
            redo,
            find,
            find_all_in_range,
            find_step,
            replace_all_chunk,
            replace_all_cancel,
            save_file,
            poll_external,
            reload_from_disk,
            ack_external,
            external_merge_preview,
            merge_external,
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
            set_inline_preview_focus,
            take_viewer_payload,
            update_viewer,
            close_viewer,
            probe_sqlite_preview,
            read_sqlite_preview,
            read_git_history,
            read_git_branches,
            resolve_git_worktree_file,
            read_git_worktree_files,
            read_git_worktree_diff,
            read_git_files,
            read_git_diff,
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
            app.state::<html_preview::HtmlPreviews>().clear();
            app.state::<external_html_preview::ExternalHtmlPreviews>().clear();
            app.state::<pdf_preview::PdfPreviews>().clear();
            let _ = app
                .state::<external_preview_runner::ExternalPreviewOperations>()
                .cleanup_all();
            app.state::<InstanceServer>().remove_endpoint();
        }
    });
}
