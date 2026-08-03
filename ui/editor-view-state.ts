import type { EditorViewState } from "./generated/EditorViewState";
import type { Pos } from "./api";
export type { EditorViewState } from "./generated/EditorViewState";

const isNumber = (value: unknown): value is number =>
  typeof value === "number" && Number.isFinite(value);

const isPos = (value: unknown): value is Pos => {
  if (typeof value !== "object" || value === null) return false;
  const pos = value as Record<string, unknown>;
  return isNumber(pos.line) && isNumber(pos.col);
};

export function isEditorViewState(value: unknown): value is EditorViewState {
  if (typeof value !== "object" || value === null) return false;
  const state = value as Record<string, unknown>;
  return isPos(state.anchor)
    && isPos(state.caret)
    && isNumber(state.topLine)
    && isNumber(state.wrapIntraLinePx)
    && isNumber(state.scrollLeft);
}

export function cloneEditorViewState(state: EditorViewState): EditorViewState {
  return {
    ...state,
    anchor: { ...state.anchor },
    caret: { ...state.caret },
  };
}

export function serializeEditorViewState(state: EditorViewState): string {
  return JSON.stringify(state);
}

export function parseEditorViewState(text: string | null): EditorViewState | undefined {
  if (!text) return undefined;
  try {
    const value: unknown = JSON.parse(text);
    return isEditorViewState(value) ? value : undefined;
  } catch {
    return undefined;
  }
}
