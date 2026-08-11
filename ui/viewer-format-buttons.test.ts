// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import viewerHtml from "../viewer.html?raw";
import { createViewerFormatButtons, syncViewerFormatButtons } from "./viewer-format-buttons";

describe("Feature: viewer format buttons", () => {
  // Given: 表示形式ボタンの置き場と5形式の選択通知
  // When: ボタンを生成して5形式を順に押す
  // Then: レジストリの表示順markdown→csv→image→pdf→html(静的)で表示し、各形式を通知する
  it("Scenario: 表示形式をボタンの並びから選択する", () => {
    const host = document.createElement("div");
    const onSelect = vi.fn();
    createViewerFormatButtons(host, onSelect);

    const buttons = [...host.querySelectorAll<HTMLButtonElement>("button")];
    expect(buttons.map((button) => button.textContent)).toEqual([
      "markdown", "csv", "image", "pdf", "html(静的)",
    ]);
    expect(buttons.map((button) => button.type)).toEqual(["button", "button", "button", "button", "button"]);
    buttons.forEach((button) => button.click());
    expect(onSelect.mock.calls).toEqual([["markdown"], ["csv"], ["image"], ["pdf"], ["html"]]);

    syncViewerFormatButtons(host, "csv");
    expect(buttons[1].getAttribute("aria-pressed")).toBe("true");
    expect(buttons[0].getAttribute("aria-pressed")).toBe("false");
  });

  // Given: markdownファイルを表示中
  // When: 形式ボタンの利用可能状態を同期する
  // Then: テキスト形式は押せるがimage/pdfは押せない
  it("Scenario: データに対応しない形式ボタンを無効にする", () => {
    const host = document.createElement("div");
    createViewerFormatButtons(host, vi.fn());

    syncViewerFormatButtons(host, "markdown", "notes.md");

    expect(host.querySelector<HTMLButtonElement>("[data-viewer-format='markdown']")?.disabled).toBe(false);
    expect(host.querySelector<HTMLButtonElement>("[data-viewer-format='csv']")?.disabled).toBe(false);
    expect(host.querySelector<HTMLButtonElement>("[data-viewer-format='image']")?.disabled).toBe(true);
    expect(host.querySelector<HTMLButtonElement>("[data-viewer-format='pdf']")?.disabled).toBe(true);
    expect(host.querySelector<HTMLButtonElement>("[data-viewer-format='image']")?.getAttribute("aria-disabled")).toBe("true");
  });

  // Given: viewer.htmlのタイトルバー
  // When: 表示形式コントロールのDOMを確認する
  // Then: selectではなくボタン用グループを持つ
  it("Scenario: タイトルバーはプルダウンを使わない", () => {
    expect(viewerHtml).toContain('<div id="viewer-format" role="group" aria-label="表示形式"></div>');
    expect(viewerHtml).not.toContain('<select id="viewer-format"');
  });
});
