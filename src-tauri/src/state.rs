use std::sync::Mutex;
use wasabipad_core::Doc;

pub(crate) struct DocState(pub(crate) Doc);

// SAFETY: Doc is owned exclusively here and every access goes through the
// Mutex-backed Tauri State. HugeBuf pointers never escape a locked operation.
unsafe impl Send for DocState {}

pub(crate) type State<'a> = tauri::State<'a, Mutex<DocState>>;

pub(crate) fn with_doc<R>(state: &State<'_>, operation: impl FnOnce(&mut Doc) -> R) -> R {
    let mut guard = match state.lock() {
        Ok(guard) => guard,
        Err(poisoned) => {
            // 未保存本文を空文書へ置換すると、ロック毒化より危険なデータ消失になる。
            // poison は以後の呼び出し側で扱えるよう、既存状態を保持して再開する。
            eprintln!("文書状態のロックが壊れたため、既存状態を保持して復旧します");
            poisoned.into_inner()
        }
    };
    operation(&mut guard.0)
}
