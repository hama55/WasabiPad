import { expect, it, vi } from "vitest";
import { createDiagramAssetReader } from "./diagram-asset-reader";

// Feature: アーカイブの図参照
// Scenario: 文書の名前変更後も図と共有背景を読む
// Given: 古い相対参照と移動済みの資産
// When: 図と背景を読む
// Then: 現在の文書画像フォルダへ解決する
it("Scenario: アーカイブの名前変更後も図と背景を解決する", async () => {
  const bytes = new ArrayBuffer(3);
  const readArchive = vi.fn(async (_archive: string, entry: string) => {
    if (!entry.startsWith("notes/image_markdown/new/")) throw new Error("missing");
    return bytes;
  });
  const read = createDiagramAssetReader({ sourcePath: "book.zip", archivePath: "book.zip", archiveEntry: "notes/new.md" }, { readLocal: vi.fn(), readArchive });
  expect(await read("image_markdown/old/diagram-123.svg")).toBe(bytes);
  expect(await read("pasted-image.png", "image_markdown/old/diagram-123.svg")).toBe(bytes);
  expect(readArchive).toHaveBeenLastCalledWith("book.zip", "notes/image_markdown/new/pasted-image.png");
  await expect(read("https://example.com/image.png")).rejects.toThrow();
});
