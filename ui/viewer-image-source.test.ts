import { describe, expect, it, vi } from "vitest";
import { imageUrlFromArchive, imageUrlFromPath, revokeImageUrl, type ImageAssetSourcePorts } from "./viewer-image-source";

function ports(overrides: Partial<ImageAssetSourcePorts> = {}): ImageAssetSourcePorts {
  return {
    convertFileSrc: (path) => `asset://${path}`,
    readArchiveAsset: vi.fn(async () => [1, 2, 3]),
    createObjectURL: vi.fn(() => "blob:test"),
    revokeObjectURL: vi.fn(),
    ...overrides,
  };
}

describe("Feature: viewer image asset source", () => {
  // Given: Tauriのファイルパス変換ポートがある
  // When: 通常ファイルの画像URLを作る
  // Then: 変換ポートの結果を返す
  it("Scenario: creates a URL for a file path", () => {
    const source = ports();

    expect(imageUrlFromPath("C:\\work\\photo.png", source)).toBe("asset://C:\\work\\photo.png");
  });

  // Given: アーカイブ画像の読込ポートがある
  // When: アーカイブ画像のURLを作る
  // Then: 読み込んだバイト列をBlob URL生成ポートへ渡す
  it("Scenario: creates a URL for an archive image", async () => {
    const readArchiveAsset = vi.fn(async () => [1, 2, 3]);
    const createObjectURL = vi.fn(() => "blob:test");
    const source = ports({ readArchiveAsset, createObjectURL });

    await expect(imageUrlFromArchive("data.zip", "photo.png", "image/png", source)).resolves.toBe("blob:test");
    expect(readArchiveAsset).toHaveBeenCalledWith("data.zip", "photo.png");
    expect(createObjectURL).toHaveBeenCalledWith(expect.objectContaining({ type: "image/png" }));
  });

  // Given: アーカイブ内のPDFを読むポートがある
  // When: PDFプレビュー用のアーカイブURLを作る
  // Then: PDF MIME typeのBlob URLを生成する
  it("Scenario: creates a PDF URL with the PDF MIME type", async () => {
    const createObjectURL = vi.fn(() => "blob:pdf");
    const source = ports({ createObjectURL });

    await expect(imageUrlFromArchive("data.zip", "manual.pdf", "application/pdf", source))
      .resolves.toBe("blob:pdf");
    expect(createObjectURL).toHaveBeenCalledWith(expect.objectContaining({ type: "application/pdf" }));
  });

  // Given: アーカイブ画像の読込ポートが失敗する
  // When: アーカイブ画像のURLを作る
  // Then: 読込エラーを呼び出し元へ返す
  it("Scenario: propagates archive image read failures", async () => {
    const error = new Error("archive read failed");
    const source = ports({ readArchiveAsset: vi.fn(async () => { throw error; }) });

    await expect(imageUrlFromArchive("data.zip", "photo.png", "image/png", source)).rejects.toBe(error);
  });

  // Given: 不要になった画像URLがある
  // When: 画像URLを解放する
  // Then: 解放ポートを一度呼ぶ
  it("Scenario: revokes an image URL", () => {
    const revokeObjectURL = vi.fn();
    const source = ports({ revokeObjectURL });

    revokeImageUrl("blob:test", source);

    expect(revokeObjectURL).toHaveBeenCalledWith("blob:test");
  });
});
