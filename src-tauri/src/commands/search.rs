use std::sync::{
    atomic::{AtomicBool, Ordering},
    Arc, Mutex,
};

use tauri::Emitter;
use wasabipad_core::{SearchOptions, WorkspaceSearchOutcome};

use crate::state::{with_doc, State};
use crate::{WorkspaceSearchBatch, EVENT_WORKSPACE_SEARCH_BATCH};

pub(crate) struct SearchCancel(pub(crate) Mutex<Option<(u32, Arc<AtomicBool>)>>);

fn take_over_search(
    cancel: &tauri::State<'_, SearchCancel>,
    search_id: u32,
) -> Result<Arc<AtomicBool>, String> {
    let flag = Arc::new(AtomicBool::new(false));
    let mut slot = cancel
        .0
        .lock()
        .map_err(|_| "検索を開始できません".to_string())?;
    if let Some((_, previous)) = slot.replace((search_id, flag.clone())) {
        previous.store(true, Ordering::Relaxed);
    }
    Ok(flag)
}

fn clear_search(cancel: &tauri::State<'_, SearchCancel>, search_id: u32) {
    let Ok(mut slot) = cancel.0.lock() else {
        return;
    };
    if slot
        .as_ref()
        .is_some_and(|(active_id, _)| *active_id == search_id)
    {
        *slot = None;
    }
}

pub(crate) async fn workspace_search(
    pat: String,
    options: SearchOptions,
    search_id: u32,
    app: tauri::AppHandle,
    state: State<'_>,
    cancel: tauri::State<'_, SearchCancel>,
) -> Result<WorkspaceSearchOutcome, String> {
    let root = with_doc(&state, |doc| doc.workspace_root())?
        .ok_or_else(|| "folder is not open".to_string())?;
    let flag = take_over_search(&cancel, search_id)?;
    let result = tauri::async_runtime::spawn_blocking(move || {
        let emit_flag = Arc::clone(&flag);
        let emit = |results| {
            if app
                .emit(
                    EVENT_WORKSPACE_SEARCH_BATCH,
                    WorkspaceSearchBatch { search_id, results },
                )
                .is_err()
            {
                // WebViewが閉じた後も走査を続けると、結果を誰にも届けられない。
                emit_flag.store(true, Ordering::Relaxed);
            }
        };
        wasabipad_core::search_workspace(&root, &pat, &options, &flag, &emit)
    })
    .await
    .map_err(|error| error.to_string());
    clear_search(&cancel, search_id);
    result
}

pub(crate) fn workspace_search_cancel(
    search_id: u32,
    cancel: tauri::State<'_, SearchCancel>,
) -> Result<(), String> {
    let slot = cancel
        .0
        .lock()
        .map_err(|_| "検索を中止できません".to_string())?;
    if let Some((active_id, flag)) = slot.as_ref() {
        if *active_id == search_id {
            flag.store(true, Ordering::Relaxed);
        }
    }
    Ok(())
}
