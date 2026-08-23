import { describe, expect, it } from "vitest";
import {
  basename,
  dirname,
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
});
