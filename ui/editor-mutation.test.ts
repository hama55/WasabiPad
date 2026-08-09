import { describe, expect, it } from "vitest";
import { EditorMutationController } from "./editor-mutation";
import { LineCache } from "./line-cache";
import { Selection } from "./selection";
import { fakeDocument } from "./test-doubles";

function setup(initial: string, readOnly = false) {
  const document = fakeDocument(initial);
  const selection = new Selection();
  const lineCache = new LineCache(document.client);
  const results: { caret: { line: number; col: number }; line_count: number }[] = [];
  const controller = new EditorMutationController({
    doc: document.client,
    selection,
    lineCache,
    lineCount: () => document.text().split("\n").length,
    isReadOnly: () => readOnly,
    applyResult: (result) => {
      results.push(result);
      selection.caret = result.caret;
      selection.anchor = result.caret;
    },
    renderAfterEdit: async () => {},
  });
  return { document, selection, lineCache, controller, results };
}

describe("Feature: EditorMutationController", () => {
  // Given: `abcDEFghi`のDEFを選択している
  // When: 選択範囲を元の位置より前へ移動し、Undo/Redoする
  // Then: editMany一回で移動し、Undo/Redo一回ずつで完全に往復する
  it("Scenario: 移動を1つの履歴単位で往復する", async () => {
    const { document, selection, lineCache, controller } = setup("abcDEFghi");
    await lineCache.fetch(0);
    selection.anchor = { line: 0, col: 3 };
    selection.caret = { line: 0, col: 6 };

    await controller.moveSelection(
      { line: 0, col: 3 },
      { line: 0, col: 6 },
      { line: 0, col: 0 },
      false,
    );
    expect(document.text()).toBe("DEFabcghi");
    expect(document.calls).toContain("editMany(2)");
    await controller.undo(false);
    expect(document.text()).toBe("abcDEFghi");
    expect(document.calls.filter((call) => call === "undo()")).toHaveLength(1);
    await controller.undo(false);
    expect(document.text()).toBe("abcDEFghi");
    await controller.undo(true);
    expect(document.text()).toBe("DEFabcghi");
  });

  // Given: `abcDEFghi`のDEFを選択している
  // When: Ctrl相当のcopy=trueで末尾へ挿入し、Undo/Redoする
  // Then: 元の選択文字列を残し、edit一回の履歴で往復する
  it("Scenario: コピーを元の文字列を残したまま往復する", async () => {
    const { document, selection, lineCache, controller } = setup("abcDEFghi");
    await lineCache.fetch(0);
    selection.anchor = { line: 0, col: 3 };
    selection.caret = { line: 0, col: 6 };

    await controller.moveSelection(
      { line: 0, col: 3 },
      { line: 0, col: 6 },
      { line: 0, col: 9 },
      true,
    );
    expect(document.text()).toBe("abcDEFghiDEF");
    expect(document.calls).toContain('edit(0:9,0:9,"DEF")');
    await controller.undo(false);
    expect(document.text()).toBe("abcDEFghi");
    await controller.undo(true);
    expect(document.text()).toBe("abcDEFghiDEF");
  });

  // Given: 読み取り専用の文書で選択範囲がある
  // When: 編集コントローラへ選択削除を直接依頼する
  // Then: IPC編集を呼ばず、本文を変更しない
  it("Scenario: 読み取り専用では直接の選択削除も無視する", async () => {
    const { document, selection, controller } = setup("abcDEFghi", true);
    selection.anchor = { line: 0, col: 3 };
    selection.caret = { line: 0, col: 6 };

    await controller.deleteSel();

    expect(document.text()).toBe("abcDEFghi");
    expect(document.calls).not.toContain('edit(0:3,0:6,"")');
  });
});
