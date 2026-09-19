import { describe, expect, it } from "vitest";
import {
  basename,
  comparableDocumentPath,
  dirname,
  isSameOrDescendantDocumentPath,
  joinWindowsRoot,
  movedRelativePath,
  rebaseWindowsPath,
  relativePathFromRoot,
  relativePathWithinRoot,
} from "./path";

describe("Feature: path rules", () => {
  // Given: `C:\a/b.txt`,`a/b.txt`,`b.txt`を入力
  // When: basename/dirnameを呼ぶ
  // Then: basename=`b.txt`、dirname=`a`、単一名はnull
  it("Scenario: normalizes slash styles", () => {
    expect(basename("C:\\a/b.txt")).toBe("b.txt");
    expect(dirname("a/b.txt")).toBe("a");
    expect(dirname("b.txt")).toBeNull();
  });

  // Given: root=`C:\work`、相対path=`sub/a.txt`
  // When: join/relative変換
  // Then: `C:\work\sub\a.txt`と`sub/a.txt`
  it("Scenario: converts workspace paths in one place", () => {
    expect(joinWindowsRoot("C:\\work", "sub/a.txt")).toBe("C:\\work\\sub\\a.txt");
    expect(relativePathFromRoot("C:\\work", "C:\\work\\sub\\a.txt")).toBe("sub/a.txt");
  });

  // Given: root大小文字差の内部pathと`C:\work2`の外部path
  // When: root内判定
  // Then: 内部は`sub/a.txt`、外部はnull
  it("Scenario: accepts only paths inside the workspace boundary", () => {
    expect(relativePathWithinRoot("C:\\Work", "c:\\work\\sub\\a.txt")).toBe("sub/a.txt");
    expect(relativePathWithinRoot("C:\\work", "C:\\work2\\a.txt")).toBeNull();
  });

  // Given: 旧rootが`C:\work\old`、新rootが`C:\work\new`
  // When: 旧配下と`C:\work2`をrebase
  // Then: 配下は`C:\work\new\a.txt`、外部はnull
  it("Scenario: rebases defaults after file or directory renames", () => {
    expect(rebaseWindowsPath("C:\\work\\old\\a.txt", "C:\\work\\old", "C:\\work\\new")).toBe("C:\\work\\new\\a.txt");
    expect(rebaseWindowsPath("C:\\work2\\a.txt", "C:\\work", "C:\\new")).toBeNull();
  });

  // Given: `docs/memo.txt`を`archive`へ移動し、開いている相対パスが`docs/memo.txt::Sheet1`
  // When: 移動後の相対パスを計算
  // Then: `archive/memo.txt::Sheet1`へ一括で追従する
  it("Scenario: moves selected files and descendants to the requested directory", () => {
    expect(movedRelativePath("docs/memo.txt::Sheet1", "docs/memo.txt", "archive"))
      .toBe("archive/memo.txt::Sheet1");
    expect(movedRelativePath("docs/memo.txt", "docs/memo.txt", "archive", "renamed.txt"))
      .toBe("archive/renamed.txt");
    expect(movedRelativePath("other.txt", "docs/memo.txt", "archive")).toBe("other.txt");
  });

  // Feature: 物理パスとアーカイブ内部パスの同一性
  // Scenario: 外側のWindowsパスだけ大小文字を無視する
  // Given: 外側のcaseが異なり、内部名はcaseだけが異なる複合パス
  // When: 比較キーと包含関係を求める
  // Then: 外側は同一視し、内部名は別項目として保持する
  it("Scenario: preserves archive entry case while folding the Windows path", () => {
    expect(comparableDocumentPath("Docs\\Data.zip::Readme.txt"))
      .toBe("docs/data.zip::Readme.txt");
    expect(comparableDocumentPath("Docs/Data.zip::Readme.txt"))
      .not.toBe(comparableDocumentPath("docs/data.zip::README.txt"));
    expect(isSameOrDescendantDocumentPath("DOCS/Data.zip::Readme.txt", "docs/data.zip")).toBe(true);
    expect(isSameOrDescendantDocumentPath("docs/data.zip::README.txt", "docs/data.zip::Readme.txt")).toBe(false);
  });

  // Feature: case差を含む移動後の選択追従
  // Scenario: Windows側のcaseとslashが異なるアーカイブを移動する
  // Given: 選択中の内部名は`Readme.txt`で、移動元のcaseが異なる
  // When: 移動後の相対パスを計算する
  // Then: 外側だけを置換し、内部名のcaseを保持する
  it("Scenario: rebases a case-different archive path without changing its entry", () => {
    expect(movedRelativePath("Docs\\Data.zip::Readme.txt", "docs/data.zip", "archive"))
      .toBe("archive/data.zip::Readme.txt");
  });
});
