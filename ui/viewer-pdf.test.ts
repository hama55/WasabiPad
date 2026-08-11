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
