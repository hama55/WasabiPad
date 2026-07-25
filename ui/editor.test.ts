// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from "vitest";
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
  return { editor, doc, events, host, type, press };
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
    const { editor, doc, events, type } = mount("ab");
    editor.open(1, false);
    await settle();
    type("X");
    await settle();
    expect(doc.text()).toBe("Xab");
    type("\n");
    await settle();
    expect(doc.text()).toBe("X\nab");
    expect(events.lineCount).toBe(2);
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
});
