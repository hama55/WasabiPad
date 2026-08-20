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
    isMarkdown: () => true,
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

  // Given: 0〜2行目の1〜3列を矩形選択している
  // When: 矩形削除を直接依頼する
  // Then: 各行を同じ列規則で削除し、短い行は無理に編集しない
  it("Scenario: 矩形削除は短い行を安全に扱う", async () => {
    const { document, selection, controller } = setup("abcd\nX\nefghij");
    selection.setBlock({ line: 0, col: 1 }, { line: 2, col: 3 });

    await controller.deleteSel();

    expect(document.text()).toBe("ad\nX\nehij");
    expect(document.calls).toContain("editMany(2)");
  });

  // Feature: 矩形編集後のマルチキャレット維持
  // Scenario: 4行を矩形削除した直後の入力を4行すべてへ挿入する
  // Given: 4行の1〜3列を矩形選択している
  // When: 選択範囲を削除し、続けてXを入力する
  // Then: 削除後に残った4個のキャレットすべてへXを挿入する
  it("Scenario: 矩形削除直後の入力を全キャレットへ挿入する", async () => {
    const { document, selection, controller } = setup("abcd\nABCD\n1234\nwxyz");
    selection.setBlock({ line: 0, col: 1 }, { line: 3, col: 3 });

    await controller.deleteSel();
    await controller.insertText("X");

    expect(document.text()).toBe("aXd\nAXD\n1X4\nwXz");
    expect(document.calls.filter((call) => call === "editMany(4)")).toHaveLength(2);
  });

  // Given: 0〜1行目の1〜3列を矩形選択している
  // When: 2行の矩形文字列を貼り付ける
  // Then: 選択幅を置換し、行ごとに対応する文字列を挿入する
  it("Scenario: 矩形貼り付けは行ごとに選択幅を置換する", async () => {
    const { document, selection, controller } = setup("abcd\nEFGH\nijkl");
    selection.setBlock({ line: 0, col: 1 }, { line: 1, col: 3 });

    await controller.pasteBlock(["XY", "Z"]);

    expect(document.text()).toBe("aXYd\nEZH\nijkl");
    expect(document.calls).toContain("editMany(2)");
  });

  // Given: 読み取り専用文書で矩形選択がある
  // When: 矩形貼り付けを直接依頼する
  // Then: IPC編集を呼ばず本文を変更しない
  it("Scenario: 読み取り専用では矩形貼り付けも無視する", async () => {
    const { document, selection, controller } = setup("abcd\nEFGH", true);
    selection.setBlock({ line: 0, col: 1 }, { line: 1, col: 3 });

    await controller.pasteBlock(["XY", "Z"]);

    expect(document.text()).toBe("abcd\nEFGH");
    expect(document.calls).not.toContain("editMany(2)");
  });
});
