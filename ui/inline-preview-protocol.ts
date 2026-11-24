export const INLINE_PREVIEW_MESSAGES = {
  READY_MESSAGE: "wasabipad-viewer-ready",
  PREVIEW_STATUS_MESSAGE: "wasabipad-viewer-external-status",
  PAYLOAD_MESSAGE: "wasabipad-viewer-payload",
  // Confirms viewer DOM commit only; external iframe load does not certify HTML semantics.
  DISPLAY_COMMITTED_MESSAGE: "wasabipad-viewer-display-committed",
  DISPLAY_FAILED_MESSAGE: "wasabipad-viewer-display-failed",
  CLEAR_MESSAGE: "wasabipad-viewer-clear",
  CLEARED_MESSAGE: "wasabipad-viewer-cleared",
  FORMAT_CHANGE_MESSAGE: "wasabipad-viewer-format-change",
  HTML_MODE_CHANGE_MESSAGE: "wasabipad-viewer-html-mode-change",
  DELIMITER_MESSAGE: "wasabipad-viewer-delimiter",
  DELIMITER_CHANGE_MESSAGE: "wasabipad-viewer-delimiter-change",
  OPEN_DELIMITER_MESSAGE: "wasabipad-viewer-open-delimiter",
  CSV_EDIT_MESSAGE: "wasabipad-viewer-csv-edit",
  CSV_EDIT_STATE_MESSAGE: "wasabipad-viewer-csv-edit-state",
  CSV_SAVE_MESSAGE: "wasabipad-viewer-csv-save",
  FONT_MESSAGE: "wasabipad-viewer-font",
  FONT_SIZE_MESSAGE: "wasabipad-viewer-font-size",
  MARKDOWN_SOFT_BREAKS_MESSAGE: "wasabipad-viewer-markdown-soft-breaks",
  MARKDOWN_LINE_HEIGHT_MESSAGE: "wasabipad-viewer-markdown-line-height",
  MARKDOWN_HEADING_UNDERLINES_MESSAGE: "wasabipad-viewer-markdown-heading-underlines",
  FONT_CHANGE_MESSAGE: "wasabipad-viewer-font-change",
  FULLSCREEN_CHANGE_MESSAGE: "wasabipad-viewer-fullscreen-change",
  FULLSCREEN_STATE_MESSAGE: "wasabipad-viewer-fullscreen-state",
  VISIBILITY_MESSAGE: "wasabipad-viewer-visibility",
  CLOSE_MESSAGE: "wasabipad-viewer-close",
  REFRESH_MESSAGE: "wasabipad-viewer-refresh",
  OUTPUT_FOLDER_STATE_MESSAGE: "wasabipad-viewer-output-folder-state",
  REVEAL_OUTPUT_MESSAGE: "wasabipad-viewer-reveal-output",
  EXTERNAL_SAVE_STATE_MESSAGE: "wasabipad-viewer-external-save-state",
  SAVE_EXTERNAL_PREVIEW_MESSAGE: "wasabipad-viewer-save-external-preview",
  GIT_OPEN_FILE_MESSAGE: "wasabipad-viewer-git-open-file",
  FOCUS_CLOSE_MESSAGE: "wasabipad-viewer-focus-close",
  SELECTION_CHANGE_MESSAGE: "wasabipad-viewer-selection-change",
  MARKDOWN_LINK_MESSAGE: "wasabipad-viewer-markdown-link",
  MARKDOWN_FRAGMENT_MESSAGE: "wasabipad-viewer-markdown-fragment",
} as const;

import type { ExternalPreviewSourceKind } from "./generated/ExternalPreviewSourceKind";

export type ExternalPreviewHeaderSourceKind = ExternalPreviewSourceKind;

export interface PreviewStatus {
  message: string;
  busy: boolean;
  kind?: "standard" | "external";
  error?: boolean;
}
