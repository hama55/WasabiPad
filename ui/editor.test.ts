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
    openViewer: async () => null,
    updateViewer: async () => {},
  };
  const editor = new VirtualEditor(host, ports, undefined, doc.client);
  const input = host.querySelector<HTMLTextAreaElement>(".ve-input")!;
  const type = (value: string) => {
    input.value = value;
    input.dispatchEvent(new InputEvent("input"));
  };
  const press = (key: string) => input.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true }));
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
    expect(input.style.top).toBe("200px");
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

  it("キャレット行と選択行を行番号の背景だけで強調する", async () => {
    const { editor, host } = mount("first\nsecond");
    editor.open(2, false);
    await editor.selectRange(0, 0, 5);

    expect(host.querySelector(".ve-gnum.selected-line.caret-line")).not.toBeNull();
    expect(host.querySelector(".ve-line.selected-line, .ve-line.caret-line")).toBeNull();
    expect(host.querySelector(".ve-line-highlight")).toBeNull();
  });
});
