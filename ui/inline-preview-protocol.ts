export const INLINE_PREVIEW_MESSAGES = {
  READY_MESSAGE: "wasabipad-viewer-ready",
  EXTERNAL_STATUS_MESSAGE: "wasabipad-viewer-external-status",
  PAYLOAD_MESSAGE: "wasabipad-viewer-payload",
  // Confirms viewer DOM commit only; external iframe load does not certify HTML semantics.
  DISPLAY_COMMITTED_MESSAGE: "wasabipad-viewer-display-committed",
  DISPLAY_FAILED_MESSAGE: "wasabipad-viewer-display-failed",
  CLEAR_MESSAGE: "wasabipad-viewer-clear",
  CLEARED_MESSAGE: "wasabipad-viewer-cleared",
  FORMAT_CHANGE_MESSAGE: "wasabipad-viewer-format-change",
  DELIMITER_MESSAGE: "wasabipad-viewer-delimiter",
  DELIMITER_CHANGE_MESSAGE: "wasabipad-viewer-delimiter-change",
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
  GIT_STATE_MESSAGE: "wasabipad-viewer-git-state",
  FOCUS_CLOSE_MESSAGE: "wasabipad-viewer-focus-close",
  SELECTION_CHANGE_MESSAGE: "wasabipad-viewer-selection-change",
  MARKDOWN_LINK_MESSAGE: "wasabipad-viewer-markdown-link",
  MARKDOWN_FRAGMENT_MESSAGE: "wasabipad-viewer-markdown-fragment",
} as const;

export interface ExternalPreviewStatus {
  message: string;
  busy: boolean;
}
