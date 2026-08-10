import { describe, expect, it, vi } from "vitest";
import { createViewerFormatHandlers, isViewerFormat, viewerFormatForPath, viewerFormatSpec } from "./viewer-formats";
import { MENU_ICON } from "./menu-icons";

describe("Feature: viewer formats", () => {
  // Given: `report.CSV`、`notes.Markdown`、`photo.PNG`、`manual.PDF`、`manual.HTML`、`notes.txt`を指定
  // When: `viewerFormatForPath`を呼ぶ
  // Then: それぞれ`csv`、`markdown`、`image`、`pdf`、`html`、`null`
  it("Scenario: resolves registered extensions case-insensitively", () => {
    expect(viewerFormatForPath("report.CSV")).toBe("csv");
    expect(viewerFormatForPath("notes.Markdown")).toBe("markdown");
    expect(viewerFormatForPath("photo.PNG")).toBe("image");
    expect(viewerFormatForPath("manual.PDF")).toBe("pdf");
    expect(viewerFormatForPath("manual.HTML")).toBe("html");
    expect(viewerFormatForPath("notes.txt")).toBeNull();
  });

  // Given: csv/markdown/image/pdf/htmlの形式レジストリ
  // When: `viewerFormatSpec`を呼ぶ
  // Then: csvはdelimiter/chartとも`true`、markdown/imageはともに`false`
  it("Scenario: keeps format capabilities in the registry", () => {
    expect(viewerFormatSpec("csv").supportsDelimiter).toBe(true);
    expect(viewerFormatSpec("csv").supportsChart).toBe(true);
    expect(viewerFormatSpec("csv").iconClass).toBe(MENU_ICON.csv);
    expect(viewerFormatSpec("markdown").supportsDelimiter).toBe(false);
    expect(viewerFormatSpec("markdown").supportsChart).toBe(false);
    expect(viewerFormatSpec("image").supportsDelimiter).toBe(false);
    expect(viewerFormatSpec("image").supportsChart).toBe(false);
    expect(viewerFormatSpec("image").title).toBe("Image");
    expect(viewerFormatSpec("pdf").extensions).toEqual([".pdf"]);
    expect(viewerFormatSpec("html").extensions).toEqual([".html", ".htm"]);
    expect(viewerFormatSpec("html").supportsDelimiter).toBe(false);
    expect(viewerFormatSpec("html").supportsChart).toBe(false);
    expect(viewerFormatSpec("html").iconClass).toBe(MENU_ICON.html);
  });

  // Given: 形式レジストリに登録済みの`csv`/`markdown`/`image`/`pdf`/`html`と未登録の`unknown`
  // When: `isViewerFormat`を呼ぶ
  // Then: 登録済みだけをビュー形式として受け入れる
  it("Scenario: validates preview formats through the registry", () => {
    expect(isViewerFormat("csv")).toBe(true);
    expect(isViewerFormat("markdown")).toBe(true);
    expect(isViewerFormat("image")).toBe(true);
    expect(isViewerFormat("pdf")).toBe(true);
    expect(isViewerFormat("html")).toBe(true);
    expect(isViewerFormat("unknown")).toBe(false);
    expect(isViewerFormat(null)).toBe(false);
  });

  // Given: csv/markdown/image/pdf/html用のrenderer mockを登録
  // When: `createViewerFormatHandlers`を呼ぶ
  // Then: 各形式の`render`はmock、markdownのlabelは`Markdownビュー`
  it("Scenario: combines metadata and renderers through one typed registry", () => {
    const csvRenderer = vi.fn();
    const markdownRenderer = vi.fn();
    const imageRenderer = vi.fn();
    const pdfRenderer = vi.fn();
    const htmlRenderer = vi.fn();
    const handlers = createViewerFormatHandlers({
      csv: csvRenderer, markdown: markdownRenderer, image: imageRenderer, pdf: pdfRenderer, html: htmlRenderer,
    });

    expect(handlers.csv.render).toBe(csvRenderer);
    expect(handlers.markdown.label).toBe("Markdownビュー");
    expect(handlers.image.render).toBe(imageRenderer);
    expect(handlers.pdf.render).toBe(pdfRenderer);
    expect(handlers.html.render).toBe(htmlRenderer);
    expect(handlers.csv.title).toBe("CSV");
    expect(handlers.markdown.title).toBe("Markdown");
  });
});
