import { describe, expect, it } from "vitest";
import {
  canUseExternalEditor,
  canUseExternalPreview,
  commandLineForExternalFile,
  commandTemplateFor,
  editorExtensionOf,
  externalCommandLabel,
  externalCommandsFor,
  externalPreviewSourcePathFor,
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

  // Given: 前後に空白を含む設定済みテンプレート
  // When: 連携用のコマンドラインを組み立てる
  // Then: ファイル置換以外の文字列を削らない
  it("Scenario: 連携コマンドの空白を保ったまま置換する", () => {
    expect(commandLineForExternalFile(
      '  editor "{file}"  ',
      "C:\\work\\memo.txt",
    )).toBe('  editor "C:\\work\\memo.txt"  ');
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
    const commands = {
      md: [
        { name: "エディタA", command: 'editor-a "{file}"' },
        { name: "", command: 'editor-b "{file}"' },
      ],
      markdown: [],
    };
    expect(commandTemplateFor(commands, "md")).toBe('editor-a "{file}"');
    expect(externalCommandsFor(commands, "md")).toHaveLength(2);
    expect(externalCommandLabel(commands.md[0])).toBe("エディタA");
    expect(externalCommandLabel(commands.md[1])).toBe('editor-b "{file}"');
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

  // Scenario: フォルダビューで選択中の保存済み実ファイルを許可する
  // Given: folderRootを持つフォルダビューで保存済みファイルを選択している
  // When: 連携エディタの対象可否を判定する
  // Then: フォルダビューの所属だけでは拒否せず、フォルダ自身は拒否する
  it("Scenario: フォルダビューの保存済みファイルを連携エディタで開ける", () => {
    const base = {
      savePath: "C:\\work\\memo.txt",
      folderRoot: null,
      archivePath: null,
      archiveEntry: null,
    } as const;
    const folderFile = { ...base, folderRoot: "C:\\work" };
    expect(canUseExternalEditor(folderFile, folderFile.savePath)).toBe(true);
    expect(canUseExternalEditor({ ...folderFile, savePath: null }, "C:\\work")).toBe(false);
  });

  // Scenario: フォルダビューの保存済みMarkdownを連携プレビューで開ける
  // Given: folderRootを持つフォルダビューで保存済みMarkdownを表示している
  // When: 外部プレビュー可能か確認する
  // Then: フォルダビューの所属だけでは拒否せず、実拡張子とViewerFormatが一致する通常ファイルだけを許可する
  it("Scenario: フォルダビューの保存済みMarkdownを連携プレビューで開ける", () => {
    const folderFile = {
      savePath: "C:\\work\\memo.md",
      displayPath: "C:\\work\\memo.md",
      folderRoot: "C:\\work",
      archivePath: null,
      archiveEntry: null,
    } as const;
    expect(externalPreviewSourcePathFor(folderFile, "markdown")).toBe(folderFile.savePath);
    expect(canUseExternalPreview("C:\\work\\memo.csv", "markdown", null, null)).toBe(false);
    expect(canUseExternalPreview(
      "C:\\work\\archive.7z",
      "markdown",
      "C:\\work\\archive.7z",
      "memo.md",
    )).toBe(false);
  });
});
