// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";

const { readClipboardText, writeClipboardText } = vi.hoisted(() => ({
  readClipboardText: vi.fn(async () => ""),
  writeClipboardText: vi.fn(async () => {}),
}));
vi.mock("@tauri-apps/plugin-clipboard-manager", () => ({
  readText: readClipboardText,
  writeText: writeClipboardText,
}));
const { loadSettings, updateSetting } = vi.hoisted(() => ({
  loadSettings: vi.fn(async () => "{}"),
  updateSetting: vi.fn(async () => {}),
}));
vi.mock("./api", async (importOriginal) => ({
  ...await importOriginal<typeof import("./api")>(),
  loadSettings,
  updateSetting,
}));
import { fakeDocument, installDomStubs, settle } from "./test-doubles";
import { VirtualEditor, type EditorPorts } from "./editor";
import { initSettings } from "./settings";
import type { RegisteredCommandMenuPorts } from "./registered-command-menu";

installDomStubs();

function mount(
  initial: string,
  saveImage?: EditorPorts["saveImage"],
  overrides: Partial<Pick<EditorPorts, "revealInExplorer" | "getExternalFilePath" | "registeredCommandPorts">> = {},
) {
  const host = document.createElement("div");
  document.body.replaceChildren(host);
  const doc = fakeDocument(initial);
  const events = {
    lineCount: 0,
    cursor: [0, 0] as [number, number],
    errors: [] as { message: string; error: unknown }[],
  };
  const ports: EditorPorts = {
    onDocChange: (lineCount) => { events.lineCount = lineCount; },
    onCursor: (line, col) => { events.cursor = [line, col]; },
    onFontChange: () => {},
    getExternalFilePath: overrides.getExternalFilePath ?? (() => null),
    openExternally: () => {},
    revealInExplorer: overrides.revealInExplorer,
    registeredCommandPorts: overrides.registeredCommandPorts ?? {
      promptFields: async () => null,
      runExternalCommand: async () => {},
    },
    onError: async (message, error) => { events.errors.push({ message, error }); },
    openViewer: async () => null,
    updateViewer: async () => true,
    saveImage,
  };
  const editor = new VirtualEditor(host, ports, undefined, doc.client);
  const input = host.querySelector<HTMLTextAreaElement>(".ve-input")!;
  const type = (value: string) => {
    input.value = value;
    input.dispatchEvent(new InputEvent("input"));
  };
  const press = (key: string, options: KeyboardEventInit = {}) =>
    input.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true, ...options }));
  return { editor, doc, events, host, input, type, press };
}

