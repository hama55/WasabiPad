export interface AsyncUnlisten {
  set(unlisten: () => void): void;
  dispose(): void;
}

export function createAsyncUnlisten(): AsyncUnlisten {
  let disposed = false;
  let unlisten: (() => void) | null = null;

  const safelyUnlisten = (listener: (() => void) | null) => {
    try {
      listener?.();
    } catch (error) {
      console.error("イベント購読の解除に失敗しました", error);
    }
  };

  return {
    set(next) {
      if (disposed) {
        safelyUnlisten(next);
        return;
      }
      const previous = unlisten;
      unlisten = null;
      safelyUnlisten(previous);
      unlisten = next;
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      const current = unlisten;
      unlisten = null;
      safelyUnlisten(current);
    },
  };
}
