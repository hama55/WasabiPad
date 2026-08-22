use std::path::PathBuf;
use tauri::{AppHandle, Emitter};

use wasabipad_core::{
    Doc, DocInfo, EditManyItem, EditManyResult, EditResult, EncodingId, Eol, ExternalCheck,
    ExternalMergePreview, FindCursor, FindOutcome, FindResult, FolderEntry, PosC,
    ReplaceChunkResult, SaveOutcome,
};

use crate::state::{with_doc, State};

const EXTERNAL_MERGE_RETRY_CODE: &str = "external_merge_retry";

#[derive(Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct DocumentLoadProgress {
    loaded: u64,
    total: u64,
    percent: u8,
}

pub(crate) fn open_path(path: String, state: State, app: AppHandle) -> Result<DocInfo, String> {
    let mut report = |loaded: u64, total: u64| {
        let percent = if total == 0 {
            100
        } else {
            loaded.saturating_mul(100).saturating_div(total).min(100) as u8
        };
        if let Err(error) = app.emit(
            crate::EVENT_DOCUMENT_LOAD_PROGRESS,
            DocumentLoadProgress { loaded, total, percent },
        ) {
            eprintln!("文書読み込み進捗の通知に失敗しました: {error}");
        }
    };
    let d = Doc::open_with_progress(&PathBuf::from(&path), Some(&mut report))
        .map_err(|e| e.to_string())?;
    // フォルダを開いた場合 d.path は先頭の実ファイルを指す (フォルダ自体は保存先を持たない)
    let info_path = d
        .path()
        .map(|p| p.to_string_lossy().into_owned())
        .unwrap_or(path);
    let info = d.info(info_path).map_err(|error| error.to_string())?;
    with_doc(&state, |doc| *doc = d)?;
    Ok(info)
}

pub(crate) fn new_doc(state: State) -> Result<(), String> {
    with_doc(&state, |doc| *doc = Doc::empty())
}

pub(crate) fn close_doc(state: State) -> Result<(), String> {
    with_doc(&state, |doc| *doc = Doc::empty()) // mmap解放 (ファイルロック解除)
}

pub(crate) fn lines(start: usize, count: usize, state: State) -> Result<Vec<String>, String> {
    with_doc(&state, |doc| doc.lines(start, count))
}

pub(crate) fn line_char_len(line: usize, state: State) -> Result<usize, String> {
    with_doc(&state, |doc| doc.line_char_len(line))
}

pub(crate) fn select_entry(rel_path: String, state: State) -> Result<DocInfo, String> {
    let result = with_doc(&state, |doc| doc.select_entry(&rel_path))?;
    result
        .map_err(|error| error.to_string())?
        .ok_or_else(|| "no entry".into())
}

pub(crate) fn list_archive_entries(rel_path: String, state: State) -> Result<Vec<String>, String> {
    let result = with_doc(&state, |doc| doc.list_archive_entries(&rel_path))?;
    result
        .map_err(|error| error.to_string())?
        .ok_or_else(|| "no entries".into())
}

pub(crate) fn set_archive_password(
    rel_path: String,
    password: String,
    state: State,
) -> Result<(), String> {
    with_doc(&state, |doc| doc.set_archive_password(&rel_path, &password))?
        .map_err(|error| error.to_string())
}

pub(crate) fn list_folder_entries(
    rel_dir: String,
    state: State,
) -> Result<Vec<FolderEntry>, String> {
    let result = with_doc(&state, |doc| doc.list_folder_entries(&rel_dir))?;
    result
        .map_err(|error| error.to_string())?
        .ok_or_else(|| "no entries".into())
}

pub(crate) fn create_note(
    dir: Option<String>,
    name: String,
    enc: EncodingId,
    eol: Eol,
    state: State,
) -> Result<DocInfo, String> {
    with_doc(&state, |doc| doc.create_note(dir.as_deref(), &name, enc.into(), eol))?
        .map_err(|e| e.to_string())
}

pub(crate) fn create_folder(rel_dir: String, name: String, state: State) -> Result<(), String> {
    with_doc(&state, |doc| doc.create_folder(&rel_dir, &name))?
        .map_err(|e| e.to_string())
}

pub(crate) fn rename_entry(
    rel_path: String,
    new_name: String,
    state: State,
) -> Result<DocInfo, String> {
    with_doc(&state, |doc| doc.rename_entry(&rel_path, &new_name))?
        .map_err(|e| e.to_string())
}

pub(crate) fn move_entry(
    source_rel_path: String,
    target_rel_dir: String,
    state: State,
) -> Result<DocInfo, String> {
    with_doc(&state, |doc| doc.move_entry(&source_rel_path, &target_rel_dir))?
        .map_err(|e| e.to_string())
}

pub(crate) fn delete_entry(rel_path: String, state: State) -> Result<DocInfo, String> {
    with_doc(&state, |doc| doc.delete_entry(&rel_path))?
        .map_err(|e| e.to_string())
}

pub(crate) fn save_pasted_image(
    bytes: Vec<u8>,
    mime_type: String,
    state: State,
) -> Result<String, String> {
    with_doc(&state, |doc| doc.save_pasted_image(&bytes, &mime_type))?
        .map_err(|e| e.to_string())
}

