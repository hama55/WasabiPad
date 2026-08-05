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

describe("Feature: EditorViewState codec", () => {
  // Given: anchor=`{3,1}`、caret=`{5,8}`、topLine=2.5、wrapIntraLinePx=4、scrollLeft=120
  // When: serialize→parse
  // Then: 元のstateと完全一致
  it("Scenario: 保存・ウィンドウ転送で同じ契約を往復する", () => {
    expect(parseEditorViewState(serializeEditorViewState(state))).toEqual(state);
  });

  // Given: scrollLeft=NaN、不完全JSON、壊れたJSON`"{"`
  // When: `isEditorViewState`/`parseEditorViewState`
  // Then: false、undefined、undefined
  it("Scenario: 不完全・非数値・壊れたJSONを拒否する", () => {
    expect(isEditorViewState({ ...state, scrollLeft: Number.NaN })).toBe(false);
    expect(parseEditorViewState('{"caret":{"line":1,"col":2}}')).toBeUndefined();
    expect(parseEditorViewState("{")).toBeUndefined();
  });

  // Given: stateをcloneし、clone.anchor.lineだけ99へ変更
  // When: `cloneEditorViewState`後に変更
  // Then: 元state.anchor.lineは3
  it("Scenario: 複製後の選択位置を元状態と共有しない", () => {
    const cloned = cloneEditorViewState(state);
    cloned.anchor.line = 99;
    expect(state.anchor.line).toBe(3);
  });
});
