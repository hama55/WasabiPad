// @vitest-environment jsdom
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import indexHtml from "../index.html?raw";
import { INLINE_PREVIEW_MESSAGES as messages } from "./inline-preview-protocol";
import type { ViewerPayload } from "./api";
import { installDomStubs, settle } from "./test-doubles";

const text = "# outside\nselected one\nselected two\nnot selected";
vi.mock("./api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./api")>();
  const { fakeDocument } = await import("./test-doubles");
  return {
    ...actual,
    documentClient: fakeDocument("# outside\nselected one\nselected two\nnot selected").client,
    loadSettings: async () => "{}",
    updateSetting: async () => {},
    externalPreviewCleanupStale: async () => {},
    initialWindowRequest: async () => ({ secondary: false, path: "C:\\test.md" }),
    openPath: async () => ({
      kind: "text", line_count: 4, enc: "utf8", eol: "lf", path: "C:\\test.md",
      entries: null, folder_entries: null, folder_root: null, view_only: false,
      is_binary: false, byte_len: 58, is_huge: false, modified_at: null, effective_extension: null,
    }),
    loadBookmarks: async () => [],
    takePendingWindowRequests: async () => [],
    onExternalWindowRequest: async () => () => {},
    onDocumentLoadProgress: async () => () => {},
    onWorkspaceSearchBatch: async () => () => {},
    setInlinePreviewFocus: async () => {},
    pollExternal: async () => ({ kind: "unchanged" }),
  };
});
vi.mock("@tauri-apps/api/window", () => ({
  getCurrentWindow: () => ({
    onResized: async () => () => {}, onMoved: async () => () => {},
    onScaleChanged: async () => () => {}, onFocusChanged: async () => () => {},
    onCloseRequested: async () => () => {},
    isMaximized: async () => false, isMinimized: async () => false,
    setTitle: async () => {}, show: async () => {},
  }),
}));
vi.mock("@tauri-apps/api/webview", () => ({
  getCurrentWebview: () => ({ onDragDropEvent: async () => () => {} }),
}));
vi.mock("@tauri-apps/api/path", () => ({
  desktopDir: async () => "C:\\", tempDir: async () => "C:\\Temp",
  join: async (...parts: string[]) => parts.join("\\"),
}));
vi.mock("@tauri-apps/plugin-clipboard-manager", () => ({
  readText: async () => "", writeText: async () => {},
}));
installDomStubs();

