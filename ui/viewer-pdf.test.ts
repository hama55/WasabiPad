// @vitest-environment jsdom

import { describe, expect, it } from "vitest";
import { createPdfPreview, markPdfLoadFailure } from "./viewer-pdf";

describe("Feature: PDF viewer", () => {
  // Given: a PDF file name
  // When: a PDF preview is created
  // Then: an iframe is placed in the preview wrapper
  it("Scenario: creates a PDF iframe preview", () => {
    const { wrapper, frame } = createPdfPreview("manual.pdf");

    expect(wrapper.className).toBe("viewer-pdf-wrap");
    expect(frame.className).toBe("viewer-pdf");
    expect(frame.title).toBe("manual.pdf");
    expect(wrapper.querySelector("iframe")).toBe(frame);
  });

  // Feature: 設計外検索の標準動作抑止
  // Scenario: PDFプレビューのCtrl-Fで標準検索を起動しない
  // Given: PDFプレビューのiframe
  // When: iframeへCtrl-Fイベントを送る
  // Then: iframeの既定検索動作を抑止する
  it("Scenario: PDFプレビュー内のCtrl-Fを標準検索へ漏らさない", () => {
    const { frame } = createPdfPreview("manual.pdf");
    const child = document.implementation.createHTMLDocument("pdf-preview");
    Object.defineProperty(frame, "contentDocument", { configurable: true, value: child });
    frame.dispatchEvent(new Event("load"));
    const event = new KeyboardEvent("keydown", { key: "f", ctrlKey: true, cancelable: true });

    child.dispatchEvent(event);

    expect(event.defaultPrevented).toBe(true);
  });

  // Given: a PDF iframe whose load failed
  // When: the failure state is marked
  // Then: the source is removed and the title reports the failure
  it("Scenario: marks a PDF load failure", () => {
    const { frame } = createPdfPreview("manual.pdf");
    frame.src = "asset://manual.pdf";

    markPdfLoadFailure(frame, "manual.pdf");

    expect(frame.getAttribute("src")).toBeNull();
    expect(frame.title).toBe("manual.pdf (load failed)");
  });
});
