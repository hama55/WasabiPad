import type { Pos } from "./api";
import { isEditorViewState, type EditorViewState } from "./editor-view-state";

export interface StoredTab {
  id: string;
  path: string | null;
  kind: "file" | "folder" | "blank";
  label: string;
  goto?: Pos;
  viewState?: EditorViewState;
  selectedRelPath?: string;
  selectedLine?: number;
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
    && (!("goto" in candidate) || candidate.goto === undefined || isPos(candidate.goto))
    && (!("selectedRelPath" in candidate) || candidate.selectedRelPath === undefined || typeof candidate.selectedRelPath === "string")
    && (!("selectedLine" in candidate) || candidate.selectedLine === undefined
      || (typeof candidate.selectedLine === "number" && Number.isInteger(candidate.selectedLine) && candidate.selectedLine >= 0))
    && (!("viewState" in candidate) || candidate.viewState === undefined || isEditorViewState(candidate.viewState));
}

export function isStoredTabs(value: unknown): value is StoredTabs {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as Partial<StoredTabs>;
  return Array.isArray(candidate.tabs)
    && candidate.tabs.every(isStoredTab)
    && (typeof candidate.activeId === "string" || candidate.activeId === null);
}
