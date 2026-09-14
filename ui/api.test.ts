import { beforeEach, describe, expect, it, vi } from "vitest";

const { invokeMock } = vi.hoisted(() => ({
  invokeMock: vi.fn(async () => undefined),
}));

vi.mock("@tauri-apps/api/core", () => ({ invoke: invokeMock }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn() }));

import {
  clearPreviewCache,
  getPreviewCacheInfo,
  readArchiveAsset,
  readFileAsset,
  selectEntry,
} from "./api";
import { IPC_COMMANDS } from "./generated/IpcCommands";

describe("Feature: preview cache IPC", () => {
  beforeEach(() => invokeMock.mockClear());

  // Scenario: キャッシュ保存場所を指定してアーカイブ資産を読む
  // Given: `D:\\WasabiPad\\cache`をキャッシュ場所として選んでいる
  // When: アーカイブ内PDFのバイト列を要求する
  // Then: バックエンドへキャッシュ場所も渡す
  it("Scenario: archive asset reads carry the configured cache directory", async () => {
    await readArchiveAsset("manuals.7z", "guide/manual.pdf", "D:\\WasabiPad\\cache");

    expect(invokeMock).toHaveBeenCalledWith(IPC_COMMANDS.readArchiveAsset, {
      archivePath: "manuals.7z",
      entry: "guide/manual.pdf",
      cacheDirectory: "D:\\WasabiPad\\cache",
    });
  });

  // Scenario: 通常ファイルの資産を既定キャッシュで読む
  // Given: キャッシュ場所を未指定にしている
  // When: PDFのバイト列を要求する
  // Then: nullを明示してバックエンド既定値を使う
  it("Scenario: file asset reads use the backend default when unset", async () => {
    await readFileAsset("C:\\work\\manual.pdf");

    expect(invokeMock).toHaveBeenCalledWith(IPC_COMMANDS.readFileAsset, {
      path: "C:\\work\\manual.pdf",
      cacheDirectory: null,
    });
  });

  // Scenario: 設定画面からキャッシュ情報の取得と削除を依頼する
  // Given: キャッシュ場所が設定されている
  // When: 使用量を確認してから全削除を実行する
  // Then: 同じ場所をバックエンドへ渡す
  it("Scenario: cache info and clear use the selected directory", async () => {
    await getPreviewCacheInfo("D:\\WasabiPad\\cache");
    await clearPreviewCache("D:\\WasabiPad\\cache");

    expect(invokeMock).toHaveBeenNthCalledWith(1, IPC_COMMANDS.previewCacheInfo, {
      cacheDirectory: "D:\\WasabiPad\\cache",
    });
    expect(invokeMock).toHaveBeenNthCalledWith(2, IPC_COMMANDS.clearPreviewCache, {
      cacheDirectory: "D:\\WasabiPad\\cache",
    });
  });

  // Scenario: アーカイブ項目の選択時にもキャッシュ場所を渡す
  // Given: `D:\\WasabiPad\\cache`を選択済みである
  // When: PDFエントリを開く
  // Then: 選択処理でキャッシュを再利用できる引数を渡す
  it("Scenario: entry selection carries the configured cache directory", async () => {
    await selectEntry("guide/manual.pdf", "pdf", "D:\\WasabiPad\\cache");

    expect(invokeMock).toHaveBeenCalledWith(IPC_COMMANDS.selectEntry, {
      relPath: "guide/manual.pdf",
      openAs: "pdf",
      cacheDirectory: "D:\\WasabiPad\\cache",
    });
  });
});
