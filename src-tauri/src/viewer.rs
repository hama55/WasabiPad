use std::collections::HashMap;
use std::sync::{
    atomic::{AtomicU64, Ordering},
    Mutex,
};

use tauri::{AppHandle, Emitter, Manager, WebviewUrl, WebviewWindowBuilder};

use crate::state::{with_doc, State};
use crate::{ViewerFormat, ViewerPayload, ViewerSelection, EVENT_VIEWER_UPDATE};

pub(crate) struct ViewerStore(pub(crate) Mutex<HashMap<String, ViewerPayload>>);

static VIEWER_ID: AtomicU64 = AtomicU64::new(1);

fn next_viewer_payload(
    current: &ViewerPayload,
    text: String,
    selection: Option<ViewerSelection>,
) -> ViewerPayload {
    let mut next = current.clone();
    next.text = text;
    next.selection = selection;
    next
}

pub(crate) async fn open_viewer(
    format: ViewerFormat,
    text: String,
    selection: Option<ViewerSelection>,
    source_path: Option<String>,
    app: AppHandle,
    doc_state: State<'_>,
    state: tauri::State<'_, ViewerStore>,
) -> Result<String, String> {
    // 形式名入りのタイトルは payload 受信後にフロントが設定する。ここは生成時の暫定表示。
    let title = app.package_info().name.clone();
    let label = crate::viewer_label(VIEWER_ID.fetch_add(1, Ordering::Relaxed));
    let archive_source = with_doc(&doc_state, |doc| doc.viewer_source())?;
    state
        .0
        .lock()
        .map_err(|_| "ビューの準備に失敗しました".to_string())?
        .insert(
            label.clone(),
            ViewerPayload {
                format,
                text,
                selection,
                source_path,
                archive_path: archive_source
                    .as_ref()
                    .map(|(path, _)| path.to_string_lossy().into_owned()),
                archive_entry: archive_source.map(|(_, entry)| entry),
            },
        );

    let window =
        match WebviewWindowBuilder::new(&app, &label, WebviewUrl::App("viewer.html".into()))
            .title(title)
            .decorations(false)
            .inner_size(960.0, 700.0)
            .visible(false)
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

pub(crate) fn take_viewer_payload(
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

pub(crate) fn update_viewer(
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
        let payloads = state
            .0
            .lock()
            .map_err(|_| "ビューの更新に失敗しました".to_string())?;
        let Some(current) = payloads.get(&label) else {
            return Ok(false);
        };
        next_viewer_payload(current, text, selection)
    };
    window
        .emit(EVENT_VIEWER_UPDATE, &payload)
        .map_err(|e| e.to_string())?;
    if let Some(current) = state
        .0
        .lock()
        .map_err(|_| "ビューの更新に失敗しました".to_string())?
        .get_mut(&label)
    {
        *current = payload;
    }
    Ok(true)
}

pub(crate) fn close_viewer(
    label: String,
    app: AppHandle,
    state: tauri::State<'_, ViewerStore>,
) -> Result<(), String> {
    if let Some(window) = app.get_webview_window(&label) {
        window.close().map_err(|error| error.to_string())?;
    }
    state
        .0
        .lock()
        .map_err(|_| "ビューの終了処理に失敗しました".to_string())?
        .remove(&label);
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::{next_viewer_payload, ViewerFormat, ViewerPayload};

    // Feature: Viewer payloadの更新候補
    // Scenario: 表示本文と選択だけを更新する
    // Given: 形式・資産パスを含む既存payload
    // When: 新しい本文と選択で更新候補を作る
    // Then: 本文と選択だけが変わり、emit失敗前の既存payloadは変更されない
    #[test]
    fn builds_a_candidate_without_mutating_the_current_payload() {
        let current = ViewerPayload {
            format: ViewerFormat::Html,
            text: "old".to_string(),
            selection: None,
            source_path: Some("C:\\work\\index.html".to_string()),
            archive_path: None,
            archive_entry: None,
        };

        let next = next_viewer_payload(&current, "new".to_string(), None);

        assert_eq!(current.text, "old");
        assert_eq!(next.text, "new");
        assert_eq!(next.source_path, current.source_path);
        assert!(matches!(next.format, ViewerFormat::Html));
    }
}
