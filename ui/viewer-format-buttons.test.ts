// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import viewerHtml from "../viewer.html?raw";
import type { ViewerFormat } from "./api";
import { createViewerChartMenuItem, createViewerDelimiterMenuItem } from "./viewer-context-menu";
import { createViewerFormatButtons, syncViewerActionButtons, syncViewerFormatButtons } from "./viewer-format-buttons";
import { createViewerDelimiterControl } from "./viewer-delimiter-control";
import { createHtmlPreview } from "./viewer-html";

describe("Feature: viewer format select", () => {
  // Feature: 表示形式候補のプレビューと確定
  // Scenario: 候補を移動したときはプレビューだけを通知し、changeで確定する
  // Given: 表示形式プルダウンとプレビュー・確定それぞれの通知先
  // When: 候補移動のinputと選択確定のchangeを順に発生させる
  // Then: inputはプレビュー通知だけ、changeは確定通知だけを呼び出す
  it("Scenario: 候補移動と選択確定の通知を分離する", () => {
    const host = document.createElement("select");
    const onPreview = vi.fn();
    const onSelect = vi.fn();
    createViewerFormatButtons(host, { onPreview, onSelect });

    host.value = "html";
    host.dispatchEvent(new Event("input", { bubbles: true }));

    expect(onPreview).toHaveBeenCalledWith("html");
    expect(onSelect).not.toHaveBeenCalled();

    host.dispatchEvent(new Event("change", { bubbles: true }));

    expect(onPreview).toHaveBeenCalledTimes(1);
    expect(onSelect).toHaveBeenCalledWith("html");
  });

  // Feature: 表示形式候補のホバー即時プレビュー
  // Scenario: プルダウン候補へカーソルを当てる
  // Given: 表示形式候補とプレビュー通知先がある
  // When: html候補へpointeroverを発生させる
  // Then: changeを待たずhtmlのプレビュー通知だけを呼び出す
  it("Scenario: 候補へカーソルを当てた時点で表示形式をプレビューする", () => {
    const host = document.createElement("select");
    const onPreview = vi.fn();
    const onSelect = vi.fn();
    createViewerFormatButtons(host, { onPreview, onSelect });
    const htmlOption = [...host.options].find((option) => option.value === "html")!;

    htmlOption.dispatchEvent(new MouseEvent("pointerover", { bubbles: true }));

    expect(onPreview).toHaveBeenCalledWith("html");
    expect(onSelect).not.toHaveBeenCalled();
  });

  // Given: 表示形式プルダウンの置き場と5形式の選択通知
  // When: プルダウンを生成して5形式を順に選ぶ
  // Then: レジストリの表示順markdown→csv→image→pdf→html(静的)で表示し、各形式を通知する
  it("Scenario: 表示形式をプルダウンから選択する", () => {
    const host = document.createElement("select");
    const onSelect = vi.fn();
    createViewerFormatButtons(host, onSelect);

    const options = [...host.querySelectorAll<HTMLOptionElement>("option")];
    expect(options.map((option) => option.textContent)).toEqual([
      "markdown", "csv", "image", "pdf", "html(静的)",
    ]);
    expect(options.map((option) => option.value)).toEqual([
      "markdown", "csv", "image", "pdf", "html",
    ]);
    options.forEach((option) => {
      host.value = option.value;
      host.dispatchEvent(new Event("change", { bubbles: true }));
    });
    expect(onSelect.mock.calls).toEqual([
      ["markdown"], ["csv"], ["image"], ["pdf"], ["html"],
    ]);

    syncViewerFormatButtons(host, "csv");
    expect(host.value).toBe("csv");
    expect(options[1].getAttribute("aria-selected")).toBe("true");
    expect(options[0].getAttribute("aria-selected")).toBe("false");
  });

  // Given: markdownファイルを表示中
  // When: 形式プルダウンの利用可能状態を同期する
  // Then: テキスト形式は選べるがimage/pdfは選べない
  it("Scenario: データに対応しない形式をプルダウンで無効にする", () => {
    const host = document.createElement("select");
    createViewerFormatButtons(host, vi.fn<(format: ViewerFormat) => void>());

    syncViewerFormatButtons(host, "markdown", "notes.md");

    expect(host.querySelector<HTMLOptionElement>("[data-viewer-format='markdown']")?.disabled).toBe(false);
    expect(host.querySelector<HTMLOptionElement>("[data-viewer-format='csv']")?.disabled).toBe(false);
    expect(host.querySelector<HTMLOptionElement>("[data-viewer-format='image']")?.disabled).toBe(true);
    expect(host.querySelector<HTMLOptionElement>("[data-viewer-format='pdf']")?.disabled).toBe(true);
    expect(host.querySelector<HTMLOptionElement>("[data-viewer-format='image']")?.getAttribute("aria-disabled")).toBe("true");
  });

  // Given: viewer.htmlのタイトルバー
  // When: 表示形式コントロールのDOMを確認する
  // Then: タイトルバーはネイティブselectを持つ
  it("Scenario: タイトルバーは表示形式プルダウンを使う", () => {
    expect(viewerHtml).toContain('<select id="viewer-format" aria-label="表示形式"></select>');
    expect(viewerHtml).not.toContain('<div id="viewer-format" role="group"');
  });

  // Feature: CSV区切り文字プルダウン
  // Scenario: 代表的な区切り文字と自由形式を切り替える
  // Given: CSV区切り文字コントロールと変更通知
  // When: プリセットと自由形式を順に選び、自由形式を入力する
  // Then: 自由形式のときだけ入力欄を表示し、選択値を通知する
  it("Scenario: CSV区切り文字をプリセットと自由形式から選択する", () => {
    const select = document.createElement("select");
    const input = document.createElement("input");
    const onChange = vi.fn();
    createViewerDelimiterControl(select, input, ",", onChange);

    expect([...select.options].map((option) => option.textContent)).toEqual([
      ",（カンマ）", "\\t=タブ", ";（セミコロン）", "|（パイプ）", "自由形式",
    ]);
    expect(input.hidden).toBe(true);

    select.value = "\\t";
    select.dispatchEvent(new Event("change", { bubbles: true }));
    expect(input.hidden).toBe(true);
    expect(onChange).toHaveBeenLastCalledWith("\\t");

    select.value = "__custom__";
    select.dispatchEvent(new Event("change", { bubbles: true }));
    expect(input.hidden).toBe(false);
    expect(onChange).toHaveBeenCalledTimes(1);

    input.value = "::";
    input.dispatchEvent(new Event("input", { bubbles: true }));
    expect(onChange).toHaveBeenLastCalledWith("::");
  });

  // Given: 表示形式コントロールとHTMLプレビュー
  // When: html(静的)を選択して本文をiframeへ渡す
  // Then: HTML本文がiframeのsrcdocに残り、HTMLプレビューとして描画対象になる
  it("Scenario: html(静的)選択後もHTML本文を確実に描画する", () => {
    const select = document.createElement("select");
    const onSelect = vi.fn();
    createViewerFormatButtons(select, onSelect);
    select.value = "html";
    select.dispatchEvent(new Event("change", { bubbles: true }));

    const { wrapper, frame } = createHtmlPreview({
      name: "index.html",
      html: "<main><h1>表示確認</h1></main>",
      baseUrl: null,
      onContextMenu: () => undefined,
    });
    document.body.appendChild(wrapper);

    expect(onSelect).toHaveBeenCalledWith("html");
    expect(frame.srcdoc).toContain("<h1>表示確認</h1>");
    expect(wrapper.querySelector("iframe.viewer-html")).toBe(frame);
  });

  // Feature: CSV操作の右上ボタン
  // Scenario: CSV表示中だけ区切り文字変更とグラフ作成を表示する
  // Given: 2つのCSV操作ボタンを持つタイトルバー
  // When: 表示形式をCSVからMarkdownへ切り替える
  // Then: CSVでは2ボタンを表示し、Markdownでは操作領域ごと非表示にする
  it("Scenario: CSV形式のときだけ2つの操作ボタンを表示する", () => {
    const host = document.createElement("div");
    const onDelimiter = vi.fn();
    const onChart = vi.fn();
    host.replaceChildren(createViewerDelimiterMenuItem(onDelimiter), createViewerChartMenuItem(onChart));

    syncViewerActionButtons(host, "csv");
    expect(host.hidden).toBe(false);
    expect([...host.querySelectorAll<HTMLButtonElement>("button")].every((button) => !button.hidden)).toBe(true);
    expect(host.textContent).toContain("区切り文字を変更...");
    expect(host.textContent).toContain("グラフを作成...");
    expect(viewerHtml).toContain('<div id="viewer-csv-actions" role="group" aria-label="CSV操作" hidden></div>');
    host.querySelector<HTMLButtonElement>("[data-viewer-action='delimiter']")!.click();
    host.querySelector<HTMLButtonElement>("[data-viewer-action='chart']")!.click();
    expect(onDelimiter).toHaveBeenCalledOnce();
    expect(onChart).toHaveBeenCalledOnce();

    syncViewerActionButtons(host, "markdown");
    expect(host.hidden).toBe(true);
    expect([...host.querySelectorAll<HTMLButtonElement>("button")].every((button) => button.hidden)).toBe(true);
  });
});
