import { describe, expect, it } from "vitest";
import {
  canUseExternalEditor,
  canUseExternalPreview,
  commandLineForExternalFile,
  commandTemplateFor,
  editorExtensionOf,
  fileExtensionOf,
} from "./external-integration";

describe("Feature: 連携コマンド", () => {
  // Scenario: 設定済みテンプレートへ保存済みファイルを渡す
  // Given: \`{file}\`を含むWindowsコマンドテンプレートとファイルパス
  // When: 連携用のコマンドラインを組み立てる
  // Then: 引用符とファイルパス以外の文字列をそのまま保つ
  it("Scenario: {file}を既存のファイル置換で展開する", () => {
    expect(commandLineForExternalFile(
      'C:\\Tools\\editor.exe "{file}" --wait',
      "C:\\work\\memo.txt",
    )).toBe('C:\\Tools\\editor.exe "C:\\work\\memo.txt" --wait');
  });

  // Scenario: \`{file}\`を含まないテンプレートを起動する
  // Given: 設定済みだが対象ファイルの差し込み先がないコマンド
  // When: 連携用のコマンドラインを組み立てる
  // Then: 起動せず設定不備を通知できるエラーになる
  it("Scenario: {file}なしのテンプレートを拒否する", () => {
    expect(() => commandLineForExternalFile("notepad.exe", "C:\\work\\memo.txt"))
      .toThrow("{file}");
  });

  // Scenario: 拡張子と形式から設定を探す
  // Given: 編集用とプレビュー用を別々に持つコマンドマップ
  // When: 設定値を取得する
  // Then: 空値は未設定として扱い、編集とプレビューを混同しない
  it("Scenario: 連携エディタと連携プレビューを独立して引く", () => {
    const commands = { md: 'editor "{file}"', markdown: "" };
    expect(commandTemplateFor(commands, "md")).toBe('editor "{file}"');
    expect(commandTemplateFor(commands, "markdown")).toBeNull();
  });

  // Scenario: Windowsパスから編集設定のキーを決める
  // Given: 大文字拡張子と有効拡張子
  // When: 編集用拡張子を求める
  // Then: 有効拡張子を優先して小文字へ正規化する
  it("Scenario: 編集用の有効拡張子を正規化する", () => {
    expect(fileExtensionOf("C:\\work\\Memo.MD")).toBe("md");
    expect(editorExtensionOf("C:\\work\\Memo.TXT", ".md")).toBe("md");
  });

  // Scenario: 連携エディタの対象を判定する
  // Given: 保存済み通常ファイル、アーカイブ内文書、バイナリ文書
  // When: 外部連携可能か確認する
  // Then: 保存済み通常ファイルだけを許可する
  it("Scenario: 連携エディタは通常の保存済み実ファイルだけ許可する", () => {
    const base = {
      savePath: "C:\\work\\memo.txt",
      folderRoot: null,
      archivePath: null,
      archiveEntry: null,
      isBinary: false,
    } as const;
    expect(canUseExternalEditor(base, base.savePath)).toBe(true);
    expect(canUseExternalEditor({ ...base, archivePath: "C:\\work\\data.7z" }, base.savePath)).toBe(false);
    const binary = { ...base, isBinary: true };
    expect(canUseExternalEditor(binary, base.savePath)).toBe(true);
  });

  // Scenario: 実拡張子と異なる形式でプレビューする
  // Given: 保存済みMarkdown、通常のCSV、アーカイブ内Markdown
  // When: 外部プレビュー可能か確認する
  // Then: 実拡張子とViewerFormatが一致する通常ファイルだけを許可する
  it("Scenario: 連携プレビューは実拡張子と形式が一致する通常ファイルだけ許可する", () => {
    expect(canUseExternalPreview("C:\\work\\memo.md", "markdown", null, null)).toBe(true);
    expect(canUseExternalPreview("C:\\work\\memo.csv", "markdown", null, null)).toBe(false);
    expect(canUseExternalPreview(
      "C:\\work\\archive.7z",
      "markdown",
      "C:\\work\\archive.7z",
      "memo.md",
    )).toBe(false);
  });
});