pub(crate) fn cleanup_unused_images(path: String, state: State) -> Result<(), String> {
    let requested = PathBuf::from(path);
    with_doc(&state, |doc| {
        if doc.display_path() != Some(requested.as_path()) {
            return Ok(());
        }
        doc.cleanup_unused_images()
    })
    ?
    .map_err(|e| e.to_string())
}

pub(crate) fn edit(
    start: PosC,
    end: PosC,
    caret_before: PosC,
    text: String,
    coalesce: bool,
    state: State,
) -> Result<EditResult, String> {
    with_doc(&state, |doc| {
        doc.edit(start, end, caret_before, &text, coalesce)
    })
    ?
    .ok_or_else(|| "閲覧専用の文書は編集できません".to_string())
}

pub(crate) fn edit_many(
    edits: Vec<EditManyItem>,
    caret_before: PosC,
    primary_index: usize,
    state: State,
) -> Result<EditManyResult, String> {
    with_doc(&state, |doc| {
        doc.edit_many(edits, caret_before, primary_index)
    })
    ?
    .ok_or_else(|| "閲覧専用の文書は編集できません".to_string())
}

pub(crate) fn undo(state: State) -> Result<Option<EditResult>, String> {
    with_doc(&state, Doc::undo)
}

pub(crate) fn redo(state: State) -> Result<Option<EditResult>, String> {
    with_doc(&state, Doc::redo)
}

pub(crate) fn find(
    pat: String,
    from: PosC,
    forward: bool,
    match_case: bool,
    state: State,
) -> Result<Option<FindResult>, String> {
    with_doc(&state, |doc| doc.find(&pat, from, forward, match_case))
}

pub(crate) fn find_all_in_range(
    pat: String,
    first_line: usize,
    last_line: usize,
    match_case: bool,
    use_regex: bool,
    whole_word: bool,
    state: State,
) -> Result<Vec<FindResult>, String> {
    with_doc(&state, |doc| {
        doc.find_all_in_range(&pat, first_line, last_line, match_case, use_regex, whole_word)
    })?
}

pub(crate) fn find_step(
    pat: String,
    from: PosC,
    match_case: bool,
    cursor: Option<FindCursor>,
    budget: usize,
    state: State,
) -> Result<FindOutcome, String> {
    with_doc(&state, |doc| {
        doc.find_step(&pat, from, match_case, cursor, budget)
    })
}

pub(crate) fn replace_all_chunk(
    pat: String,
    rep: String,
    match_case: bool,
    budget: usize,
    state: State,
) -> Result<ReplaceChunkResult, String> {
    with_doc(&state, |doc| {
        doc.replace_all_chunk(&pat, &rep, match_case, budget)
    })
}

pub(crate) fn replace_all_cancel(state: State) -> Result<EditResult, String> {
    with_doc(&state, Doc::replace_all_cancel)
}

pub(crate) fn save_file(
    path: String,
    enc: EncodingId,
    eol: Eol,
    state: State,
) -> Result<SaveOutcome, String> {
    with_doc(&state, |doc| {
        doc.save(&PathBuf::from(path), enc.into(), eol)
    })
    ?
    .map_err(|e| e.to_string())
}

pub(crate) fn poll_external(dirty: bool, state: State) -> Result<ExternalCheck, String> {
    with_doc(&state, |doc| doc.poll_external(dirty))
}

pub(crate) fn reload_from_disk(state: State) -> Result<DocInfo, String> {
    with_doc(&state, |doc| doc.reload_from_disk())?
        .map_err(|e| e.to_string())
}

pub(crate) fn ack_external(state: State) -> Result<DocInfo, String> {
    with_doc(&state, Doc::ack_external)?
        .map_err(|error| error.to_string())
}

pub(crate) fn external_merge_preview(state: State) -> Result<ExternalMergePreview, String> {
    with_doc(&state, |doc| doc.external_merge_preview()).map_err(|error| error.to_string())?
        .map_err(|error| error.to_string())
}

pub(crate) fn merge_external(state: State) -> Result<DocInfo, String> {
    with_doc(&state, |doc| doc.merge_external()).map_err(|error| error.to_string())?
        .map_err(|error| {
            if error.kind() == std::io::ErrorKind::WouldBlock {
                EXTERNAL_MERGE_RETRY_CODE.to_string()
            } else {
                error.to_string()
            }
        })
}

pub(crate) fn set_encoding(enc: EncodingId, state: State) -> Result<(), String> {
    with_doc(&state, |doc| doc.set_enc(enc.into()))
}

pub(crate) fn set_eol(eol: Eol, state: State) -> Result<(), String> {
    with_doc(&state, |doc| doc.set_eol(eol))
}

pub(crate) fn reload_with_encoding(enc: EncodingId, state: State) -> Result<DocInfo, String> {
    with_doc(&state, |doc| doc.reload_with_encoding(enc.into()))?
        .map_err(|e| e.to_string())
}

pub(crate) fn read_archive_asset(
    archive_path: String,
    entry: String,
    state: State,
) -> Result<Vec<u8>, String> {
    let archive = PathBuf::from(archive_path);
    with_doc(&state, |doc| doc.read_archive_asset(&archive, &entry))?
        .map_err(|error| error.to_string())
}
