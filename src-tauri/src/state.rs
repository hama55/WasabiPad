use std::sync::{atomic::{AtomicU64, Ordering}, Mutex, MutexGuard};
use wasabipad_core::Doc;

pub(crate) struct DocState(pub(crate) Doc);

const _: fn() = || {
    fn assert_send<T: Send>() {}
    assert_send::<DocState>();
};

pub(crate) type State<'a> = tauri::State<'a, Mutex<DocState>>;

#[derive(Default)]
pub(crate) struct DocumentOpenGeneration(AtomicU64);

impl DocumentOpenGeneration {
    pub(crate) fn advance(&self) -> u64 {
        self.0.fetch_add(1, Ordering::SeqCst) + 1
    }

    pub(crate) fn is_current(&self, generation: u64) -> bool {
        self.0.load(Ordering::SeqCst) == generation
    }
}

fn lock_doc(state: &Mutex<DocState>) -> Result<MutexGuard<'_, DocState>, String> {
    state
        .lock()
        .map_err(|_| "文書状態のロックが壊れているため操作できません".to_string())
}

pub(crate) fn with_doc<R>(state: &State<'_>, operation: impl FnOnce(&mut Doc) -> R) -> Result<R, String> {
    let mut guard = lock_doc(state)?;
    Ok(operation(&mut guard.0))
}

#[cfg(test)]
mod tests {
    use super::{lock_doc, DocState};
    use wasabipad_core::Doc;
    use std::sync::Mutex;

    // Feature: 文書状態Mutexのエラー境界
    // Scenario: 文書状態のMutexがpoisonされている
    // Given: ロック保持中の処理がpanicしている
    // When: 次の処理が文書状態を取得する
    // Then: 壊れた状態を成功扱いせずエラーを返す
    #[test]
    fn poisoned_doc_lock_is_reported_as_error() {
        let state = Mutex::new(DocState(Doc::empty()));
        let _ = std::panic::catch_unwind(|| {
            let _guard = state.lock().unwrap();
            panic!("test poison");
        });

        assert!(lock_doc(&state).is_err());
    }
}
