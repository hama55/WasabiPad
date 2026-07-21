use petapad_core::Doc;
use std::sync::Mutex;

pub(crate) struct DocState(pub(crate) Doc);

// SAFETY: Doc is owned exclusively here and every access goes through the
// Mutex-backed Tauri State. HugeBuf pointers never escape a locked operation.
unsafe impl Send for DocState {}

pub(crate) type State<'a> = tauri::State<'a, Mutex<DocState>>;

pub(crate) fn with_doc<R>(state: &State<'_>, operation: impl FnOnce(&mut Doc) -> R) -> R {
    let mut guard = state.lock().unwrap();
    operation(&mut guard.0)
}
