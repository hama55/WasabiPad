// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import viewerHtml from "../viewer.html?raw";
import { createViewerChartMenuItem, createViewerDelimiterMenuItem } from "./viewer-context-menu";
import { createViewerFormatButtons, syncViewerActionButtons, syncViewerFormatButtons } from "./viewer-format-buttons";

function mount() {
  const host = document.createElement("div");
  document.body.replaceChildren(host);
  const onSelect = vi.fn();
  createViewerFormatButtons(host, onSelect);
  const trigger = host.querySelector<HTMLButtonElement>(".viewer-format-trigger")!;
  const panel = host.querySelector<HTMLElement>("[popover]")!;
  // jsdomにはPopover APIがない。ネイティブの開閉・Esc・外側クリックはブラウザで検証する。
  if (panel) panel.hidePopover = vi.fn();
  return { host, onSelect, trigger, panel };
}

describe("Feature: プレビュー形式パネル", () => {
  afterEach(() => document.body.replaceChildren());
  // Given: Markdown形式のプレビュー
  // When: 6候補を確認しHTMLへホバーしてからクリックする
  // Then: 現在形式を強調し、クリックでだけ切り替えて閉じる
  it("Scenario: クリックした形式だけを確定する", () => {
    const { host, onSelect, trigger, panel } = mount();
    syncViewerFormatButtons(host, "markdown", "notes.md");
    expect(panel).not.toBeNull();
    expect(trigger.getAttribute("popovertarget")).toBe(panel.id);
    expect(panel.getAttribute("popover")).toBe("auto");
    const choices = [...panel.querySelectorAll<HTMLButtonElement>("[data-viewer-format]")];
    expect(choices.map(button => button.textContent)).toEqual(["Markdown", "CSV", "Image", "PDF", "html(静的)", "SQLite"]);
    expect(choices.map(button => button.dataset.viewerFormat)).toEqual(["markdown", "csv", "image", "pdf", "html", "sqlite"]);
    expect(trigger.textContent).toContain("Markdown");
    expect(choices[0].getAttribute("aria-pressed")).toBe("true");
    expect(choices[1].getAttribute("aria-pressed")).toBe("false");
    choices[4].dispatchEvent(new MouseEvent("pointerover", { bubbles: true }));
    expect(onSelect).not.toHaveBeenCalled();
    choices[4].click();
    expect(onSelect).toHaveBeenCalledExactlyOnceWith("html");
    expect(panel.hidePopover).toHaveBeenCalledOnce();
    expect(document.activeElement).toBe(trigger);
  });
  // Given: notes.mdをMarkdownとして表示中
  // When: 非対応形式をクリックする
  // Then: Image/PDFは無効で通知されずCSVは選択できる
  it("Scenario: 非対応形式を選択できない", () => {
    const { host, onSelect } = mount();
    syncViewerFormatButtons(host, "markdown", "notes.md");
    for (const format of ["image", "pdf"]) {
      const button = host.querySelector<HTMLButtonElement>(`[data-viewer-format='${format}']`)!;
      expect(button.disabled).toBe(true);
      expect(button.getAttribute("aria-disabled")).toBe("true");
      button.click();
    }
    expect(onSelect).not.toHaveBeenCalled();
    expect(host.querySelector<HTMLButtonElement>("[data-viewer-format='csv']")?.disabled).toBe(false);
  });
  // Given: SQLiteヘッダー不一致でMarkdownへフォールバックした.db
  // When: 現在形式を同期しその後SQLiteへ同期する
  // Then: フォールバック中は現在形式とSQLite、SQLite中はSQLiteだけを選択できる
  it("Scenario: SQLiteの利用可否とフォールバックを維持する", () => {
    const { host, trigger } = mount();
    syncViewerFormatButtons(host, "markdown", "data.db");
    expect(trigger.textContent).toContain("Markdown");
    expect(host.querySelector<HTMLButtonElement>("[data-viewer-format='markdown']")?.disabled).toBe(false);
    expect(host.querySelector<HTMLButtonElement>("[data-viewer-format='sqlite']")?.disabled).toBe(false);
    expect(host.querySelector<HTMLButtonElement>("[data-viewer-format='image']")?.disabled).toBe(true);
    syncViewerFormatButtons(host, "sqlite", "data.db");
    expect(trigger.textContent).toContain("SQLite");
    expect(host.querySelector<HTMLButtonElement>("[data-viewer-format='markdown']")?.disabled).toBe(true);
    expect(host.querySelector<HTMLButtonElement>("[data-viewer-format='sqlite']")?.disabled).toBe(false);
  });
  // Given: プレビュータイトルバー
  // When: 形式選択の置き場を確認する
  // Then: selectを廃止して形式パネル用の置き場を持つ
  it("Scenario: タイトルバーから形式パネルを利用する", () => {
    const template = document.createElement("template");
    template.innerHTML = viewerHtml;
    expect(template.content.querySelector("#viewer-format")?.tagName).toBe("DIV");
  });
  // Given: CSV区切り文字変更とグラフ作成の操作領域
  // When: CSVからMarkdownへ形式を切り替える
  // Then: CSVの2操作だけを表示し各通知先を呼び出せる
  it("Scenario: CSVのダイアログ操作を維持する", () => {
    const host = document.createElement("div");
    const onDelimiter = vi.fn();
    const onChart = vi.fn();
    host.replaceChildren(createViewerDelimiterMenuItem(onDelimiter), createViewerChartMenuItem(onChart));
    syncViewerActionButtons(host, "csv");
    expect(host.hidden).toBe(false);
    expect([...host.querySelectorAll<HTMLButtonElement>("button")].every(button => !button.hidden)).toBe(true);
    host.querySelector<HTMLButtonElement>("[data-viewer-action='delimiter']")!.click();
    host.querySelector<HTMLButtonElement>("[data-viewer-action='chart']")!.click();
    expect(onDelimiter).toHaveBeenCalledOnce();
    expect(onChart).toHaveBeenCalledOnce();
    syncViewerActionButtons(host, "markdown");
    expect(host.hidden).toBe(true);
    expect([...host.querySelectorAll<HTMLButtonElement>("button")].every(button => button.hidden)).toBe(true);
  });
});
