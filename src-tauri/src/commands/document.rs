use std::path::PathBuf;

use wasabipad_core::{
    Doc, DocInfo, EditManyItem, EditManyResult, EditResult, EncodingId, Eol, ExternalCheck,
    FindCursor, FindOutcome, FindResult, FolderEntry, PosC, ReplaceChunkResult, SaveOutcome,
};

use crate::state::{with_doc, State};

pub(crate) fn open_path(path: String, state: State) -> Result<DocInfo, String> {
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

pub(crate) fn new_doc(state: State) {
    with_doc(&state, |doc| *doc = Doc::empty());
}

pub(crate) fn close_doc(state: State) {
    with_doc(&state, |doc| *doc = Doc::empty()); // mmap解放 (ファイルロック解除)
}

pub(crate) fn lines(start: usize, count: usize, state: State) -> Vec<String> {
    with_doc(&state, |doc| doc.lines(start, count))
}

pub(crate) fn line_char_len(line: usize, state: State) -> usize {
    with_doc(&state, |doc| doc.line_char_len(line))
}

pub(crate) fn select_entry(rel_path: String, state: State) -> Result<DocInfo, String> {
    with_doc(&state, |doc| doc.select_entry(&rel_path))
        .map_err(|error| error.to_string())?
        .ok_or_else(|| "no entry".into())
}

pub(crate) fn list_archive_entries(rel_path: String, state: State) -> Result<Vec<String>, String> {
    with_doc(&state, |doc| doc.list_archive_entries(&rel_path))
        .map_err(|error| error.to_string())?
        .ok_or_else(|| "no entries".into())
}

pub(crate) fn set_archive_password(
    rel_path: String,
    password: String,
    state: State,
) -> Result<(), String> {
    with_doc(&state, |doc| doc.set_archive_password(&rel_path, &password))
        .map_err(|error| error.to_string())
}

pub(crate) fn list_folder_entries(
    rel_dir: String,
    state: State,
) -> Result<Vec<FolderEntry>, String> {
    with_doc(&state, |doc| doc.list_folder_entries(&rel_dir))
        .map_err(|error| error.to_string())?
        .ok_or_else(|| "no entries".into())
}

pub(crate) fn create_note(
    dir: Option<String>,
    name: String,
    state: State,
) -> Result<DocInfo, String> {
    with_doc(&state, |doc| doc.create_note(dir.as_deref(), &name)).map_err(|e| e.to_string())
}

pub(crate) fn rename_entry(
    rel_path: String,
    new_name: String,
    state: State,
) -> Result<DocInfo, String> {
    with_doc(&state, |doc| doc.rename_entry(&rel_path, &new_name)).map_err(|e| e.to_string())
}

pub(crate) fn delete_entry(rel_path: String, state: State) -> Result<DocInfo, String> {
    with_doc(&state, |doc| doc.delete_entry(&rel_path)).map_err(|e| e.to_string())
}

pub(crate) fn save_pasted_image(
    bytes: Vec<u8>,
    mime_type: String,
    state: State,
) -> Result<String, String> {
    with_doc(&state, |doc| doc.save_pasted_image(&bytes, &mime_type)).map_err(|e| e.to_string())
}

pub(crate) fn cleanup_unused_images(path: String, state: State) -> Result<(), String> {
    let requested = PathBuf::from(path);
    with_doc(&state, |doc| {
        if doc.display_path() != Some(requested.as_path()) {
            return Ok(());
        }
        doc.cleanup_unused_images()
    })
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
    .ok_or_else(|| "閲覧専用の文書は編集できません".to_string())
}

pub(crate) fn undo(state: State) -> Option<EditResult> {
    with_doc(&state, Doc::undo)
}

pub(crate) fn redo(state: State) -> Option<EditResult> {
    with_doc(&state, Doc::redo)
}

pub(crate) fn find(
    pat: String,
    from: PosC,
    forward: bool,
    match_case: bool,
    state: State,
) -> Option<FindResult> {
    with_doc(&state, |doc| doc.find(&pat, from, forward, match_case))
}

pub(crate) fn find_step(
    pat: String,
    from: PosC,
    match_case: bool,
    cursor: Option<FindCursor>,
    budget: usize,
    state: State,
) -> FindOutcome {
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
) -> ReplaceChunkResult {
    with_doc(&state, |doc| {
        doc.replace_all_chunk(&pat, &rep, match_case, budget)
    })
}

pub(crate) fn replace_all_cancel(state: State) -> EditResult {
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
    .map_err(|e| e.to_string())
}

pub(crate) fn poll_external(dirty: bool, state: State) -> ExternalCheck {
    with_doc(&state, |doc| doc.poll_external(dirty))
}

pub(crate) fn reload_from_disk(state: State) -> Result<DocInfo, String> {
    with_doc(&state, |doc| doc.reload_from_disk()).map_err(|e| e.to_string())
}

pub(crate) fn ack_external(state: State) {
    with_doc(&state, Doc::ack_external);
}

pub(crate) fn set_encoding(enc: EncodingId, state: State) {
    with_doc(&state, |doc| doc.set_enc(enc.into()));
}

pub(crate) fn set_eol(eol: Eol, state: State) {
    with_doc(&state, |doc| doc.set_eol(eol));
}

pub(crate) fn reload_with_encoding(enc: EncodingId, state: State) -> Result<DocInfo, String> {
    with_doc(&state, |doc| doc.reload_with_encoding(enc.into())).map_err(|e| e.to_string())
}

pub(crate) fn read_archive_asset(
    archive_path: String,
    entry: String,
    state: State,
) -> Result<Vec<u8>, String> {
    let archive = PathBuf::from(archive_path);
    with_doc(&state, |doc| doc.read_archive_asset(&archive, &entry))
        .map_err(|error| error.to_string())
}