describe("Feature: 明示的なプレビューは現在の行選択を表示する", () => {
  const payloads: ViewerPayload[] = [];
  let pendingClear: (() => void)[] | null = null;
  let mainWidth = 1400;
  let frame: HTMLIFrameElement;
  const button = () => document.querySelector<HTMLButtonElement>('button[data-preview-placement="right"]')!;
  const receive = (data: unknown) => window.dispatchEvent(new MessageEvent("message", {
    source: frame.contentWindow, origin: window.location.origin, data,
  }));
  const selectLines = async (lastY: number) => {
    document.querySelector<HTMLElement>(".ve-gutter")!.dispatchEvent(
      new MouseEvent("mousedown", { bubbles: true, button: 0, clientY: 25 }),
    );
    window.dispatchEvent(new MouseEvent("mousemove", { clientY: lastY }));
    window.dispatchEvent(new MouseEvent("mouseup"));
    await settle();
  };

  beforeAll(async () => {
    document.body.innerHTML = new DOMParser().parseFromString(indexHtml, "text/html").body.innerHTML;
    vi.spyOn(HTMLElement.prototype, "clientHeight", "get").mockReturnValue(800);
    vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockReturnValue(1400);
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (this: HTMLElement) {
      const top = this.classList.contains("ve-line") ? Number(this.dataset.line) * 20 : 0;
      return { x: 0, y: top, left: 0, top, right: 1400, bottom: top + 20, width: 1400, height: 20, toJSON: () => ({}) };
    });
    Object.defineProperty(document.getElementById("main"), "getBoundingClientRect", {
      value: () => ({ width: mainWidth, height: 800, left: 0, top: 0, right: mainWidth, bottom: 800 }),
    });
    await import("./main");
    frame = document.querySelector<HTMLIFrameElement>("#preview iframe")!;
    vi.spyOn(frame.contentWindow!, "postMessage").mockImplementation((data) => {
      if (data.type === messages.CLEAR_MESSAGE) {
        const acknowledge = () => receive({ type: messages.CLEARED_MESSAGE, render_id: data.render_id });
        if (pendingClear) pendingClear.push(acknowledge);
        else queueMicrotask(acknowledge);
      }
      if (data.type === messages.PAYLOAD_MESSAGE) payloads.push(data.payload);
    });
    receive({ type: messages.READY_MESSAGE });
    await vi.waitFor(() => expect(payloads.at(-1)?.text).toBe(text));
    await settle();
  });
  afterAll(() => {
    window.dispatchEvent(new Event("beforeunload"));
    vi.restoreAllMocks();
  });
  beforeEach(async () => {
    receive({ type: messages.CLOSE_MESSAGE, return_focus: false });
    await settle();
    expect(document.getElementById("preview")!.hidden).toBe(true);
    payloads.length = 0;
  });

  // Given: Markdownプレビューを明示的に閉じ、行番号のクリック／ドラッグで行を選択する
  // When: 右端ボタン／選択内の右クリックメニューで再度開く
  // Then: CLEAR完了後に選択行だけをプレビューへ渡す
  it.each([
    ["右端ボタン・単一行", "button", 25, "selected one\n"],
    ["右端ボタン・複数行", "button", 45, "selected one\nselected two\n"],
    ["右クリック・単一行", "menu", 25, "selected one\n"],
    ["右クリック・複数行", "menu", 45, "selected one\nselected two\n"],
  ] as const)("Scenario: 閉じた後も%sは選択した本文を表示する", async (_name, entry, lastY, expected) => {
    await selectLines(lastY);
    if (entry === "menu") {
      document.querySelector<HTMLElement>(".ve-gutter")!.dispatchEvent(
        new MouseEvent("contextmenu", { bubbles: true, clientY: 25 }),
      );
      [...document.querySelectorAll<HTMLElement>("#dropdown .dd-label")]
        .find((item) => item.textContent === "プレビュー")!.click();
    } else {
      button().click();
    }
    await vi.waitFor(() => expect(payloads.at(-1)).toMatchObject({ format: "markdown", text: expected }));
    await settle();
  });

  // Given: 選択プレビューを閉じ、本文の選択を解除している
  // When: 右端ボタンで再び開く
  // Then: 前回の選択範囲を再利用せず全文を表示する
  it("Scenario: 選択がなければ全文を表示する", async () => {
    document.querySelector<HTMLTextAreaElement>(".ve-input")!.dispatchEvent(
      new KeyboardEvent("keydown", { bubbles: true, key: "ArrowRight" }),
    );
    await settle();
    button().click();
    await vi.waitFor(() => expect(payloads.at(-1)?.text).toBe(text));
    await settle();
  });

  // Given: 行番号で2行目を選択し、旧プレビューの消去完了を待っている
  // When: 開く操作の後に選択を2〜3行目へ広げる
  // Then: 操作時点の2行目だけを表示する
  it("Scenario: 消去待ち中に選択が変わっても開いた時点の範囲を使う", async () => {
    await selectLines(25);
    pendingClear = [];
    button().click();
    await selectLines(45);
    const acknowledgements = pendingClear;
    pendingClear = null;
    acknowledgements.forEach((acknowledge) => acknowledge());
    await vi.waitFor(() => expect(payloads.at(-1)?.text).toBe("selected one\n"));
    await settle();
  });

  // Given: 選択プレビューを幅不足で自動退避し、行番号の選択を変更する
  // When: 右端ボタンで明示的に開く
  // Then: 退避前の本文を再送せず、新しく選択した行を表示する
  it("Scenario: 自動退避後の明示表示も現在の選択を使う", async () => {
    await selectLines(25);
    button().click();
    await vi.waitFor(() => expect(payloads.at(-1)?.text).toBe("selected one\n"));
    await settle();
    mainWidth = 300;
    window.dispatchEvent(new Event("resize"));
    await vi.waitFor(() => expect(document.getElementById("preview")!.hidden).toBe(true));
    await selectLines(45);
    payloads.length = 0;
    button().click();
    mainWidth = 1400;
    window.dispatchEvent(new Event("resize"));
    await vi.waitFor(() => expect(payloads.at(-1)?.text).toBe("selected one\nselected two\n"));
    await settle();
  });

  // Given: 選択した2行目のプレビューを表示し、エディタの選択を解除している
  // When: プレビュー側でCSV／HTMLへ形式を切り替える
  // Then: 明示的な再表示と区別し、表示中の範囲を保持する
  it.each(["csv", "html"])("Scenario: %sへの形式切替は表示中の範囲を保持する", async (format) => {
    await selectLines(25);
    button().click();
    await vi.waitFor(() => expect(payloads.at(-1)?.text).toBe("selected one\n"));
    await settle();
    document.querySelector<HTMLTextAreaElement>(".ve-input")!.dispatchEvent(
      new KeyboardEvent("keydown", { bubbles: true, key: "ArrowRight" }),
    );
    receive({ type: messages.FORMAT_CHANGE_MESSAGE, format });
    await vi.waitFor(() => expect(payloads.at(-1)).toMatchObject({ format, text: "selected one\n" }));
    await settle();
  });
});
