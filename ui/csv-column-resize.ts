import { resizedCsvColumnWidth } from "./csv-viewer";

export interface CsvColumnResizeOptions {
  startWidth: number;
  startX: number;
  update: (width: number) => void;
  setResizing?: (active: boolean) => void;
  onError?: (error: unknown) => void;
}

export function startCsvColumnResize(event: PointerEvent, options: CsvColumnResizeOptions): boolean {
  if (event.button !== 0) return false;
  event.preventDefault();
  event.stopPropagation();

  const reportError = (error: unknown) => {
    try {
      options.onError?.(error);
    } catch {
      // エラー表示側の失敗で、ドラッグイベントへ例外を戻さない。
    }
  };
  let finished = false;
  const finish = () => {
    if (finished) return;
    finished = true;
    window.removeEventListener("pointermove", onMove);
    window.removeEventListener("pointerup", finish);
    window.removeEventListener("pointercancel", finish);
    window.removeEventListener("blur", finish);
    document.removeEventListener("visibilitychange", onVisibilityChange);
    try {
      options.setResizing?.(false);
    } catch (error) {
      reportError(error);
    }
  };
  const onMove = (move: PointerEvent) => {
    try {
      options.update(resizedCsvColumnWidth(options.startWidth, move.clientX - options.startX));
    } catch (error) {
      finish();
      reportError(error);
    }
  };
  const onVisibilityChange = () => {
    if (document.hidden) finish();
  };

  try {
    options.setResizing?.(true);
  } catch (error) {
    reportError(error);
    return false;
  }
  window.addEventListener("pointermove", onMove);
  window.addEventListener("pointerup", finish);
  window.addEventListener("pointercancel", finish);
  window.addEventListener("blur", finish);
  document.addEventListener("visibilitychange", onVisibilityChange);
  return true;
}
