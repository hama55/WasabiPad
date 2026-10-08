// @vitest-environment jsdom
import { afterAll, beforeAll, expect, it, vi } from "vitest";
import viewerHtml from "../viewer.html?raw";
import { INLINE_PREVIEW_MESSAGES as messages } from "./inline-preview-protocol";
import { installDomStubs } from "./test-doubles";
import { writeDiagramSvg } from "./diagram";

const { invoke } = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke, convertFileSrc: (path: string) => path }));
installDomStubs();
const svg = writeDiagramSvg({ width: 100, height: 80, elements: [{ id: 1, kind: "image", src: "background.png", x: 0, y: 0, width: 100, height: 80 }] });

beforeAll(async () => {
  invoke.mockImplementation(async (command: string, args: { entry?: string }) => {
    if (command === "read_archive_asset") return args.entry?.endsWith(".svg") ? new TextEncoder().encode(svg).buffer : new Uint8Array([1, 2, 3]).buffer;
    return "{}";
  });
  vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:diagram-preview");
  vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => {});
  vi.spyOn(HTMLImageElement.prototype, "complete", "get").mockReturnValue(true);
  vi.spyOn(HTMLImageElement.prototype, "naturalWidth", "get").mockReturnValue(100);
  document.documentElement.innerHTML = viewerHtml.replace(/<!doctype html>/i, "");
  window.history.replaceState(null, "", "/viewer.html?inline=1");
  await import("./viewer");
});
afterAll(() => { window.dispatchEvent(new Event("beforeunload")); vi.restoreAllMocks(); });

// Feature: アーカイブ内の編集図表示
// Scenario: 通常ファイルパスなしで共有背景を合成する
// Given: アーカイブの Markdown と共有背景付き SVG
// When: プレビュー通知を受ける
// Then: SVG と背景を読み、メモリ内の合成画像を表示する
it("Scenario: source_path が null でもアーカイブの背景を表示する", async () => {
  window.dispatchEvent(new MessageEvent("message", { source: window.parent, origin: window.location.origin, data: {
    type: messages.PAYLOAD_MESSAGE,
    payload: { format: "markdown", text: '<img src="image_markdown/memo/diagram-123.svg">', selection: null, source_path: null, effective_extension: null, archive_path: "book.zip", archive_entry: "notes/memo.md", external_output_path: null },
  } }));
  await vi.waitFor(() => expect(invoke).toHaveBeenCalledWith("read_archive_asset", { archivePath: "book.zip", cacheDirectory: null, entry: "notes/image_markdown/memo/background.png" }));
  expect(document.querySelector<HTMLImageElement>("article img")?.src).toBe("blob:diagram-preview");
});
