export const PREVIEW_MIN_WIDTH = 260;

export interface PreviewLayoutState {
  available: boolean;
  collapsed: boolean;
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

export function previewWidthFromPointer(mainRight: number, clientX: number): number {
  return Math.max(PREVIEW_MIN_WIDTH, mainRight - clientX);
}
