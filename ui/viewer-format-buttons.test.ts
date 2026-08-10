// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import viewerHtml from "../viewer.html?raw";
import { createViewerFormatButtons, syncViewerFormatButtons } from "./viewer-format-buttons";

describe("Feature: viewer format buttons", () => {
  // Given: 表示形式ボタンの置き場と5形式の選択通知
  // When: ボタンを生成して5形式を順に押す
  // Then: レジストリの表示順Markdown→CSV→Image→PDF→html(静的)で表示し、各形式を通知する
  it("Scenario: 表示形式をボタンの並びから選択する", () => {
    const host = document.createElement("div");
    const onSelect = vi.fn();
    createViewerFormatButtons(host, onSelect);

    const buttons = [...host.querySelectorAll<HTMLButtonElement>("button")];
    expect(buttons.map((button) => button.textContent)).toEqual([
      "Markdown", "CSV", "Image", "PDF", "html(静的)",
    ]);
    expect(buttons.map((button) => button.type)).toEqual(["button", "button", "button", "button", "button"]);
    buttons.forEach((button) => button.click());
    expect(onSelect.mock.calls).toEqual([["markdown"], ["csv"], ["image"], ["pdf"], ["html"]]);

    syncViewerFormatButtons(host, "csv");
    expect(buttons[1].getAttribute("aria-pressed")).toBe("true");
    expect(buttons[0].getAttribute("aria-pressed")).toBe("false");
  });

  // Given: viewer.htmlのタイトルバー
  // When: 表示形式コントロールのDOMを確認する
  // Then: selectではなくボタン用グループを持つ
  it("Scenario: タイトルバーはプルダウンを使わない", () => {
    expect(viewerHtml).toContain('<div id="viewer-format" role="group" aria-label="表示形式"></div>');
    expect(viewerHtml).not.toContain('<select id="viewer-format"');
  });
});
