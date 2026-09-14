import type { Pos } from "./api";
import { isEditorViewState, type EditorViewState } from "./editor-view-state";

export interface StoredTab {
  id: string;
  path: string | null;
  kind: "file" | "folder" | "blank";
  label: string;
  draftDirectory?: string;
  goto?: Pos;
  fragment?: string;
  viewState?: EditorViewState;
  selectedRelPath?: string;
  selectedLine?: number;
  fileTreeWidth?: number;
}

export interface StoredTabs {
  tabs: StoredTab[];
  activeId: string | null;
}

function isPos(value: unknown): value is Pos {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as Partial<Pos>;
  return typeof candidate.line === "number"
    && Number.isInteger(candidate.line)
    && candidate.line >= 0
    && typeof candidate.col === "number"
    && Number.isInteger(candidate.col)
    && candidate.col >= 0;
}

export function isStoredTab(value: unknown): value is StoredTab {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as Partial<StoredTab>;
  return typeof candidate.id === "string"
    && (typeof candidate.path === "string" || candidate.path === null)
    && (candidate.kind === "file" || candidate.kind === "folder" || candidate.kind === "blank")
    && typeof candidate.label === "string"
    && (!("draftDirectory" in candidate) || candidate.draftDirectory === undefined || typeof candidate.draftDirectory === "string")
    && (!("goto" in candidate) || candidate.goto === undefined || isPos(candidate.goto))
    && (!("fragment" in candidate) || candidate.fragment === undefined || typeof candidate.fragment === "string")
    && (!("selectedRelPath" in candidate) || candidate.selectedRelPath === undefined || typeof candidate.selectedRelPath === "string")
    && (!("selectedLine" in candidate) || candidate.selectedLine === undefined
      || (typeof candidate.selectedLine === "number" && Number.isInteger(candidate.selectedLine) && candidate.selectedLine >= 0))
    && (!("fileTreeWidth" in candidate) || candidate.fileTreeWidth === undefined
      || (typeof candidate.fileTreeWidth === "number" && Number.isFinite(candidate.fileTreeWidth)))
    && (!("viewState" in candidate) || candidate.viewState === undefined || isEditorViewState(candidate.viewState));
}

export function isStoredTabs(value: unknown): value is StoredTabs {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as Partial<StoredTabs>;
  return Array.isArray(candidate.tabs)
    && candidate.tabs.every(isStoredTab)
    && (typeof candidate.activeId === "string" || candidate.activeId === null);
}

export function normalizeStoredTabs(value: unknown): StoredTabs | null {
  if (isStoredTabs(value)) return value;
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const candidate = value as Partial<StoredTabs>;
  if (!Array.isArray(candidate.tabs)
    || (typeof candidate.activeId !== "string" && candidate.activeId !== null)) return null;
  const tabs = candidate.tabs.map((tab) => {
    if (isStoredTab(tab)) return tab;
    if (typeof tab !== "object" || tab === null || Array.isArray(tab)) return null;
    const withoutInvalidWidth = { ...(tab as Record<string, unknown>) };
    delete withoutInvalidWidth.fileTreeWidth;
    return isStoredTab(withoutInvalidWidth) ? withoutInvalidWidth : null;
  });
  return tabs.every((tab): tab is StoredTab => tab !== null)
    ? { tabs, activeId: candidate.activeId }
    : null;
}
