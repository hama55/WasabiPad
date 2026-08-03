import { describe, expect, it } from "vitest";
import {
  cloneEditorViewState,
  isEditorViewState,
  parseEditorViewState,
  serializeEditorViewState,
  type EditorViewState,
} from "./editor-view-state";

const state: EditorViewState = {
  anchor: { line: 3, col: 1 },
  caret: { line: 5, col: 8 },
  topLine: 2.5,
  wrapIntraLinePx: 4,
  scrollLeft: 120,
};

describe("EditorViewState codec", () => {
  it("保存・ウィンドウ転送で同じ契約を往復する", () => {
    expect(parseEditorViewState(serializeEditorViewState(state))).toEqual(state);
  });

  it("不完全・非数値・壊れたJSONを拒否する", () => {
    expect(isEditorViewState({ ...state, scrollLeft: Number.NaN })).toBe(false);
    expect(parseEditorViewState('{"caret":{"line":1,"col":2}}')).toBeUndefined();
    expect(parseEditorViewState("{")).toBeUndefined();
  });

  it("複製後の選択位置を元状態と共有しない", () => {
    const cloned = cloneEditorViewState(state);
    cloned.anchor.line = 99;
    expect(state.anchor.line).toBe(3);
  });
});
