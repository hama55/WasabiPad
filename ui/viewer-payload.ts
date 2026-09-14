import type { ViewerPayload, ViewerSelection } from "./api";
import { isViewerFormat } from "./viewer-formats";

function isPosition(value: unknown): value is { line: number; col: number } {
  if (typeof value !== "object" || value === null) return false;
  const position = value as { line?: unknown; col?: unknown };
  return Number.isInteger(position.line) && Number.isInteger(position.col)
    && (position.line as number) >= 0 && (position.col as number) >= 0;
}

export function isViewerSelection(value: unknown): value is ViewerSelection {
  if (typeof value !== "object" || value === null) return false;
  const selection = value as { start?: unknown; end?: unknown };
  return isPosition(selection.start) && isPosition(selection.end);
}

function isNullableString(value: unknown): value is string | null {
  return value === null || typeof value === "string";
}

export function isViewerPayload(value: unknown): value is ViewerPayload {
  if (typeof value !== "object" || value === null) return false;
  const payload = value as Partial<ViewerPayload>;
  return isViewerFormat(payload.format)
    && typeof payload.text === "string"
    && (payload.selection === null || isViewerSelection(payload.selection))
    && isNullableString(payload.source_path)
    && isNullableString(payload.effective_extension)
    && isNullableString(payload.archive_path)
    && isNullableString(payload.archive_entry);
}
