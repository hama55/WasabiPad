import { describe, expect, it, vi } from "vitest";
import { createViewerFormatHandlers, viewerFormatForPath, viewerFormatSpec } from "./viewer-formats";
import { MENU_ICON } from "./menu-icons";

describe("Feature: viewer formats", () => {
  // Given: `report.CSV`、`notes.Markdown`、`notes.txt`を指定
  // When: `viewerFormatForPath`を呼ぶ
  // Then: それぞれ`csv`、`markdown`、`null`
  it("Scenario: resolves registered extensions case-insensitively", () => {
    expect(viewerFormatForPath("report.CSV")).toBe("csv");
    expect(viewerFormatForPath("notes.Markdown")).toBe("markdown");
    expect(viewerFormatForPath("notes.txt")).toBeNull();
  });

  // Given: csv/markdownの形式レジストリ
  // When: `viewerFormatSpec`を呼ぶ
  // Then: csvはdelimiter/chartとも`true`、markdownはともに`false`
  it("Scenario: keeps format capabilities in the registry", () => {
    expect(viewerFormatSpec("csv").supportsDelimiter).toBe(true);
    expect(viewerFormatSpec("csv").supportsChart).toBe(true);
    expect(viewerFormatSpec("csv").iconClass).toBe(MENU_ICON.csv);
    expect(viewerFormatSpec("markdown").supportsDelimiter).toBe(false);
    expect(viewerFormatSpec("markdown").supportsChart).toBe(false);
  });

  // Given: csv/markdown用のrenderer mockを登録
  // When: `createViewerFormatHandlers`を呼ぶ
  // Then: csvの`render`はmock、markdownのlabelは`Markdownビュー`
  it("Scenario: combines metadata and renderers through one typed registry", () => {
    const csvRenderer = vi.fn();
    const markdownRenderer = vi.fn();
    const handlers = createViewerFormatHandlers({ csv: csvRenderer, markdown: markdownRenderer });

    expect(handlers.csv.render).toBe(csvRenderer);
    expect(handlers.markdown.label).toBe("Markdownビュー");
  });
});