describe("VirtualEditor", () => {
  beforeEach(async () => {
    document.body.replaceChildren();
    loadSettings.mockResolvedValue("{}");
    updateSetting.mockReset();
    updateSetting.mockResolvedValue(undefined);
    await initSettings();
    readClipboardText.mockReset();
    readClipboardText.mockResolvedValue("");
    writeClipboardText.mockReset();
    writeClipboardText.mockResolvedValue(undefined);
  });

  it("注入された DocumentClient から可視行を取得する", async () => {
    const { editor, doc } = mount("one\ntwo\nthree");
    editor.open(3, false);
    await settle();
    expect(doc.calls.some((call) => call.startsWith("lines("))).toBe(true);
  });

  it("入力は backend の edit へ委譲され、行数変化が通知される", async () => {
    const { editor, doc, events, host, type } = mount("ab");
    editor.open(1, false);
    await settle();
    const line = host.querySelector(".ve-line");
    const gutterRow = host.querySelector(".ve-gnum");
    const lineFetches = doc.calls.filter((call) => call.startsWith("lines(")).length;
    type("X");
    await settle();
    expect(doc.text()).toBe("Xab");
    expect(host.querySelector(".ve-line")).toBe(line);
    expect(host.querySelector(".ve-gnum")).toBe(gutterRow);
    expect(doc.calls.filter((call) => call.startsWith("lines("))).toHaveLength(lineFetches);
    type("\n");
    await settle();
    expect(doc.text()).toBe("X\nab");
    expect(events.lineCount).toBe(2);
  });

  it("IME確定文字は backend 反映まで表示を保持する", async () => {
    const { editor, doc, host, input } = mount("ab");
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const edit = doc.client.edit;
    doc.client.edit = async (...args) => {
      await gate;
      return edit(...args);
    };
    editor.open(1, false);
    await settle();

    input.dispatchEvent(new CompositionEvent("compositionstart"));
    input.value = "漢字";
    input.dispatchEvent(new InputEvent("input", { isComposing: true }));
    input.dispatchEvent(new CompositionEvent("compositionend"));

    expect(host.querySelector(".ve-ime-commit")?.textContent).toBe("漢字");
    expect(input.value).toBe("");
    release();
    await settle();
    expect(host.querySelector(".ve-ime-commit")).toBeNull();
    expect(doc.text()).toBe("漢字ab");
  });

  it("閲覧専用なら編集系の呼び出しを一切出さない", async () => {
    const { editor, doc, type, press } = mount("ab");
    editor.open(1, true);
    await settle();
    type("X");
    press("Backspace");
    press("Delete");
    press("Enter");
    await settle();
    expect(doc.text()).toBe("ab");
    expect(doc.calls.filter((call) => call.startsWith("edit"))).toEqual([]);
  });

  it("改行時に現在行の先頭タブを引き継ぐ", async () => {
    const { editor, doc, press } = mount("\t\tmemo");
    editor.open(1, false);
    await settle();
    editor.goTo(0, 6);

    press("Enter");
    await settle();

    expect(doc.text()).toBe("\t\tmemo\n\t\t");
  });

  it("複数行選択中のTabは各行の先頭へタブを挿入する", async () => {
    const { editor, doc, press } = mount("one\ntwo\nthree");
    editor.open(3, false);
    await settle();
    await editor.restoreViewState({
      anchor: { line: 0, col: 1 },
      caret: { line: 1, col: 1 },
      topLine: 0,
      wrapIntraLinePx: 0,
      scrollLeft: 0,
    });

    press("Tab");
    await settle();

    expect(doc.text()).toBe("\tone\n\ttwo\nthree");
    expect(doc.calls).toContain("editMany(2)");
  });

  it("キー編集失敗を通知し、次の編集queueは継続する", async () => {
    const { doc, editor, events, press, type } = mount("abc");
    editor.open(1, false);
    await settle();
    vi.spyOn(doc.client, "edit").mockRejectedValueOnce(new Error("ipc failed"));

    press("Enter");
    await vi.waitFor(() => expect(events.errors).toHaveLength(1));
    type("x");
    await vi.waitFor(() => expect(doc.text()).toContain("x"));

    expect(events.errors[0].message).toBe("編集を反映できませんでした");
  });

  it("Clipboard失敗をイベント境界で通知する", async () => {
    const { editor, events, press } = mount("abc");
    editor.open(1, false);
    await settle();
    writeClipboardText.mockRejectedValueOnce(new Error("denied"));
    press("a", { ctrlKey: true });
    await settle();

    press("c", { ctrlKey: true });
    await vi.waitFor(() => expect(events.errors).toHaveLength(1));

    expect(events.errors[0].message).toBe("クリップボードへコピーできませんでした");
  });

  it("画像の貼り付けで相対リンク付きタグを挿入する", async () => {
    const saveImage = vi.fn(async () => "image_markdown/memo/pasted-image.png");
    const { editor, doc, input } = mount("memo", saveImage);
    editor.open(1, false);
    await settle();
    const image = new Blob([new Uint8Array([1, 2, 3])], { type: "image/png" });
    const event = new Event("paste", { bubbles: true, cancelable: true });
    Object.defineProperty(event, "clipboardData", {
      value: { items: [{ type: "image/png", getAsFile: () => image }] },
    });

    input.dispatchEvent(event);
    await settle();

    expect(event.defaultPrevented).toBe(true);
    expect(saveImage).toHaveBeenCalledWith([1, 2, 3], "image/png");
    expect(doc.text()).toContain("<img src=\"image_markdown/memo/pasted-image.png\" alt=\"貼り付け画像\" width=\"900\">");
  });

  it("保存済みメモの右クリックから格納フォルダを開く", async () => {
    const revealInExplorer = vi.fn();
    const { editor, host } = mount("memo", undefined, {
      getExternalFilePath: () => "C:\\work\\memo.txt",
      revealInExplorer,
    });
    const dropdown = document.createElement("div");
    dropdown.id = "dropdown";
    document.body.appendChild(dropdown);
    editor.open(1, false);
    await settle();

    host.querySelector<HTMLElement>(".ve-scroll")!.dispatchEvent(
      new MouseEvent("contextmenu", { bubbles: true, clientX: 0, clientY: 0 }),
    );
    const item = [...dropdown.querySelectorAll<HTMLElement>(".dd-item")]
      .find((element) => element.textContent === "エクスプローラで開く");
    item?.click();

    expect(revealInExplorer).toHaveBeenCalledTimes(1);
  });

  it("メモビューの登録コマンドへ選択文字列を渡す", async () => {
    const promptFields = vi.fn(async () => ["ブラウザ", "", "open {file}"]);
    const runExternalCommand = vi.fn(async () => {});
    const registeredCommandPorts: RegisteredCommandMenuPorts = { promptFields, runExternalCommand };
    const { editor, host, events } = mount("https://example.com", undefined, {
      getExternalFilePath: () => "C:\\work\\memo.txt",
      registeredCommandPorts,
    });
    const dropdown = document.createElement("div");
    dropdown.id = "dropdown";
    document.body.appendChild(dropdown);
    editor.open(1, false);
    await editor.restoreViewState({
      anchor: { line: 0, col: 0 },
      caret: { line: 0, col: 19 },
      topLine: 0,
      wrapIntraLinePx: 0,
      scrollLeft: 0,
    });

    const showContextMenu = () => host.querySelector<HTMLElement>(".ve-scroll")!.dispatchEvent(
      new MouseEvent("contextmenu", { bubbles: true, clientX: 0, clientY: 0 }),
    );
    showContextMenu();
    expect([...dropdown.querySelectorAll<HTMLElement>(".dd-label")].map((item) => item.textContent))
      .toContain("コマンドを登録...");
    [...dropdown.querySelectorAll<HTMLElement>(".dd-item")]
      .find((item) => item.textContent === "コマンドを登録...")!.click();

    await vi.waitFor(() => expect(promptFields).toHaveBeenCalled());
    const fields = (promptFields.mock.calls[0] as unknown as [string, { label: string }[]])[1];
    expect(fields[2].label).toContain("対象文字列");

    showContextMenu();
    [...dropdown.querySelectorAll<HTMLElement>(".dd-item")]
      .find((item) => item.textContent === "登録コマンド ▸")!.click();
    const commandItem = dropdown.querySelector<HTMLElement>(".dd-submenu .dd-item");
    commandItem?.click();

    await vi.waitFor(() => expect(runExternalCommand).toHaveBeenCalledWith(
      'open "https://example.com"',
      "C:\\work\\memo.txt",
    ));

    runExternalCommand.mockRejectedValueOnce(new Error("command failed"));
    showContextMenu();
    [...dropdown.querySelectorAll<HTMLElement>(".dd-item")]
      .find((item) => item.textContent === "登録コマンド ▸")!.click();
    dropdown.querySelector<HTMLElement>(".dd-submenu .dd-item")!.click();
    await vi.waitFor(() => expect(events.errors).toContainEqual({
      message: "登録コマンドを実行できませんでした",
      error: expect.any(Error),
    }));
  });

  it("goTo はキャレット位置を1始まりで通知する", async () => {
    const { editor, events } = mount("one\ntwo");
    editor.open(2, false);
    await settle();
    editor.goTo(1, 2);
    await settle();
    expect(events.cursor).toEqual([2, 3]);
  });

  it("goTo も対象行をメモビューの中央へ置く", async () => {
    const { editor, host } = mount(Array.from({ length: 40 }, (_, i) => `line ${i}`).join("\n"));
    const scroll = host.querySelector<HTMLElement>(".ve-scroll")!;
    Object.defineProperty(scroll, "clientHeight", { configurable: true, value: 100 });
    editor.open(40, false);

    editor.goTo(20, 0);

    expect(editor.captureViewState().topLine).toBe(18);
    expect(scroll.scrollTop).toBe(360);
  });

  it("表示領域の最下行で改行すると新しいキャレット行へ自動スクロールする", async () => {
    const { editor, host, press } = mount(Array.from({ length: 40 }, (_, i) => `line ${i}`).join("\n"));
    const scroll = host.querySelector<HTMLElement>(".ve-scroll")!;
    Object.defineProperty(scroll, "clientHeight", { configurable: true, value: 100 });
    editor.open(40, false);
    await editor.restoreViewState({
      anchor: { line: 6, col: 6 },
      caret: { line: 6, col: 6 },
      topLine: 2,
      wrapIntraLinePx: 0,
      scrollLeft: 0,
    });

    press("Enter");
    await settle();

    expect(editor.captureViewState().caret).toEqual({ line: 7, col: 0 });
    expect(editor.captureViewState().topLine).toBe(3);
    expect(scroll.scrollTop).toBe(60);
  });

  it("文書末尾で改行文字を連続入力しても常に入力行を表示する", async () => {
    const { editor, host, type } = mount("start");
    const scroll = host.querySelector<HTMLElement>(".ve-scroll")!;
    Object.defineProperty(scroll, "clientHeight", { configurable: true, value: 100 });
    editor.open(1, false);

    for (let i = 0; i < 8; i += 1) {
      type("\n");
      await settle();
    }

    expect(editor.captureViewState().caret).toEqual({ line: 8, col: 0 });
    expect(editor.captureViewState().topLine).toBe(4);
    expect(scroll.scrollTop).toBe(80);
  });

  it("検索結果の範囲選択は対象行をメモビューの中央へ置く", async () => {
    const { editor, host } = mount(Array.from({ length: 40 }, (_, i) => `line ${i}`).join("\n"));
    const scroll = host.querySelector<HTMLElement>(".ve-scroll")!;
    Object.defineProperty(scroll, "clientHeight", { configurable: true, value: 100 });
    editor.open(40, false);

    await editor.selectRange(20, 0, 4);

    expect(editor.captureViewState().topLine).toBe(18);
    expect(scroll.scrollTop).toBe(360);
  });

  it.each([
    ["次へ", true],
    ["前へ", false],
  ])("本文検索の%s結果は対象行をメモビューの中央へ置く", async (_label, forward) => {
    const { editor, doc, host } = mount(Array.from({ length: 40 }, (_, i) => `line ${i}`).join("\n"));
    const scroll = host.querySelector<HTMLElement>(".ve-scroll")!;
    Object.defineProperty(scroll, "clientHeight", { configurable: true, value: 100 });
    editor.open(40, false);
    await settle();

    const result = { start: { line: 20, col: 0 }, end: { line: 20, col: 7 } };
    if (forward) doc.client.findStep = async () => ({ kind: "Found", ...result });
    else doc.client.find = async () => result;

    editor.openSearch();
    const findIn = host.querySelector<HTMLInputElement>(".ve-find-in")!;
    findIn.value = "line 20";
    findIn.dispatchEvent(new KeyboardEvent("keydown", {
      key: "Enter",
      shiftKey: !forward,
      bubbles: true,
    }));
    await settle();

    expect(editor.captureViewState().topLine).toBe(18);
    expect(scroll.scrollTop).toBe(360);
  });

  it("文書切替中に保留された本文検索結果を新しい文書へ適用しない", async () => {
    const { editor, doc, host } = mount(Array.from({ length: 40 }, (_, i) => `old ${i}`).join("\n"));
    let release!: () => void;
    const blocked = new Promise<void>((resolve) => { release = resolve; });
    doc.client.findStep = async () => {
      await blocked;
      return { kind: "Found", start: { line: 20, col: 0 }, end: { line: 20, col: 5 } };
    };
    const scroll = host.querySelector<HTMLElement>(".ve-scroll")!;
    Object.defineProperty(scroll, "clientHeight", { configurable: true, value: 100 });
    editor.open(40, false);
    editor.openSearch();
    const findIn = host.querySelector<HTMLInputElement>(".ve-find-in")!;
    findIn.value = "old 20";
    findIn.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    await settle(1);
    editor.open(1, false);
    release();

    await settle();

    expect(editor.captureViewState().caret).toEqual({ line: 0, col: 0 });
    expect(editor.captureViewState().topLine).toBe(0);
  });

  it("本文検索に失敗した後、連続置換が直前の一致を再利用しない", async () => {
    const { editor, doc, host } = mount("needle");
    let failed = false;
    doc.client.findStep = async () => {
      if (failed) throw new Error("find failed");
      return { kind: "Found", start: { line: 0, col: 0 }, end: { line: 0, col: 6 } };
    };
    editor.open(1, false);
    await settle();

    editor.openSearch();
    const findIn = host.querySelector<HTMLInputElement>(".ve-find-in")!;
    findIn.value = "needle";
    findIn.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    await settle();

    failed = true;
    findIn.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    await settle();
    host.querySelector<HTMLInputElement>(".ve-rep-in")!.value = "changed";
    host.querySelector<HTMLButtonElement>(".ve-rep-next")!.click();
    await settle();

    expect(doc.calls.filter((call) => call.startsWith("edit(")).length).toBe(0);
  });

  it("文書切替中に保留された古い検索結果を新しい文書へ適用しない", async () => {
    const { editor, doc } = mount(Array.from({ length: 40 }, (_, i) => `old ${i}`).join("\n"));
    const originalLines = doc.client.lines;
    let release!: () => void;
    const blocked = new Promise<void>((resolve) => { release = resolve; });
    doc.client.lines = async (...args) => {
      await blocked;
      return originalLines(...args);
    };

    editor.open(40, false);
    const selecting = editor.selectRange(20, 0, 3);
    editor.open(1, false);
    release();
    await selecting;

    expect(editor.captureViewState().caret).toEqual({ line: 0, col: 0 });
  });

  it("スクロール直後のIME入力位置を表示領域内へ維持する", async () => {
    const { editor, host, input } = mount(Array.from({ length: 40 }, (_, i) => `line ${i}`).join("\n"));
    editor.open(40, false);
    await settle();
    const scroll = host.querySelector<HTMLElement>(".ve-scroll")!;
    Object.defineProperty(scroll, "clientHeight", { configurable: true, value: 100 });
    input.focus();
    scroll.scrollTop = 200;
    scroll.dispatchEvent(new Event("scroll"));
    input.dispatchEvent(new CompositionEvent("compositionstart"));
    expect(input.style.top).toBe("0px");
    expect(input.parentElement).toBe(host);
  });

  it("ウィンドウ復帰時にIME入力位置を再同期する", async () => {
    const { editor, input } = mount("line");
    editor.open(1, false);
    await settle();
    input.focus();
    input.style.top = "-999px";

    window.dispatchEvent(new Event("focus"));
    await settle();

    expect(input.style.top).not.toBe("-999px");
    input.dispatchEvent(new CompositionEvent("compositionstart"));
    expect(Number.parseFloat(input.style.width)).toBeGreaterThanOrEqual(4);
  });

  it("ウィンドウの横幅変更時にIME入力位置を再同期する", async () => {
    const { editor, input } = mount("line");
    editor.open(1, false);
    await settle();
    input.focus();
    input.style.left = "-999px";

    window.dispatchEvent(new Event("resize"));
    await settle();

    expect(input.style.left).not.toBe("-999px");
  });

  it("ウィンドウ変更後にIME用textareaを次のユーザー操作までblurする", async () => {
    const { editor, input } = mount("line");
    editor.open(1, false);
    await settle();
    input.focus();
    const blur = vi.spyOn(input, "blur");

    editor.syncWindowGeometry();
    await new Promise((resolve) => setTimeout(resolve, 80));

    expect(blur).toHaveBeenCalledTimes(1);
    expect(document.activeElement).toBe(document.body);
  });

  it("ウィンドウ変更後も別UIからフォーカスを奪わない", async () => {
    const { editor, host, input } = mount("line");
    editor.open(1, false);
    await settle();
    const button = document.createElement("button");
    host.appendChild(button);
    button.focus();
    const focus = vi.spyOn(input, "focus");

    editor.syncWindowGeometry();
    await new Promise((resolve) => setTimeout(resolve, 80));

    expect(focus).not.toHaveBeenCalled();
    expect(document.activeElement).toBe(button);
  });

  it("IME変換中のフォーカス再初期化は変換終了まで待つ", async () => {
    const { editor, input } = mount("line");
    editor.open(1, false);
    await settle();
    input.focus();
    input.dispatchEvent(new CompositionEvent("compositionstart"));
    const blur = vi.spyOn(input, "blur");

    editor.syncWindowGeometry();
    await new Promise((resolve) => setTimeout(resolve, 70));
    expect(blur).not.toHaveBeenCalled();

    input.dispatchEvent(new CompositionEvent("compositionend"));
    await new Promise((resolve) => setTimeout(resolve, 80));
    expect(blur).toHaveBeenCalledTimes(1);
    expect(document.activeElement).toBe(document.body);
  });

  it("IMEアンカーの実矩形が領域外なら安全位置へ退避する", async () => {
    const { editor, host, input } = mount("line");
    editor.open(1, false);
    await settle();
    const scroll = host.querySelector<HTMLElement>(".ve-scroll")!;
    vi.spyOn(scroll, "getBoundingClientRect").mockReturnValue({
      x: 40, y: 20, left: 40, top: 20, right: 240, bottom: 120,
      width: 200, height: 100, toJSON: () => ({}),
    } as DOMRect);
    vi.spyOn(host, "getBoundingClientRect").mockReturnValue({
      x: 0, y: 0, left: 0, top: 0, right: 300, bottom: 150,
      width: 300, height: 150, toJSON: () => ({}),
    } as DOMRect);
    vi.spyOn(input, "getBoundingClientRect").mockReturnValue({
      x: -100, y: -100, left: -100, top: -100, right: -96, bottom: -80,
      width: 4, height: 20, toJSON: () => ({}),
    } as DOMRect);

    editor.syncWindowGeometry();

    expect(input.style.left).toBe("48px");
    expect(input.style.top).toBe("20px");
  });

  it("IME変換中文字列の幅を表示領域内に制限する", async () => {
    const { editor, host, input } = mount("line");
    editor.open(1, false);
    await settle();
    const scroll = host.querySelector<HTMLElement>(".ve-scroll")!;
    Object.defineProperty(scroll, "clientWidth", { configurable: true, value: 100 });
    Object.defineProperty(input, "scrollWidth", { configurable: true, value: 500 });

    input.dispatchEvent(new CompositionEvent("compositionstart"));
    input.value = "長い変換中文字列";
    input.dispatchEvent(new InputEvent("input", { isComposing: true }));

    expect(Number.parseFloat(input.style.width)).toBeLessThanOrEqual(88);
    expect(scroll.scrollLeft).toBeGreaterThan(0);
  });

  it("折り返し中のIME背景は変換中文字列の範囲だけを覆う", async () => {
    const { editor, host, input } = mount("0123456789");
    editor.open(1, false);
    editor.setWrap(true);
    await editor.selectRange(0, 3, 3);
    const scroll = host.querySelector<HTMLElement>(".ve-scroll")!;
    Object.defineProperty(scroll, "clientWidth", { configurable: true, value: 300 });

    input.dispatchEvent(new CompositionEvent("compositionstart"));
    input.value = "AB";
    input.dispatchEvent(new InputEvent("input", { isComposing: true }));

    expect(Number.parseFloat(input.style.width)).toBeLessThan(100);
    expect(input.classList.contains("ime")).toBe(true);
    expect(host.querySelector(".ve-line")?.textContent).toBe("0123456789");
  });

  it("長い折り返し行の途中ではIMEを実際の編集位置へ表示する", async () => {
    const { editor, host, input } = mount("x".repeat(1000));
    editor.open(1, false);
    editor.setWrap(true);
    await editor.selectRange(0, 500, 500);
    const scroll = host.querySelector<HTMLElement>(".ve-scroll")!;
    Object.defineProperties(scroll, {
      clientHeight: { configurable: true, value: 100 },
      clientWidth: { configurable: true, value: 300 },
    });
    scroll.scrollTop = 900;
    const rect = {
      x: 50, y: 940, left: 50, top: 940, right: 50, bottom: 960,
      width: 0, height: 20, toJSON: () => ({}),
    } as DOMRect;
    const ranges = Object.assign([rect], { item: (index: number) => [rect][index] ?? null });
    const getClientRects = vi.spyOn(Range.prototype, "getClientRects").mockReturnValue(ranges as DOMRectList);

    input.dispatchEvent(new CompositionEvent("compositionstart"));

    expect(input.style.top).toBe("40px");
    expect(Number.parseFloat(input.style.left)).toBeGreaterThanOrEqual(8);
    getClientRects.mockRestore();
  });

  it("1論理行が多数行へ折り返されてもホイールで行内を移動する", async () => {
    const { editor, host } = mount("x".repeat(1000));
    const scroll = host.querySelector<HTMLElement>(".ve-scroll")!;
    Object.defineProperty(scroll, "clientHeight", { configurable: true, value: 100 });
    const lineRect = vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (this: HTMLElement) {
      const height = this.classList.contains("ve-line") ? 2000 : 0;
      return {
        x: 0, y: 0, left: 0, top: 0, right: 100, bottom: height,
        width: 100, height, toJSON: () => ({}),
      } as DOMRect;
    });
    editor.open(1, false);
    editor.setWrap(true);
    await settle();

    scroll.dispatchEvent(new WheelEvent("wheel", { deltaY: 80 }));
    await vi.waitFor(() => {
      const line = host.querySelector<HTMLElement>(".ve-line")!;
      expect(Number.parseFloat(line.style.top) - scroll.scrollTop).toBe(-80);
    });
    lineRect.mockRestore();
  });

  it("長い折り返し1行でも縦スクロールバーを表示し、つまみ位置へ移動する", async () => {
    const { editor, host } = mount("x".repeat(1000));
    editor.open(1, false);
    editor.setWrap(true);
    await settle();
    const scroll = host.querySelector<HTMLElement>(".ve-scroll")!;
    const inner = host.querySelector<HTMLElement>(".ve-inner")!;
    Object.defineProperties(scroll, {
      clientHeight: { configurable: true, value: 100 },
      clientWidth: { configurable: true, value: 100 },
      scrollHeight: {
        configurable: true,
        get: () => Number.parseFloat(inner.style.height) || 0,
      },
    });
    scroll.getBoundingClientRect = () => ({
      x: 0, y: 0, left: 0, top: 0, right: 112, bottom: 100,
      width: 112, height: 100, toJSON: () => ({}),
    } as DOMRect);
    const lineRect = vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (this: HTMLElement) {
      const height = this.classList.contains("ve-line") ? 2000 : 0;
      return {
        x: 0, y: 0, left: 0, top: 0, right: 100, bottom: height,
        width: 100, height, toJSON: () => ({}),
      } as DOMRect;
    });

    scroll.dispatchEvent(new Event("scroll"));
    await vi.waitFor(() => expect(Number.parseFloat(inner.style.height)).toBe(2000));

    scroll.dispatchEvent(new MouseEvent("mousedown", { clientX: 105, clientY: 20 }));
    scroll.scrollTop = 950;
    scroll.dispatchEvent(new Event("scroll"));
    await settle();
    window.dispatchEvent(new MouseEvent("mouseup"));

    const renderedLine = host.querySelector<HTMLElement>(".ve-line")!;
    expect(Number.parseFloat(renderedLine.style.top) - scroll.scrollTop).toBe(-950);
    expect(Number.parseFloat(inner.style.height)).toBe(2000);
    lineRect.mockRestore();
  });

  it("compositionendが来ないblurでもIME状態と入力を回収する", async () => {
    const { editor, doc, input } = mount("ab");
    editor.open(1, false);
    await settle();
    input.dispatchEvent(new CompositionEvent("compositionstart"));
    input.value = "漢字";
    input.dispatchEvent(new InputEvent("input", { isComposing: true }));

    input.dispatchEvent(new FocusEvent("blur"));
    await settle();

    expect(input.classList.contains("ime")).toBe(false);
    expect(input.value).toBe("");
    expect(doc.text()).toBe("漢字ab");
  });

  it("横スクロールバーを本文から分離して双方向に同期する", async () => {
    const { editor, host } = mount("wide line");
    editor.open(1, false);
    await settle();
    const scroll = host.querySelector<HTMLElement>(".ve-scroll")!;
    const hScroll = host.querySelector<HTMLElement>(".ve-hscroll")!;

    hScroll.scrollLeft = 80;
    hScroll.dispatchEvent(new Event("scroll"));
    expect(scroll.scrollLeft).toBe(80);

    scroll.scrollLeft = 25;
    scroll.dispatchEvent(new Event("scroll"));
    expect(hScroll.scrollLeft).toBe(25);

    editor.setWrap(true);
    expect(hScroll.hidden).toBe(true);
    expect(host.classList.contains("hscroll-hidden")).toBe(true);
  });

  it("文書切替直後の範囲選択を読み込み後に横方向へ表示する", async () => {
    const rect = vi.spyOn(Range.prototype, "getBoundingClientRect").mockImplementation(function (this: Range) {
      return {
        x: 0, y: 0, top: 0, left: 0, right: this.endOffset * 10, bottom: 20,
        width: this.endOffset * 10, height: 20, toJSON: () => ({}),
      } as DOMRect;
    });
    const { editor, host } = mount("x".repeat(50));
    const scroll = host.querySelector<HTMLElement>(".ve-scroll")!;
    const hScroll = host.querySelector<HTMLElement>(".ve-hscroll")!;
    Object.defineProperty(scroll, "clientWidth", { configurable: true, value: 100 });

    editor.open(1, false);
    await editor.selectRange(0, 20, 30);

    expect(scroll.scrollLeft).toBeGreaterThan(0);
    expect(hScroll.scrollLeft).toBe(scroll.scrollLeft);
    rect.mockRestore();
  });

  it("選択位置と縦横の表示位置を復元する", async () => {
    const { editor, host } = mount(Array.from({ length: 40 }, (_, i) => `line ${i}`).join("\n"));
    const scroll = host.querySelector<HTMLElement>(".ve-scroll")!;
    Object.defineProperty(scroll, "clientHeight", { configurable: true, value: 100 });
    editor.open(40, false);
    await settle();
    scroll.scrollTop = 200;
    scroll.scrollLeft = 35;
    scroll.dispatchEvent(new Event("scroll"));
    await editor.selectRange(12, 1, 4);
    const state = editor.captureViewState();

    editor.open(40, false);
    await editor.restoreViewState(state);
    const restored = editor.captureViewState();

    expect(restored.anchor).toEqual(state.anchor);
    expect(restored.caret).toEqual(state.caret);
    expect(restored.topLine).toBe(state.topLine);
    expect(restored.scrollLeft).toBe(state.scrollLeft);
  });

  it("キャレット行と選択行を行番号の背景だけで強調する", async () => {
    const { editor, host } = mount("first\nsecond");
    editor.open(2, false);
    await editor.selectRange(0, 0, 5);

    expect(host.querySelector(".ve-gnum.selected-line.caret-line")).not.toBeNull();
    expect(host.querySelector(".ve-line.selected-line, .ve-line.caret-line")).toBeNull();
    expect(host.querySelector(".ve-line-highlight")).toBeNull();
  });

  it("フォーカス中のキャレットは常時表示し、フォーカスを失うと隠す", async () => {
    const { editor, host, input } = mount("line");
    editor.open(1, false);
    await settle();
    Object.defineProperty(host.querySelector<HTMLElement>(".ve-scroll")!, "clientHeight", {
      configurable: true,
      value: 100,
    });
    await editor.restoreViewState({
      anchor: { line: 0, col: 0 },
      caret: { line: 0, col: 0 },
      topLine: 0,
      wrapIntraLinePx: 0,
      scrollLeft: 0,
    });
    const caret = host.querySelector<HTMLElement>(".ve-caret")!;

    editor.focus();
    expect(caret.classList.contains("on")).toBe(true);
    input.dispatchEvent(new FocusEvent("blur"));
    expect(caret.classList.contains("on")).toBe(false);
  });
});
