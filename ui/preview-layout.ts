import type { ViewerFormat } from "./api";

export const PREVIEW_MIN_WIDTH = 260;
export const SIDEBAR_MIN_WIDTH = 120;
export const SIDEBAR_DEFAULT_WIDTH = 220;
export const EDITOR_MIN_WIDTH = 120;
export const PANE_SPLITTER_WIDTH = 4;

export interface PreviewDocument {
  ownerTabId: string | null;
  path: string;
  format: ViewerFormat;
}

export interface PreviewLayoutState {
  available: boolean;
  collapsed: boolean;
  fullscreen: boolean;
}

export interface PaneVisibilityInput {
  mainWidth: number;
  sidebarAvailable: boolean;
  sidebarCollapsed: boolean;
  sidebarWidth: number;
  previewAvailable: boolean;
  previewCollapsed: boolean;
  previewWidth?: number;
  fullscreen: boolean;
}

export interface PaneVisibility {
  sidebarShown: boolean;
  previewShown: boolean;
  fullscreen: boolean;
}

export function isPreviewShown(state: PreviewLayoutState): boolean {
  return state.available && !state.collapsed;
}

export function isPreviewFullscreen(state: PreviewLayoutState): boolean {
  return isPreviewShown(state) && state.fullscreen;
}

export function isPreviewSplitterShown(state: PreviewLayoutState): boolean {
  return isPreviewShown(state) && !state.fullscreen;
}

export function shouldKeepPreviewFullscreen(
  ownerTabId: string | null,
  activeTabId: string | null,
  hasPreviewFormat: boolean,
): boolean {
  return hasPreviewFormat && ownerTabId !== null && ownerTabId === activeTabId;
}

export function isCurrentPreviewDocument(
  openedDocument: PreviewDocument | null,
  activeTabId: string | null,
  documentPath: string,
): openedDocument is PreviewDocument {
  return openedDocument?.ownerTabId === activeTabId && openedDocument.path === documentPath;
}

export function effectivePreviewFormat(
  documentPath: string,
  detectedFormat: ViewerFormat | null,
  activeTabId: string | null,
  openedDocument: PreviewDocument | null,
): ViewerFormat | null {
  return isCurrentPreviewDocument(openedDocument, activeTabId, documentPath)
    ? openedDocument.format
    : detectedFormat;
}

export function previewWidthFromPointer(mainRight: number, clientX: number, mainLeft = 0): number {
  const measuredAvailable = mainRight - mainLeft;
  const available = Number.isFinite(measuredAvailable) ? Math.max(0, measuredAvailable) : 0;
  const minWidth = Math.min(PREVIEW_MIN_WIDTH, available);
  const requested = mainRight - clientX;
  if (!Number.isFinite(requested)) return minWidth;
  return Math.min(available, Math.max(minWidth, requested));
}

export function resolvePaneVisibility(input: PaneVisibilityInput): PaneVisibility {
  const mainWidth = Number.isFinite(input.mainWidth) ? Math.max(0, input.mainWidth) : 0;
  const sidebarWidth = Number.isFinite(input.sidebarWidth)
    ? Math.max(SIDEBAR_MIN_WIDTH, input.sidebarWidth)
    : SIDEBAR_MIN_WIDTH;
  const configuredPreviewWidth = input.previewWidth ?? PREVIEW_MIN_WIDTH;
  const previewWidth = Number.isFinite(configuredPreviewWidth)
    ? Math.max(PREVIEW_MIN_WIDTH, configuredPreviewWidth)
    : PREVIEW_MIN_WIDTH;
  const requestedSidebar = input.sidebarAvailable && !input.sidebarCollapsed;
  const requestedPreview = input.previewAvailable && !input.previewCollapsed;
  if (mainWidth <= 0 || !requestedPreview && !requestedSidebar) {
    return { sidebarShown: false, previewShown: false, fullscreen: false };
  }

  if (input.fullscreen && requestedPreview) {
    // 全画面プレビューは本文領域を占有する。幅が足りないときだけ
    // サイドバーを退避し、プレビューを画面内へ残す。
    const sidebarShown = requestedSidebar
      && mainWidth >= sidebarWidth + PANE_SPLITTER_WIDTH + PREVIEW_MIN_WIDTH;
    return { sidebarShown, previewShown: true, fullscreen: true };
  }

  let sidebarShown = requestedSidebar;
  let previewShown = requestedPreview;
  const canFitPreview = (withSidebar: boolean) => mainWidth >=
    (withSidebar ? sidebarWidth + PANE_SPLITTER_WIDTH : 0)
    + EDITOR_MIN_WIDTH + PANE_SPLITTER_WIDTH + previewWidth;
  const canFitSidebar = (withPreview: boolean) => mainWidth >=
    sidebarWidth + PANE_SPLITTER_WIDTH + EDITOR_MIN_WIDTH
    + (withPreview ? PANE_SPLITTER_WIDTH + previewWidth : 0);

  if (previewShown && !canFitPreview(sidebarShown)) previewShown = false;
  if (sidebarShown && !canFitSidebar(previewShown)) sidebarShown = false;
  // 大きすぎるサイドバーが退避したことで、プレビューだけなら表示できる場合を拾う。
  if (!previewShown && requestedPreview && canFitPreview(sidebarShown)) previewShown = true;
  // 上の再評価で本文幅が不足した場合は、サイドバーを優先的に退避する。
  if (sidebarShown && previewShown && !canFitPreview(true)) sidebarShown = false;
  if (previewShown && !canFitPreview(sidebarShown)) previewShown = false;
  if (sidebarShown && !canFitSidebar(previewShown)) sidebarShown = false;

  return {
    sidebarShown,
    previewShown,
    fullscreen: false,
  };
}
