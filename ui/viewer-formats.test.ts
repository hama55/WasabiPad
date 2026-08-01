import { describe, expect, it, vi } from "vitest";
import { createViewerFormatHandlers, viewerFormatForPath, viewerFormatSpec } from "./viewer-formats";

describe("viewer formats", () => {
  it("resolves registered extensions case-insensitively", () => {
    expect(viewerFormatForPath("report.CSV")).toBe("csv");
    expect(viewerFormatForPath("notes.Markdown")).toBe("markdown");
    expect(viewerFormatForPath("notes.txt")).toBeNull();
  });

  it("keeps format capabilities in the registry", () => {
    expect(viewerFormatSpec("csv").supportsDelimiter).toBe(true);
    expect(viewerFormatSpec("csv").supportsChart).toBe(true);
    expect(viewerFormatSpec("markdown").supportsDelimiter).toBe(false);
    expect(viewerFormatSpec("markdown").supportsChart).toBe(false);
  });

  it("combines metadata and renderers through one typed registry", () => {
    const csvRenderer = vi.fn();
    const markdownRenderer = vi.fn();
    const handlers = createViewerFormatHandlers({ csv: csvRenderer, markdown: markdownRenderer });

    expect(handlers.csv.render).toBe(csvRenderer);
    expect(handlers.markdown.label).toBe("Markdownビュー");
  });
});
