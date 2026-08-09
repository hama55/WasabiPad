export interface DocumentLoadProgress {
  loaded: number;
  total: number;
  percent: number;
}

export const DOCUMENT_LOAD_PROGRESS_EVENT = "document-load-progress";

export function documentLoadProgressMessage(progress: Pick<DocumentLoadProgress, "percent">): string {
  const percent = Math.max(0, Math.min(100, Math.round(progress.percent)));
  return `読み込み中… ${percent}%`;
}

export function applyDocumentLoadProgress(
  loading: HTMLElement,
  message: HTMLElement,
  progress: Pick<DocumentLoadProgress, "percent">,
): boolean {
  if (loading.hidden) return false;
  message.textContent = documentLoadProgressMessage(progress);
  return true;
}
