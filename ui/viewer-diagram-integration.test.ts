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
  invoke.mockImplementation(async (command: string, args: { entry?: string; path?: string }) => {
    if (command === "read_archive_asset") return args.entry?.endsWith(".svg") ? new TextEncoder().encode(svg).buffer : new Uint8Array([1, 2, 3]).buffer;
    if (command === "read_diagram_asset") return new Uint8Array([1, 2, 3]).buffer;
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

// Feature: Markdownプレビューからエディタのキャレット位置へ移動する
// Scenario: 画像をクリックして、その記法の先頭位置を親へ通知する
// Given: 行頭に文字を持つMarkdown画像のプレビュー
// When: プレビュー上の画像でマウスを離す
// Then: 画像記法の先頭位置を選択変更メッセージで通知する
it("Scenario: Markdown画像のクリック位置を選択変更メッセージで通知する", async () => {
  const source = "前 ![diagram](https://example.test/diagram.png) 後";
  window.dispatchEvent(new MessageEvent("message", { source: window.parent, origin: window.location.origin, data: {
    type: messages.PAYLOAD_MESSAGE,
    payload: { format: "markdown", text: source, selection: null, source_path: "C:\\notes\\memo.md", effective_extension: null, archive_path: null, archive_entry: null, external_output_path: null },
  } }));
  await vi.waitFor(() => expect(document.querySelector("article img")).not.toBeNull());

  const post = vi.spyOn(window.parent, "postMessage");
  document.querySelector<HTMLImageElement>("article img")!.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));

  expect(post).toHaveBeenCalledWith({
    type: messages.SELECTION_CHANGE_MESSAGE,
    selection: { start: { line: 0, col: 2 }, end: { line: 0, col: 2 } },
  }, window.location.origin);
});

// Feature: 編集図SVGの直接プレビュー
// Scenario: 通常ファイルのSVGから相対参照PNGを合成する
// Given: 共有背景参照を持つ編集図SVG
// When: SVG単体をプレビューする
// Then: PNGを読み、画像込みの表示用SVGを生成する
it("Scenario: 編集図SVGを直接開いても相対参照の背景を表示する", async () => {
  invoke.mockClear();
  window.dispatchEvent(new MessageEvent("message", { source: window.parent, origin: window.location.origin, data: {
    type: messages.PAYLOAD_MESSAGE,
    payload: { format: "image", text: svg, selection: null, source_path: "C:\\notes\\image_markdown\\memo\\diagram-0000.svg", effective_extension: null, archive_path: null, archive_entry: null, external_output_path: null },
  } }));
  await vi.waitFor(() => expect(invoke).toHaveBeenCalledWith("read_diagram_asset", { path: "C:\\notes\\image_markdown\\memo\\background.png", sourcePath: "C:\\notes\\image_markdown\\memo\\diagram-0000.svg" }));
  await vi.waitFor(() => expect(document.querySelector<HTMLImageElement>(".viewer-image")?.src).toBe("blob:diagram-preview"));
});

// Feature: アーカイブ内編集図SVGの直接プレビュー
// Scenario: SVGの親フォルダを基準に背景PNGを解決する
// Given: アーカイブ内の共有背景付き編集図
// When: SVG単体をプレビューする
// Then: 同じアーカイブフォルダのPNGを合成する
it("Scenario: アーカイブ内の編集図SVGを直接開いて背景を表示する", async () => {
  invoke.mockClear();
  window.dispatchEvent(new MessageEvent("message", { source: window.parent, origin: window.location.origin, data: {
    type: messages.PAYLOAD_MESSAGE,
    payload: { format: "image", text: svg, selection: null, source_path: null, effective_extension: null, archive_path: "book.zip", archive_entry: "notes/image_markdown/memo/diagram-0000.svg", external_output_path: null },
  } }));
  await vi.waitFor(() => expect(invoke).toHaveBeenCalledWith("read_archive_asset", { archivePath: "book.zip", cacheDirectory: null, entry: "notes/image_markdown/memo/background.png" }));
  await vi.waitFor(() => expect(document.querySelector<HTMLImageElement>(".viewer-image")?.src).toBe("blob:diagram-preview"));
});

// Feature: 編集図の非同期直接プレビュー
// Scenario: 背景読込中に別画像へ切り替える
// Given: 背景読込が保留中の編集図SVG
// When: 別画像のプレビューへ切り替えてから背景読込を完了する
// Then: 古い編集図が現在のプレビューを上書きしない
it("Scenario: SVGの背景読込中に切り替えた画像を維持する", async () => {
  const createObjectURL = vi.mocked(URL.createObjectURL);
  const revokeObjectURL = vi.mocked(URL.revokeObjectURL);
  createObjectURL.mockClear();
  createObjectURL.mockReturnValueOnce("blob:stale-diagram");
  revokeObjectURL.mockClear();
  let finishRead!: (bytes: ArrayBuffer) => void;
  invoke.mockImplementation((command: string, args: { entry?: string; path?: string }) => {
    if (command === "read_diagram_asset") return new Promise<ArrayBuffer>((resolve) => { finishRead = resolve; });
    if (command === "read_archive_asset") return args.entry?.endsWith(".svg") ? new TextEncoder().encode(svg).buffer : new Uint8Array([1, 2, 3]).buffer;
    return "{}";
  });
  window.dispatchEvent(new MessageEvent("message", { source: window.parent, origin: window.location.origin, data: {
    type: messages.PAYLOAD_MESSAGE,
    payload: { format: "image", text: svg, selection: null, source_path: "C:\\notes\\image_markdown\\memo\\diagram-0000.svg", effective_extension: null, archive_path: null, archive_entry: null, external_output_path: null },
  } }));
  await vi.waitFor(() => expect(finishRead).toBeTypeOf("function"));
  window.dispatchEvent(new MessageEvent("message", { source: window.parent, origin: window.location.origin, data: {
    type: messages.PAYLOAD_MESSAGE,
    payload: { format: "image", text: "", selection: null, source_path: "C:\\notes\\photo.png", effective_extension: null, archive_path: null, archive_entry: null, external_output_path: null },
  } }));
  await vi.waitFor(() => expect(document.querySelector<HTMLImageElement>(".viewer-image")?.src).toContain("photo.png"));
  finishRead(new Uint8Array([1, 2, 3]).buffer);
  await vi.waitFor(() => expect(revokeObjectURL).toHaveBeenCalledWith("blob:stale-diagram"));
  expect(createObjectURL).toHaveBeenCalledTimes(1);
  expect(document.querySelector<HTMLImageElement>(".viewer-image")?.src).toContain("photo.png");
});
