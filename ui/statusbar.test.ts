// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import { StatusBar, type StatusBarPorts } from "./statusbar";

function mount() {
  const host = document.createElement("div");
  host.innerHTML = `
    <span id="st-mode"></span>
    <label id="st-delimiter" hidden>区切り <input id="st-delimiter-input" value="," /></label>
    <button id="st-pos"></button><span id="st-size"></span><button id="st-lines"></button>
    <button id="st-font"></button><button id="st-font-size"></button>
    <select id="st-indent"></select><button id="st-wrap"></button>
    <select id="st-source-enc"></select><span id="st-eol"></span><button id="st-theme"></button>
  `;
  document.body.replaceChildren(host);
  const ports: StatusBarPorts = {
    onGoTo: vi.fn(),
    onFontFamily: vi.fn(),
    onFontSize: vi.fn(),
    onWrap: vi.fn(),
    onIndent: vi.fn(),
    onPreviewDelimiter: vi.fn(),
    onReadEncoding: vi.fn(async () => true),
    onError: vi.fn(async () => {}),
  };
  return { host, ports, statusbar: new StatusBar(host, ports) };
}

describe("Feature: statusbar preview controls", () => {
  // Given: CSV区切り文字入力を持つステータスバー
  // When: CSV形式/Markdown形式を順に表示し、CSV区切り文字を入力する
  // Then: CSV時だけ入力欄を表示し、入力値をプレビュー更新ポートへ渡す
  it("Scenario: shows and forwards the CSV delimiter only for CSV preview", () => {
    const { host, ports, statusbar } = mount();
    const delimiter = host.querySelector<HTMLElement>("#st-delimiter")!;
    const input = host.querySelector<HTMLInputElement>("#st-delimiter-input")!;

    statusbar.setPreviewFormat("csv");
    expect(delimiter.hidden).toBe(false);
    input.value = "\\t";
    input.dispatchEvent(new Event("input"));
    expect(ports.onPreviewDelimiter).toHaveBeenCalledWith("\\t");

    statusbar.setPreviewFormat("markdown");
    expect(delimiter.hidden).toBe(true);
  });

  // Given: CSV区切り文字変更ポートが失敗する
  // When: 区切り文字を入力する
  // Then: DOMイベントからエラーを漏らさずエラーポートへ通知する
  it("Scenario: reports delimiter update failures through the error boundary", async () => {
    const { host, ports } = mount();
    ports.onPreviewDelimiter = vi.fn(async () => { throw new Error("preview failed"); });
    const input = host.querySelector<HTMLInputElement>("#st-delimiter-input")!;

    input.value = ";";
    input.dispatchEvent(new Event("input"));

    await vi.waitFor(() => expect(ports.onError).toHaveBeenCalledWith(
      "CSV区切り文字を変更できませんでした",
      expect.any(Error),
    ));
  });
});
