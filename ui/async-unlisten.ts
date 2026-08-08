export interface AsyncUnlisten {
  set(unlisten: () => void): void;
  dispose(): void;
}

export function createAsyncUnlisten(): AsyncUnlisten {
  let disposed = false;
  let unlisten: (() => void) | null = null;

  return {
    set(next) {
      if (disposed) {
        next();
        return;
      }
      unlisten?.();
      unlisten = next;
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      unlisten?.();
      unlisten = null;
    },
  };
}
