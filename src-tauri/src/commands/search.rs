use std::sync::{
    atomic::{AtomicBool, Ordering},
    Arc, Mutex,
};

use tauri::Emitter;
use wasabipad_core::{SearchOptions, WorkspaceSearchOutcome};

use crate::state::{with_doc, State};
use crate::{WorkspaceSearchBatch, EVENT_WORKSPACE_SEARCH_BATCH};

pub(crate) struct SearchCancel(pub(crate) Mutex<Arc<AtomicBool>>);

fn take_over_search(cancel: &tauri::State<'_, SearchCancel>) -> Result<Arc<AtomicBool>, String> {
    let flag = Arc::new(AtomicBool::new(false));
    let mut slot = cancel
        .0
        .lock()
        .map_err(|_| "検索を開始できません".to_string())?;
    slot.store(true, Ordering::Relaxed);
    *slot = flag.clone();
    Ok(flag)
}

pub(crate) async fn workspace_search(
    pat: String,
    options: SearchOptions,
    search_id: u32,
    app: tauri::AppHandle,
    state: State<'_>,
    cancel: tauri::State<'_, SearchCancel>,
) -> Result<WorkspaceSearchOutcome, String> {
    let root = with_doc(&state, |doc| doc.workspace_root())
        .ok_or_else(|| "folder is not open".to_string())?;
    let flag = take_over_search(&cancel)?;
    tauri::async_runtime::spawn_blocking(move || {
        let emit = |results| {
            let _ = app.emit(
                EVENT_WORKSPACE_SEARCH_BATCH,
                WorkspaceSearchBatch { search_id, results },
            );
        };
        wasabipad_core::search_workspace(&root, &pat, &options, &flag, &emit)
    })
    .await
    .map_err(|error| error.to_string())
}

pub(crate) fn workspace_search_cancel(
    cancel: tauri::State<'_, SearchCancel>,
) -> Result<(), String> {
    take_over_search(&cancel).map(|_| ())
}
