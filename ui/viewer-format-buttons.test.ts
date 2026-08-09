// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import { createViewerFormatButtons, syncViewerFormatButtons } from "./viewer-format-buttons";

describe("Feature: viewer format buttons", () => {
  // Given: 表示形式ボタンの置き場と3形式の選択通知
  // When: ボタンを生成してMarkdownボタンを押す
  // Then: Markdown→CSV→Imageの順で表示し、形式を通知する
  it("Scenario: 表示形式をボタンの並びから選択する", () => {
    const host = document.createElement("div");
    const onSelect = vi.fn();
    createViewerFormatButtons(host, onSelect);

    expect([...host.querySelectorAll("button")].map((button) => button.textContent)).toEqual([
      "Markdown", "CSV", "Image",
    ]);
    host.querySelector<HTMLButtonElement>("[data-viewer-format=markdown]")!.click();
    expect(onSelect).toHaveBeenCalledWith("markdown");

    syncViewerFormatButtons(host, "csv");
    expect(host.querySelector<HTMLButtonElement>("[data-viewer-format=csv]")!.getAttribute("aria-pressed"))
      .toBe("true");
    expect(host.querySelector<HTMLButtonElement>("[data-viewer-format=markdown]")!.getAttribute("aria-pressed"))
      .toBe("false");
  });
});
