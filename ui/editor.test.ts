// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";
import { fakeDocument, installDomStubs, settle } from "./test-doubles";
import { VirtualEditor, type EditorPorts } from "./editor";

installDomStubs();

function mount(initial: string) {
  const host = document.createElement("div");
  document.body.replaceChildren(host);
  const doc = fakeDocument(initial);
  const events = { lineCount: 0, cursor: [0, 0] as [number, number] };
  const ports: EditorPorts = {
    onDocChange: (lineCount) => { events.lineCount = lineCount; },
    onCursor: (line, col) => { events.cursor = [line, col]; },
    onFontChange: () => {},
    hasExternalFile: () => false,
    openExternally: () => {},
    onError: async () => {},
    openViewer: async () => null,
    updateViewer: async () => true,
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
  beforeEach(() => document.body.replaceChildren());

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

  it("goTo はキャレット位置を1始まりで通知する", async () => {
    const { editor, events } = mount("one\ntwo");
    editor.open(2, false);
    await settle();
    editor.goTo(1, 2);
    await settle();
    expect(events.cursor).toEqual([2, 3]);
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
    const line = host.querySelector<HTMLElement>(".ve-line")!;
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
    line.getBoundingClientRect = () => ({
      x: 0, y: 0, left: 0, top: 0, right: 100, bottom: 2000,
      width: 100, height: 2000, toJSON: () => ({}),
    } as DOMRect);

    scroll.dispatchEvent(new Event("scroll"));
    await settle();
    expect(Number.parseFloat(inner.style.height)).toBe(2000);

    scroll.dispatchEvent(new MouseEvent("mousedown", { clientX: 105, clientY: 20 }));
    scroll.scrollTop = 950;
    scroll.dispatchEvent(new Event("scroll"));
    await settle();
    window.dispatchEvent(new MouseEvent("mouseup"));

    expect(Number.parseFloat(line.style.top) - scroll.scrollTop).toBe(-950);
    expect(Number.parseFloat(inner.style.height)).toBe(2000);
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
});
