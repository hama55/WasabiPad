// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

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
import { MENU_ICON } from "./menu-icons";

installDomStubs();

function mount(
  initial: string,
  saveImage?: EditorPorts["saveImage"],
  overrides: Partial<Pick<EditorPorts, "revealInExplorer" | "openInNewWindow" | "registeredCommandPorts" | "openViewer">> = {},
) {
  const host = document.createElement("div");
  document.body.replaceChildren(host);
  const doc = fakeDocument(initial);
  const events = {
    lineCount: 0,
    cursor: [0, 0] as [number, number],
    fontChanges: [] as { family: string; size: number; changed: "family" | "size" | "both" }[],
    errors: [] as { message: string; error: unknown }[],
  };
  const ports: EditorPorts = {
    onDocChange: (lineCount) => { events.lineCount = lineCount; },
    onCursor: (line, col) => { events.cursor = [line, col]; },
    onFontChange: (family, size, changed) => { events.fontChanges.push({ family, size, changed }); },
    openExternally: () => {},
    openInNewWindow: overrides.openInNewWindow,
    revealInExplorer: overrides.revealInExplorer,
    registeredCommandPorts: overrides.registeredCommandPorts ?? {
      promptFields: async () => null,
      runExternalCommand: async () => {},
    },
    onError: async (message, error) => { events.errors.push({ message, error }); },
    openViewer: overrides.openViewer ?? (async () => null),
    updateViewer: async () => true,
    closeViewer: async () => {},
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

function installMouseLayout(host: HTMLElement) {
  const dropdown = document.createElement("div");
  dropdown.id = "dropdown";
  document.body.appendChild(dropdown);
  const scroll = host.querySelector<HTMLElement>(".ve-scroll")!;
  Object.defineProperties(scroll, {
    clientHeight: { configurable: true, value: 100 },
    clientWidth: { configurable: true, value: 300 },
  });
  const scrollRect = vi.spyOn(scroll, "getBoundingClientRect").mockReturnValue({
    x: 0, y: 0, top: 0, left: 0, right: 300, bottom: 100, width: 300, height: 100,
    toJSON: () => ({}),
  } as DOMRect);
  const originalElementRect = HTMLElement.prototype.getBoundingClientRect;
  const lineRect = vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (this: HTMLElement) {
    if (!this.classList.contains("ve-line")) return originalElementRect.call(this);
    const top = Number(this.dataset.line) * 20;
    return {
      x: 0, y: top, top, left: 0, right: 300, bottom: top + 20,
      width: 300, height: 20, toJSON: () => ({}),
    } as DOMRect;
  });
  const rangeRect = vi.spyOn(Range.prototype, "getBoundingClientRect").mockImplementation(function (this: Range) {
    const width = this.endOffset * 10;
    return { x: 0, y: 0, top: 0, left: 0, right: width, bottom: 20, width, height: 20, toJSON: () => ({}) } as DOMRect;
  });
  return {
    scroll,
    restore: () => {
      scrollRect.mockRestore();
      lineRect.mockRestore();
      rangeRect.mockRestore();
      dropdown.remove();
    },
  };
}

function mockBlockSelectionPoints(editor: VirtualEditor) {
  // jsdomのRange座標差を避け、Alt+D&D処理へ渡す文字位置だけを固定する。
  return vi.spyOn(
    editor as unknown as {
      posFromPoint(cx: number, cy: number): { line: number; col: number } | null;
    },
    "posFromPoint",
  ).mockImplementation((cx, cy) => ({
    line: Math.floor(cy / 20),
    col: Math.round((cx - 8) / 10),
  }));
}

describe("Feature: VirtualEditor", () => {
  afterEach(() => {
    // 失敗したテストでもプロトタイプ上のレイアウトモックを次のテストへ残さない。
    vi.restoreAllMocks();
  });

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

  // Given: fake DocumentClient に「one\ntwo\nthree」を設定し、VirtualEditor を open(3, false) で開いている
  // When: 初期読み込みを settle まで待つ
  // Then: DocumentClient の呼び出しに lines(...) が1件以上含まれる
  it("Scenario: 注入された DocumentClient から可視行を取得する", async () => {
    const { editor, doc } = mount("one\ntwo\nthree");
    editor.open(3, false);
    await settle();
    expect(doc.calls.some((call) => call.startsWith("lines("))).toBe(true);
  });

  // Feature: フォルダ検索の一致単位置換
  // Scenario: エディタ上の一致範囲を置換する
  // Given: 「before needle after」を表示している
  // When: needle の範囲を wasabi へ置換する
  // Then: 文書本文が置換され、成功を返す
  it("Scenario: 検索結果から指定範囲だけを置換する", async () => {
    const { editor, doc } = mount("before needle after");
    editor.open(1, false);
    await settle();

    await expect(editor.replaceRange(0, 7, 13, "wasabi")).resolves.toBe(true);

    expect(doc.text()).toBe("before wasabi after");
  });

  // Given: 文書をエディタで表示している
  // When: エディタ上で Ctrl+ホイールを操作する
  // Then: フォントサイズ変更として通知し、フォントファミリー変更とは通知しない
  it("Scenario: エディタのCtrl+ホイールはサイズ変更だけを通知する", async () => {
    const { editor, host, events } = mount("line");
    editor.open(1, false);
    await settle();

    host.querySelector<HTMLElement>(".ve-scroll")!.dispatchEvent(
      new WheelEvent("wheel", { deltaY: -1, ctrlKey: true }),
    );

    expect(events.fontChanges.at(-1)?.changed).toBe("size");
  });

  // Given: 2行の文書を表示し、1行目の1文字を選択している
  // When: Markdownビューを開く
  // Then: 全文を渡しつつ、選択範囲だけは元の位置で通知する
  it("Scenario: エディタから開くプレビューは全文を映す", async () => {
    const openViewer = vi.fn<EditorPorts["openViewer"]>(async () => "inline-viewer");
    const { editor } = mount("one\ntwo", undefined, { openViewer });
    editor.open(2, false);
    await settle();
    await editor.selectRange(0, 1, 1);

    await editor.openTextViewer("markdown");

    expect(openViewer).toHaveBeenCalledWith("markdown", "one\ntwo", {
      start: { line: 0, col: 1 },
      end: { line: 0, col: 1 },
    });
  });

  // Feature: SVGの全文プレビュー
  // Scenario: SVGの一部を選択中に画像ビューを開く
  // Given: SVG本文の一部が選択されている
  // When: 画像ビューを開く
  // Then: 選択部分ではなくSVG全文をプレビューへ渡す
  it("Scenario: SVG image preview always uses the full document", async () => {
    const openViewer = vi.fn<EditorPorts["openViewer"]>(async () => "inline-viewer");
    const { editor } = mount("<svg>\n<rect/>\n</svg>", undefined, { openViewer });
    editor.open(3, false);
    await settle();
    await editor.restoreViewState({
      anchor: { line: 1, col: 0 },
      caret: { line: 1, col: 7 },
      topLine: 0,
      wrapIntraLinePx: 0,
      scrollLeft: 0,
    });

    await editor.openTextViewer("image");

    expect(openViewer).toHaveBeenCalledWith("image", "<svg>\n<rect/>\n</svg>", {
      start: { line: 1, col: 0 },
      end: { line: 1, col: 7 },
      caret: { line: 1, col: 7 },
    });
  });

  // Given: 文書が「ab」、編集モードで開かれ、既存の .ve-line・.ve-gnum と lines(...) 呼び出し数を記録している
  // When: 「X」を入力してから改行を入力する
  // Then: 1回目は文書が「Xab」、既存DOMノードを維持し lines(...) 呼び出し数も不変、2回目は文書が「X\nab」かつ lineCount が2になる
  it("Scenario: 入力は backend の edit へ委譲され、行数変化が通知される", async () => {
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

  // Given: 文書が「ab」、backend の edit が gate 解放まで保留され、IME入力「漢字」を compositionstart→composing input→compositionend している
  // When: 変換確定後に commit 処理を確認し、edit の gate を解放して settle する
  // Then: backend反映前は .ve-ime-commit に「漢字」が表示され textarea は空、反映後は commit 要素が消え文書が「漢字ab」になる
  it("Scenario: IME確定文字は backend 反映まで表示を保持する", async () => {
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

  // Given: 文書が「ab」、editor.open(1, true) で閲覧専用になっている
  // When: 「X」入力、Backspace、Delete、Enter を実行する
  // Then: 文書は「ab」のままで、edit で始まる backend 呼び出しが空配列になる
  it("Scenario: 閲覧専用なら編集系の呼び出しを一切出さない", async () => {
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

  // Given: 文書が「\t\tmemo」、キャレットを0行目6列目に置いている
  // When: Enter を押す
  // Then: 文書が「\t\tmemo\n\t\t」になる
  it("Scenario: 改行時に現在行の先頭タブを引き継ぐ", async () => {
    const { editor, doc, press } = mount("\t\tmemo");
    editor.open(1, false);
    await settle();
    editor.goTo(0, 6);

    press("Enter");
    await settle();

    expect(doc.text()).toBe("\t\tmemo\n\t\t");
  });

  // Given: 文書が行頭tab付きのMarkdownリスト「\t* item」または「\t- item」
  // When: 行末でEnterを押す
  // Then: 改行後の行頭へtabと同じリスト記号が引き継がれる
  it.each([
    ["\t* item", "\t* item\n\t* "],
    ["\t- item", "\t- item\n\t- "],
    ["+ item", "+ item\n+ "],
    ["1. item", "1. item\n2. "],
    ["- [ ] item", "- [ ] item\n- [ ] "],
    ["> quote", "> quote\n> "],
    ["| cell | value |", "| cell | value |\n| "],
  ])("Scenario: Markdownの記法を改行後へ継続する", async (initial, expected) => {
    const { editor, doc, press } = mount(initial);
    editor.open(1, false, false, "C:\\work\\memo.md");
    await settle();
    editor.goTo(0, initial.length);

    press("Enter");
    await settle();

    expect(doc.text()).toBe(expected);
  });

  // Given: Markdownの空リスト項目「- 」または「1. 」の末尾
  // When: Enterを押す
  // Then: 記号だけを削除して現在行を空行にする
  it.each([
    ["- item\n- ", "- item\n"],
    ["1. item\n2. ", "1. item\n"],
    ["> - item\n> - ", "> - item\n> "],
  ])("Scenario: Markdownの空リストでEnterするとリストを終了する", async (initial, expected) => {
    const { editor, doc, press } = mount(initial);
    editor.open(initial.split("\n").length, false, false, "C:\\work\\memo.md");
    await settle();
    const line = initial.split("\n").length - 1;
    editor.goTo(line, initial.split("\n").at(-1)!.length);

    press("Enter");
    await settle();

    expect(doc.text()).toBe(expected);
  });

  // Given: Markdownのコードフェンス内に2つの空白で始まる行がある
  // When: 行末でEnterを押す
  // Then: コードブロック内の空白インデントを継承する
  it("Scenario: Markdownコードブロック内の空白インデントを継承する", async () => {
    const initial = "```\n  code";
    const { editor, doc, press } = mount(initial);
    editor.open(2, false, false, "C:\\work\\memo.md");
    await settle();
    editor.goTo(1, initial.split("\n")[1].length);

    press("Enter");
    await settle();

    expect(doc.text()).toBe("```\n  code\n  ");
  });

  // Given: Markdown文書の空行でコードフェンス開始の```を入力する
  // When: ```を入力する
  // Then: 閉じフェンスを自動挿入し、中間行へキャレットを置く
  it("Scenario: Markdownコードフェンスの閉じ側を自動挿入する", async () => {
    const { editor, doc, type } = mount("");
    editor.open(1, false, false, "C:\\work\\memo.md");
    await settle();

    type("```");
    await settle();

    expect(doc.text()).toBe("```\n\n```");
    expect(editor.captureViewState().caret).toEqual({ line: 1, col: 0 });
  });

  // Given: Markdownではないtxt文書で行頭に`- `がある
  // When: 行末でEnterを押す
  // Then: Markdownのリスト記号は自動挿入せず、通常の改行だけを入れる
  it("Scenario: Markdown自動継続をtxt文書へ適用しない", async () => {
    const { editor, doc, press } = mount("- item");
    editor.open(1, false, false, "C:\\work\\memo.txt");
    await settle();
    editor.goTo(0, 6);

    press("Enter");
    await settle();

    expect(doc.text()).toBe("- item\n");
  });

  // Given: Markdownではないtxt文書の空行にいる
  // When: ```を入力する
  // Then: 閉じフェンスを自動挿入しない
  it("Scenario: Markdownコードフェンス自動挿入をtxt文書へ適用しない", async () => {
    const { editor, doc, type } = mount("");
    editor.open(1, false, false, "C:\\work\\memo.txt");
    await settle();

    type("```");
    await settle();

    expect(doc.text()).toBe("```");
  });

  // Given: 文書が「one\ntwo\nthree」、選択範囲が0行1列から1行1列までである
  // When: Tab を押す
  // Then: 選択文字列がタブで置換され、行単位indentは発生しない
  it("Scenario: 行頭を含まない選択中のTabは選択文字列を置換する", async () => {
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

    expect(doc.text()).toBe("o\two\nthree");
    expect(doc.calls).not.toContain("editMany(2)");
  });

  // Given: 文書が「one\ntwo\nthree」、選択範囲が行頭を含む0行0列から1行1列までである
  // When: Tab を押す
  // Then: 選択された各行の先頭へタブを挿入する
  it("Scenario: 行頭を含む複数行選択中のTabは各行の先頭へタブを挿入する", async () => {
    const { editor, doc, press } = mount("one\ntwo\nthree");
    editor.open(3, false);
    await settle();
    await editor.restoreViewState({
      anchor: { line: 0, col: 0 },
      caret: { line: 1, col: 1 },
      topLine: 0,
      wrapIntraLinePx: 0,
      scrollLeft: 0,
    });

    press("Tab");
    await settle();

    expect(doc.text()).toBe("\tone\n\ttwo\nthree");
    expect(doc.calls).toContain("editMany(2)");

    press("Tab");
    await settle();

    expect(doc.text()).toBe("\t\tone\n\t\ttwo\nthree");
    expect(doc.calls.filter((call) => call === "editMany(2)")).toHaveLength(2);
  });

  // Given: 文書が「\tone\ntwo\n\tthree」、3行を選択している
  // When: Shift+Tabを押す
  // Then: 先頭タブがある行だけ各1つ削除され、選択は行内位置を保つ
  it("Scenario: Shift+Tabは選択した各行の先頭タブを1つ削除する", async () => {
    const { editor, doc, press } = mount("\tone\ntwo\n\tthree");
    editor.open(3, false);
    await settle();
    await editor.restoreViewState({
      anchor: { line: 0, col: 0 },
      caret: { line: 2, col: 6 },
      topLine: 0,
      wrapIntraLinePx: 0,
      scrollLeft: 0,
    });

    press("Tab", { shiftKey: true });
    await settle();

    expect(doc.text()).toBe("one\ntwo\nthree");
    expect(doc.calls).toContain("editMany(2)");
    expect(editor.captureViewState().caret).toEqual({ line: 2, col: 5 });
  });

  // Given: 空の新規メモを折り返し表示し、本文の行より下の空白をクリックする
  // When: エディタの範囲外でマウス選択を開始する
  // Then: 選択開始位置を最終行として扱い、キャレットを表示する
  it("Scenario: 折り返し表示の行外クリックは最終行へキャレットを置く", async () => {
    const { editor, host } = mount("");
    editor.open(1, false);
    await settle();
    const layout = installMouseLayout(host);
    editor.setWrap(true);

    layout.scroll.dispatchEvent(new MouseEvent("mousedown", {
      bubbles: true, button: 0, clientX: 48, clientY: 90,
    }));

    expect(editor.captureViewState().caret).toEqual({ line: 0, col: 0 });
    expect(host.querySelector(".ve-caret.on")).not.toBeNull();
    layout.restore();
  });

  // Feature: エディタ範囲外クリックのキャレット補正
  // Scenario: 複数行文書の本文下をクリックする
  // Given: 「one\ntwo」を表示し、本文の2行より下をクリックする
  // When: エディタの範囲外でマウス選択を開始する
  // Then: 最終行「two」の末尾へキャレットを置く
  it("Scenario: 複数行の行外クリックは最終行末尾へキャレットを置く", async () => {
    const { editor, host } = mount("one\ntwo");
    editor.open(2, false);
    await settle();
    const layout = installMouseLayout(host);
    editor.setWrap(true);

    layout.scroll.dispatchEvent(new MouseEvent("mousedown", {
      bubbles: true, button: 0, clientX: 48, clientY: 90,
    }));

    expect(editor.captureViewState().caret).toEqual({ line: 1, col: 3 });
    layout.restore();
  });

  // Given: Alt+D&Dで0〜2行目の1〜3列を矩形選択している
  // When: Deleteを押す
  // Then: すべての行の矩形部分が削除される
  it("Scenario: 複数行複数列の矩形選択をDeleteできる", async () => {
    const { editor, doc, host, press } = mount("abcd\nABCD\nwxyz");
    editor.open(3, false);
    await settle();
    const layout = installMouseLayout(host);
    const points = mockBlockSelectionPoints(editor);
    const scroll = layout.scroll;

    scroll.dispatchEvent(new MouseEvent("mousedown", {
      bubbles: true, button: 0, clientX: 18, clientY: 10, altKey: true,
    }));
    window.dispatchEvent(new MouseEvent("mousemove", {
      bubbles: true, clientX: 38, clientY: 50, altKey: true,
    }));
    window.dispatchEvent(new MouseEvent("mouseup", {
      bubbles: true, clientX: 38, clientY: 50, altKey: true,
    }));

    press("Delete");
    await settle();

    expect(doc.text()).toBe("ad\nAD\nwz");
    expect(doc.calls).toContain("editMany(3)");
    points.mockRestore();
    layout.restore();
  });

  // Given: 「bc」「BC」を矩形コピーし、クリップボードに同じ矩形文字列がある
  // When: 2行目1列へCtrl+Vする
  // Then: 同じ列位置へ2行分を矩形貼り付けする
  it("Scenario: 矩形コピーを同じ列位置へ矩形貼り付けできる", async () => {
    const saveImage = vi.fn(async () => "unused");
    const { editor, doc, host, input, press } = mount("abcd\nABCD\nwxyz\n----", saveImage);
    editor.open(4, false);
    await settle();
    const layout = installMouseLayout(host);
    const points = mockBlockSelectionPoints(editor);
    const scroll = layout.scroll;
    scroll.dispatchEvent(new MouseEvent("mousedown", {
      bubbles: true, button: 0, clientX: 18, clientY: 10, altKey: true,
    }));
    window.dispatchEvent(new MouseEvent("mousemove", {
      bubbles: true, clientX: 38, clientY: 30, altKey: true,
    }));
    window.dispatchEvent(new MouseEvent("mouseup", {
      bubbles: true, clientX: 38, clientY: 30, altKey: true,
    }));

    press("c", { ctrlKey: true });
    await settle();
    expect(writeClipboardText).toHaveBeenLastCalledWith("bc\nBC");
    editor.goTo(2, 1);
    const pasteEvent = new Event("paste", { bubbles: true, cancelable: true });
    Object.defineProperty(pasteEvent, "clipboardData", {
      value: { items: [], getData: () => "bc\nBC" },
    });
    input.dispatchEvent(pasteEvent);
    await settle();

    expect(pasteEvent.defaultPrevented).toBe(true);
    expect(doc.text()).toBe("abcd\nABCD\nwbcxyz\n-BC---");
    expect(doc.calls).toContain("editMany(2)");
    points.mockRestore();
    layout.restore();
  });

  // Given: 矩形コピーのクリップボード書き込みが失敗する
  // When: 同じ文字列を通常の貼り付けとして受け取る
  // Then: 失敗した古い矩形メタデータを使わず通常編集する
  it("Scenario: 矩形コピー失敗後は古い矩形メタデータを使わない", async () => {
    const { editor, doc, host, press } = mount("abcd\nABCD\nwxyz");
    editor.open(3, false);
    await settle();
    const layout = installMouseLayout(host);
    const points = mockBlockSelectionPoints(editor);
    const scroll = layout.scroll;
    scroll.dispatchEvent(new MouseEvent("mousedown", {
      bubbles: true, button: 0, clientX: 18, clientY: 10, altKey: true,
    }));
    window.dispatchEvent(new MouseEvent("mousemove", {
      bubbles: true, clientX: 38, clientY: 30, altKey: true,
    }));
    window.dispatchEvent(new MouseEvent("mouseup", {
      bubbles: true, clientX: 38, clientY: 30, altKey: true,
    }));

    writeClipboardText.mockRejectedValueOnce(new Error("clipboard unavailable"));
    press("c", { ctrlKey: true });
    await settle();
    readClipboardText.mockResolvedValue("bc\nBC");
    editor.goTo(2, 1);
    press("v", { ctrlKey: true });
    await settle();

    expect(doc.calls.some((call) => call.startsWith('edit(2:1,2:1,"bc'))).toBe(true);
    expect(doc.calls).not.toContain("editMany(2)");
    points.mockRestore();
    layout.restore();
  });

  // Given: 「bc」「BC」を矩形切り取りし、クリップボードに矩形文字列がある
  // When: 2行目1列へCtrl+Vする
  // Then: 元の矩形を削除した後、同じ列位置へ矩形貼り付けする
  it("Scenario: 矩形切り取りを矩形貼り付けできる", async () => {
    const { editor, doc, host, press } = mount("abcd\nABCD\nwxyz\n----");
    editor.open(4, false);
    await settle();
    const layout = installMouseLayout(host);
    const points = mockBlockSelectionPoints(editor);
    const scroll = layout.scroll;
    scroll.dispatchEvent(new MouseEvent("mousedown", {
      bubbles: true, button: 0, clientX: 18, clientY: 10, altKey: true,
    }));
    window.dispatchEvent(new MouseEvent("mousemove", {
      bubbles: true, clientX: 38, clientY: 30, altKey: true,
    }));
    window.dispatchEvent(new MouseEvent("mouseup", {
      bubbles: true, clientX: 38, clientY: 30, altKey: true,
    }));

    press("x", { ctrlKey: true });
    await settle();
    expect(doc.text()).toBe("ad\nAD\nwxyz\n----");
    readClipboardText.mockResolvedValue("bc\nBC");
    editor.goTo(2, 1);
    press("v", { ctrlKey: true });
    await settle();

    expect(doc.text()).toBe("ad\nAD\nwbcxyz\n-BC---");
    points.mockRestore();
    layout.restore();
  });

  // Given: 文書が「abcDEFghi」、選択範囲が「DEF」
  // When: Ctrlなしで選択範囲を末尾へドラッグし、Undoを1回実行する
  // Then: ドラッグ中はドロップ位置に専用キャレットが表示され、移動はeditMany(2)の1操作で行われ、Undo 1回で元に戻る
  it("Scenario: 選択範囲の移動はドロップ位置を示しUndo一回で戻る", async () => {
    const { editor, doc, host, input, press } = mount("abcDEFghi");
    editor.open(1, false);
    await settle();
    const layout = installMouseLayout(host);
    await editor.selectRange(0, 3, 6);
    const scroll = layout.scroll;

    scroll.dispatchEvent(new MouseEvent("mousedown", {
      bubbles: true, button: 0, clientX: 48, clientY: 10,
    }));
    window.dispatchEvent(new MouseEvent("mousemove", {
      bubbles: true, clientX: 98, clientY: 10,
    }));

    expect(host.querySelector(".ve-drag-caret.on")).not.toBeNull();
    expect(host.querySelector<HTMLElement>(".ve-drag-caret")?.style.left).toBe("98px");

    window.dispatchEvent(new MouseEvent("mouseup", {
      bubbles: true, clientX: 98, clientY: 10,
    }));
    await settle();

    expect(doc.text()).toBe("abcghiDEF");
    expect(doc.calls).toContain("editMany(2)");
    expect(doc.calls.filter((call) => call.startsWith("edit(")).length).toBe(0);
    expect(editor.captureViewState().caret).toEqual({ line: 0, col: 9 });

    input.focus();
    press("z", { ctrlKey: true });
    await settle();
    expect(doc.text()).toBe("abcDEFghi");
    press("y", { ctrlKey: true });
    await settle();
    expect(doc.text()).toBe("abcghiDEF");
    press("z", { ctrlKey: true });
    await settle();
    expect(doc.text()).toBe("abcDEFghi");
    press("z", { ctrlKey: true });
    await settle();
    expect(doc.text()).toBe("abcDEFghi");

    layout.restore();
  });

  // Given: 文書が「abcDEFghi」、選択範囲が「DEF」である
  // When: Ctrlなしで選択範囲を先頭へドラッグする
  // Then: 選択文字列が元位置から削除され、先頭へ移動し、キャレットは移動後末尾になる
  it("Scenario: 選択範囲を元位置より前へ移動できる", async () => {
    const { editor, doc, host } = mount("abcDEFghi");
    editor.open(1, false);
    await settle();
    const layout = installMouseLayout(host);
    await editor.selectRange(0, 3, 6);
    const scroll = layout.scroll;

    scroll.dispatchEvent(new MouseEvent("mousedown", {
      bubbles: true, button: 0, clientX: 48, clientY: 10,
    }));
    window.dispatchEvent(new MouseEvent("mousemove", {
      bubbles: true, clientX: 8, clientY: 10,
    }));
    window.dispatchEvent(new MouseEvent("mouseup", {
      bubbles: true, clientX: 8, clientY: 10,
    }));
    await settle();

    expect(doc.text()).toBe("DEFabcghi");
    expect(editor.captureViewState().caret).toEqual({ line: 0, col: 3 });

    layout.restore();
  });

  // Given: 文書が「abcDEFghi」、選択範囲が「DEF」でドラッグ中である
  // When: ウィンドウが失焦してから、マウス移動・mouseupが届く
  // Then: ドラッグをキャンセルし、ドロップも編集も発生しない
  it("Scenario: 失焦した選択範囲ドラッグをキャンセルする", async () => {
    const { editor, doc, host } = mount("abcDEFghi");
    editor.open(1, false);
    await settle();
    const layout = installMouseLayout(host);
    await editor.selectRange(0, 3, 6);
    const scroll = layout.scroll;

    scroll.dispatchEvent(new MouseEvent("mousedown", {
      bubbles: true, button: 0, clientX: 48, clientY: 10,
    }));
    window.dispatchEvent(new MouseEvent("mousemove", {
      bubbles: true, clientX: 98, clientY: 10,
    }));
    expect(host.querySelector(".ve-drag-caret.on")).not.toBeNull();

    window.dispatchEvent(new Event("blur"));
    expect(host.querySelector(".ve-drag-caret.on")).toBeNull();

    window.dispatchEvent(new MouseEvent("mousemove", {
      bubbles: true, clientX: 98, clientY: 10,
    }));
    window.dispatchEvent(new MouseEvent("mouseup", {
      bubbles: true, clientX: 98, clientY: 10,
    }));
    await settle();

    expect(doc.text()).toBe("abcDEFghi");
    layout.restore();
  });

  // Given: 文書が「abcDEFghi」、選択範囲をドラッグ中でドロップキャレットが表示されている
  // When: 文書をopenし直してから、古いドラッグのmouseupが届く
  // Then: 古いドラッグを破棄し、文書を編集しない
  it("Scenario: 文書切替時に古い選択範囲ドラッグを破棄する", async () => {
    const { editor, doc, host } = mount("abcDEFghi");
    editor.open(1, false);
    await settle();
    const layout = installMouseLayout(host);
    await editor.selectRange(0, 3, 6);
    const scroll = layout.scroll;

    scroll.dispatchEvent(new MouseEvent("mousedown", {
      bubbles: true, button: 0, clientX: 48, clientY: 10,
    }));
    window.dispatchEvent(new MouseEvent("mousemove", {
      bubbles: true, clientX: 98, clientY: 10,
    }));
    expect(host.querySelector(".ve-drag-caret.on")).not.toBeNull();

    editor.open(1, false);
    expect(host.querySelector(".ve-drag-caret.on")).toBeNull();
    window.dispatchEvent(new MouseEvent("mouseup", {
      bubbles: true, clientX: 98, clientY: 10,
    }));
    await settle();

    expect(doc.text()).toBe("abcDEFghi");
    layout.restore();
  });

  // Given: 文書が「abcDEFghi」、選択範囲が「DEF」、移動用 backend editMany が Error("ipc failed") で拒否される
  // When: Ctrlなしで選択範囲を末尾へドラッグする
  // Then: エラーを通知し、ドロップキャレットを消して次の操作へ戻る
  it("Scenario: D&D移動のIPC失敗を通知してドラッグ状態を解放する", async () => {
    const { editor, doc, events, host } = mount("abcDEFghi");
    editor.open(1, false);
    await settle();
    const layout = installMouseLayout(host);
    await editor.selectRange(0, 3, 6);
    vi.spyOn(doc.client, "editMany").mockRejectedValueOnce(new Error("ipc failed"));
    const scroll = layout.scroll;

    scroll.dispatchEvent(new MouseEvent("mousedown", {
      bubbles: true, button: 0, clientX: 48, clientY: 10,
    }));
    window.dispatchEvent(new MouseEvent("mousemove", {
      bubbles: true, clientX: 98, clientY: 10,
    }));
    window.dispatchEvent(new MouseEvent("mouseup", {
      bubbles: true, clientX: 98, clientY: 10,
    }));
    await vi.waitFor(() => expect(events.errors).toHaveLength(1));

    expect(events.errors[0].message).toBe("選択範囲を移動またはコピーできませんでした");
    expect(host.querySelector(".ve-drag-caret.on")).toBeNull();
    expect(doc.text()).toBe("abcDEFghi");
    layout.restore();
  });

  // Given: 文書が「abcDEFghi」、選択範囲が「DEF」
  // When: Ctrlを押しながら選択範囲を末尾へドラッグする
  // Then: 元の文字列を残したまま末尾へコピーし、挿入1回として扱う
  it("Scenario: Ctrl付き選択範囲ドラッグはコピーになる", async () => {
    const { editor, doc, host, input } = mount("abcDEFghi");
    editor.open(1, false);
    await settle();
    const layout = installMouseLayout(host);
    await editor.selectRange(0, 3, 6);
    const scroll = layout.scroll;

    input.dispatchEvent(new KeyboardEvent("keydown", { key: "Control", bubbles: true }));
    scroll.dispatchEvent(new MouseEvent("mousedown", {
      bubbles: true, button: 0, clientX: 48, clientY: 10,
    }));
    window.dispatchEvent(new MouseEvent("mousemove", {
      bubbles: true, clientX: 98, clientY: 10,
    }));
    window.dispatchEvent(new MouseEvent("mouseup", {
      bubbles: true, clientX: 98, clientY: 10,
    }));
    input.dispatchEvent(new KeyboardEvent("keyup", { key: "Control", bubbles: true }));
    await settle();

    expect(doc.text()).toBe("abcDEFghiDEF");
    expect(doc.calls).toContain('edit(0:9,0:9,"DEF")');
    expect(doc.calls).not.toContain("editMany(2)");
    expect(editor.captureViewState().caret).toEqual({ line: 0, col: 12 });

    input.dispatchEvent(new KeyboardEvent("keydown", { key: "z", ctrlKey: true, bubbles: true }));
    await settle();
    expect(doc.text()).toBe("abcDEFghi");
    input.dispatchEvent(new KeyboardEvent("keydown", { key: "y", ctrlKey: true, bubbles: true }));
    await settle();
    expect(doc.text()).toBe("abcDEFghiDEF");
    input.dispatchEvent(new KeyboardEvent("keydown", { key: "z", ctrlKey: true, bubbles: true }));
    await settle();
    expect(doc.text()).toBe("abcDEFghi");

    layout.restore();
  });

  // Given: 文書が「abcDEFghi」、選択範囲が「DEF」である
  // When: キーボードイベントなしで、Ctrl付きのマウスイベントだけを末尾へ送る
  // Then: 元の文字列を残したまま末尾へコピーし、移動用のeditManyは呼ばない
  it("Scenario: マウスイベントのCtrl修飾だけでもコピーになる", async () => {
    const { editor, doc, host } = mount("abcDEFghi");
    editor.open(1, false);
    await settle();
    const layout = installMouseLayout(host);
    await editor.selectRange(0, 3, 6);
    const scroll = layout.scroll;

    scroll.dispatchEvent(new MouseEvent("mousedown", {
      bubbles: true, button: 0, clientX: 48, clientY: 10, ctrlKey: true,
    }));
    window.dispatchEvent(new MouseEvent("mousemove", {
      bubbles: true, clientX: 98, clientY: 10, ctrlKey: true,
    }));
    window.dispatchEvent(new MouseEvent("mouseup", {
      bubbles: true, clientX: 98, clientY: 10, ctrlKey: true,
    }));
    await settle();

    expect(doc.text()).toBe("abcDEFghiDEF");
    expect(doc.calls).toContain('edit(0:9,0:9,"DEF")');
    expect(doc.calls).not.toContain("editMany(2)");

    layout.restore();
  });

  // Given: 文書が「abc」、最初の backend edit が Error("ipc failed") で拒否される
  // When: Enter で失敗させた後に「x」を入力する
  // Then: 「編集を反映できませんでした」というエラーを1件通知し、後続入力の結果として文書に「x」が含まれる
  it("Scenario: キー編集失敗を通知し、次の編集queueは継続する", async () => {
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

  // Given: 10000行の文書、未取得行の行番号選択用行長取得が Error("ipc failed") で拒否される
  // When: 行番号をクリックして行選択を開始する
  // Then: 「行選択を更新できませんでした」というエラーを通知する
  it("Scenario: 行選択のIPC失敗をイベント境界で通知する", async () => {
    const { editor, doc, events, host } = mount(
      Array.from({ length: 10000 }, (_, i) => `line ${i}`).join("\n"),
    );
    editor.open(10000, false);
    await settle();
    const lineCharLen = vi.spyOn(doc.client, "lineCharLen").mockRejectedValueOnce(new Error("ipc failed"));
    const dropdown = document.createElement("div");
    dropdown.id = "dropdown";
    document.body.appendChild(dropdown);

    host.querySelector<HTMLElement>(".ve-gutter")!.dispatchEvent(
      new MouseEvent("mousedown", { bubbles: true, button: 0, clientY: 300000 }),
    );
    await settle();
    expect(lineCharLen).toHaveBeenCalled();
    await vi.waitFor(() => expect(events.errors).toHaveLength(1));

    expect(events.errors[0].message).toBe("行選択を更新できませんでした");
    window.dispatchEvent(new MouseEvent("mouseup"));
    dropdown.remove();
  });

  // Given: 文書が「abc」、textarea からの入力用 backend edit が最初だけ Error("ipc failed") で拒否される
  // When: textarea に「x」を入力して失敗した後、同じ入力イベントを再送する
  // Then: 失敗直後は textarea に「x」が戻り、再試行で文書へ反映される
  it("Scenario: textarea入力のIPC失敗時に未反映文字を保持して再試行できる", async () => {
    const { editor, doc, events, input, type } = mount("abc");
    editor.open(1, false);
    await settle();
    vi.spyOn(doc.client, "edit").mockRejectedValueOnce(new Error("ipc failed"));

    type("x");
    await vi.waitFor(() => expect(events.errors).toHaveLength(1));
    expect(input.value).toBe("x");

    input.dispatchEvent(new InputEvent("input"));
    await vi.waitFor(() => expect(doc.text()).toBe("xabc"));
    expect(input.value).toBe("");
  });

  // Given: 文書が「abc」、clipboard write が Error("denied") で拒否される
  // When: Ctrl+A の後に Ctrl+C を実行する
  // Then: 「クリップボードへコピーできませんでした」というエラーを1件通知する
  it("Scenario: Clipboard失敗をイベント境界で通知する", async () => {
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

  // Given: 文書が「memo」、画像BlobがPNG形式でバイト列 [1,2,3]、saveImage が相対パスを返す
  // When: その画像を clipboardData.items から paste する
  // Then: paste が preventDefault され、saveImage([1,2,3], "image/png") が呼ばれ、文書に `<img src="image_markdown/memo/pasted-image.png" alt="貼り付け画像" width="900">` が含まれる
  it("Scenario: 画像の貼り付けで相対リンク付きタグを挿入する", async () => {
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

  // Given: 外部ファイルパスが「C:\work\memo.txt」、revealInExplorer がspyである
  // When: .ve-scroll 上で contextmenu を開き「エクスプローラで開く」をクリックする
  // Then: revealInExplorer が実ファイルのパスで1回だけ呼ばれる
  it("Scenario: 保存済みメモの右クリックから実ファイルをExplorerで開く", async () => {
    const revealInExplorer = vi.fn();
    const { editor, host } = mount("memo", undefined, {
      revealInExplorer,
    });
    const dropdown = document.createElement("div");
    dropdown.id = "dropdown";
    document.body.appendChild(dropdown);
    editor.open(1, false, false, "C:\\work\\memo.txt");
    await settle();

    host.querySelector<HTMLElement>(".ve-scroll")!.dispatchEvent(
      new MouseEvent("contextmenu", { bubbles: true, clientX: 0, clientY: 0 }),
    );
    expect([...dropdown.querySelectorAll<HTMLElement>(".dd-label")].map((element) => element.textContent)).toEqual([
      "エクスプローラで開く",
      "元に戻す",
      "やり直し",
      "切り取り",
      "コピー",
      "貼り付け",
      "削除",
      "すべて選択",
      "CSVビュー",
      "Markdownビュー",
      "Imageビュー",
      "PDFビュー",
      "html(静的)",
      "アプリで開く",
    ]);
    expect(dropdown.querySelector<HTMLElement>(".dd-label")?.textContent).toBe("エクスプローラで開く");
    const editorIcons = [
      ["エクスプローラで開く", MENU_ICON.explorer],
      ["元に戻す", MENU_ICON.undo],
      ["やり直し", MENU_ICON.redo],
      ["切り取り", MENU_ICON.cut],
      ["コピー", MENU_ICON.copy],
      ["貼り付け", MENU_ICON.paste],
      ["削除", MENU_ICON.delete],
      ["すべて選択", MENU_ICON.selectAll],
      ["CSVビュー", MENU_ICON.csv],
      ["Markdownビュー", MENU_ICON.markdown],
      ["Imageビュー", MENU_ICON.image],
      ["PDFビュー", MENU_ICON.pdf],
      ["html(静的)", MENU_ICON.html],
      ["アプリで開く", MENU_ICON.external],
    ] as const;
    for (const [label, icon] of editorIcons) {
      const menuItem = [...dropdown.querySelectorAll<HTMLElement>(".dd-item")]
        .find((element) => element.textContent === label);
      expect(menuItem?.querySelector(`.${icon}`), label).not.toBeNull();
    }
    expect(dropdown.querySelectorAll(".dd-sep")).toHaveLength(4);
    const item = [...dropdown.querySelectorAll<HTMLElement>(".dd-item")]
      .find((element) => element.textContent === "エクスプローラで開く");
    item?.click();
    await settle();

    expect(revealInExplorer).toHaveBeenCalledWith("C:\\work\\memo.txt", false);
  });

  // Given: 外部ファイルパスと新規ウィンドウ操作がある
  // When: エディタの右クリックメニューから新規ウィンドウで開く
  // Then: 外部ファイルパスを新規ウィンドウ操作へ渡す
  it("Scenario: エディタの右クリックから新規ウィンドウで開く", async () => {
    const openInNewWindow = vi.fn();
    const { editor, host } = mount("memo", undefined, {
      revealInExplorer: vi.fn(),
      openInNewWindow,
    });
    const dropdown = document.createElement("div");
    dropdown.id = "dropdown";
    document.body.appendChild(dropdown);
    editor.open(1, false, false, "C:\\work\\memo.txt");
    await settle();

    host.querySelector<HTMLElement>(".ve-scroll")!.dispatchEvent(
      new MouseEvent("contextmenu", { bubbles: true, clientX: 0, clientY: 0 }),
    );
    [...dropdown.querySelectorAll<HTMLElement>(".dd-item")]
      .find((item) => item.textContent === "新規ウィンドウで開く")!.click();
    await settle();

    expect(openInNewWindow).toHaveBeenCalledWith("C:\\work\\memo.txt");
  });

  // Given: Editorへ文書Aを表示し、次に文書B、最後に無題文書を表示する
  // When: 各表示状態でEditor本文を右クリックする
  // Then: Explorer対象はAからBへ更新され、無題文書ではメニューから消える
  it("Scenario: 文書切替でExplorer対象を更新し無題文書で消去する", async () => {
    const revealInExplorer = vi.fn();
    const { editor, host } = mount("memo", undefined, { revealInExplorer });
    const dropdown = document.createElement("div");
    dropdown.id = "dropdown";
    document.body.appendChild(dropdown);
    const openExplorer = async () => {
      host.querySelector<HTMLElement>(".ve-scroll")!.dispatchEvent(
        new MouseEvent("contextmenu", { bubbles: true, clientX: 0, clientY: 0 }),
      );
      const item = [...dropdown.querySelectorAll<HTMLElement>(".dd-item")]
        .find((element) => element.textContent === "エクスプローラで開く");
      item?.click();
      await settle();
    };

    editor.open(1, false, false, "C:\\work\\a.txt");
    await settle();
    await openExplorer();
    expect(revealInExplorer).toHaveBeenLastCalledWith("C:\\work\\a.txt", false);

    editor.open(1, false, false, "C:\\work\\b.txt");
    await settle();
    await openExplorer();
    expect(revealInExplorer).toHaveBeenLastCalledWith("C:\\work\\b.txt", false);

    editor.open(1, false);
    await settle();
    host.querySelector<HTMLElement>(".ve-scroll")!.dispatchEvent(
      new MouseEvent("contextmenu", { bubbles: true, clientX: 0, clientY: 0 }),
    );
    expect([...dropdown.querySelectorAll<HTMLElement>(".dd-label")].map((item) => item.textContent))
      .not.toContain("エクスプローラで開く");
  });

  // Given: 外部ファイルパスがあり、Explorer起動がError("explorer failed")で拒否される
  // When: 保存済みメモの右クリックから「エクスプローラで開く」をクリックする
  // Then: エディタのエラー境界から「エクスプローラで開けませんでした」を通知する
  it("Scenario: 保存済みメモのExplorer起動失敗を通知する", async () => {
    const revealInExplorer = vi.fn().mockRejectedValue(new Error("explorer failed"));
    const { editor, host, events } = mount("memo", undefined, {
      revealInExplorer,
    });
    const dropdown = document.createElement("div");
    dropdown.id = "dropdown";
    document.body.appendChild(dropdown);
    editor.open(1, false, false, "C:\\work\\memo.txt");
    await settle();

    host.querySelector<HTMLElement>(".ve-scroll")!.dispatchEvent(
      new MouseEvent("contextmenu", { bubbles: true, clientX: 0, clientY: 0 }),
    );
    [...dropdown.querySelectorAll<HTMLElement>(".dd-item")]
      .find((element) => element.textContent === "エクスプローラで開く")!.click();

    await vi.waitFor(() => expect(events.errors).toContainEqual({
      message: "エクスプローラで開けませんでした",
      error: expect.any(Error),
    }));
  });

  // Given: 外部ファイルパスがあり、文書を閲覧専用で開いている
  // When: .ve-scroll 上でコンテキストメニューを開く
  // Then: 編集項目と登録系項目を出さず、Explorerを先頭に維持する
  it("Scenario: 閲覧専用メモの右クリック項目を編集なしで並べる", async () => {
    const { editor, host } = mount("memo", undefined, {
      revealInExplorer: vi.fn(),
    });
    const dropdown = document.createElement("div");
    dropdown.id = "dropdown";
    document.body.appendChild(dropdown);
    editor.open(1, true, false, "C:\\work\\memo.txt");
    await settle();

    host.querySelector<HTMLElement>(".ve-scroll")!.dispatchEvent(
      new MouseEvent("contextmenu", { bubbles: true, clientX: 0, clientY: 0 }),
    );

    expect([...dropdown.querySelectorAll<HTMLElement>(".dd-label")].map((item) => item.textContent)).toEqual([
      "エクスプローラで開く",
      "コピー",
      "すべて選択",
      "CSVビュー",
      "Markdownビュー",
      "Imageビュー",
      "PDFビュー",
      "html(静的)",
      "アプリで開く",
    ]);
    expect(dropdown.querySelectorAll(".dd-sep")).toHaveLength(3);
    for (const [label, icon] of [
      ["エクスプローラで開く", MENU_ICON.explorer],
      ["コピー", MENU_ICON.copy],
      ["すべて選択", MENU_ICON.selectAll],
      ["CSVビュー", MENU_ICON.csv],
      ["Markdownビュー", MENU_ICON.markdown],
      ["Imageビュー", MENU_ICON.image],
      ["PDFビュー", MENU_ICON.pdf],
      ["html(静的)", MENU_ICON.html],
      ["アプリで開く", MENU_ICON.external],
    ] as const) {
      const item = [...dropdown.querySelectorAll<HTMLElement>(".dd-item")]
        .find((element) => element.textContent === label);
      expect(item?.querySelector(`.${icon}`), label).not.toBeNull();
    }
  });

  // Given: 文書が「one\ntwo」、dropdown が存在する
  // When: .ve-gutter 上で contextmenu を開く
  // Then: dropdown のラベルに「すべて選択」が含まれ、Explorerは含まれない
  it("Scenario: メモビューの行番号を右クリックしてもコンテキストメニューを表示する", async () => {
    const { editor, host } = mount("one\ntwo");
    const dropdown = document.createElement("div");
    dropdown.id = "dropdown";
    document.body.appendChild(dropdown);
    editor.open(2, false);
    await settle();

    host.querySelector<HTMLElement>(".ve-gutter")!.dispatchEvent(
      new MouseEvent("contextmenu", { bubbles: true, clientX: 0, clientY: 0 }),
    );

    expect([...dropdown.querySelectorAll<HTMLElement>(".dd-label")].map((item) => item.textContent))
      .toContain("すべて選択");
    expect([...dropdown.querySelectorAll<HTMLElement>(".dd-label")].map((item) => item.textContent))
      .not.toContain("エクスプローラで開く");
  });

  // Given: 文書が「https://example.com」、選択範囲がURL全体、promptFields が「ブラウザ」「」「open {string}」を返し、外部パスが「C:\work\memo.txt」
  // When: 「コマンドを登録...」を選び、登録されたコマンドを選んで実行し、その後実行失敗も発生させる
  // Then: 第3入力欄のラベルが「コマンド（{string}=対象文字列、引用符不要）」で、成功時に runExternalCommand('open "https://example.com"', 'C:\work\memo.txt') が呼ばれ、失敗時に「登録コマンドを実行できませんでした」と Error を含むイベントが通知される
  it("Scenario: メモビューの登録コマンドへ選択文字列を渡す", async () => {
    const promptFields = vi.fn(async () => ["ブラウザ", "", "open {string}"]);
    const runExternalCommand = vi.fn(async () => {});
    const registeredCommandPorts: RegisteredCommandMenuPorts = { promptFields, runExternalCommand };
    const { editor, host, events } = mount("https://example.com", undefined, {
      revealInExplorer: vi.fn(),
      registeredCommandPorts,
    });
    const dropdown = document.createElement("div");
    dropdown.id = "dropdown";
    document.body.appendChild(dropdown);
    editor.open(1, false, false, "C:\\work\\memo.txt");
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
    expect([...dropdown.querySelectorAll<HTMLElement>(".dd-label")].map((item) => item.textContent)).toEqual([
      "エクスプローラで開く",
      "元に戻す",
      "やり直し",
      "切り取り",
      "コピー",
      "貼り付け",
      "削除",
      "すべて選択",
      "選択範囲を登録文字列に追加",
      "コマンドを登録...",
      "CSVビュー",
      "Markdownビュー",
      "Imageビュー",
      "PDFビュー",
      "html(静的)",
      "アプリで開く",
    ]);
    for (const [label, icon] of [
      ["エクスプローラで開く", MENU_ICON.explorer],
      ["選択範囲を登録文字列に追加", MENU_ICON.registeredString],
      ["コマンドを登録...", MENU_ICON.command],
    ] as const) {
      const item = [...dropdown.querySelectorAll<HTMLElement>(".dd-item")]
        .find((element) => element.textContent === label);
      expect(item?.querySelector(`.${icon}`), label).not.toBeNull();
    }
    [...dropdown.querySelectorAll<HTMLElement>(".dd-item")]
      .find((item) => item.textContent === "コマンドを登録...")!.click();

    await vi.waitFor(() => expect(promptFields).toHaveBeenCalled());
    const fields = (promptFields.mock.calls[0] as unknown as [string, { label: string }[]])[1];
    expect(fields[2].label).toBe("コマンド（{string}=対象文字列、引用符不要）");

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

  // Given: 文書が「https://example.com」、選択範囲がURL全体、updateSetting が Error("save failed") で拒否される
  // When: contextmenu から「コマンドを登録...」をクリックする
  // Then: 「コマンドを登録できませんでした」と Error を含むイベントが通知される
  it("Scenario: メモビューの登録コマンド保存失敗を通知する", async () => {
    const promptFields = vi.fn(async () => ["ブラウザ", "", "open {string}"]);
    const registeredCommandPorts: RegisteredCommandMenuPorts = {
      promptFields,
      runExternalCommand: vi.fn(async () => {}),
    };
    const { editor, host, events } = mount("https://example.com", undefined, {
      registeredCommandPorts,
    });
    const dropdown = document.createElement("div");
    dropdown.id = "dropdown";
    document.body.appendChild(dropdown);
    editor.open(1, false, false, "C:\\work\\memo.txt");
    await editor.restoreViewState({
      anchor: { line: 0, col: 0 },
      caret: { line: 0, col: 19 },
      topLine: 0,
      wrapIntraLinePx: 0,
      scrollLeft: 0,
    });
    updateSetting.mockRejectedValueOnce(new Error("save failed"));

    host.querySelector<HTMLElement>(".ve-scroll")!.dispatchEvent(
      new MouseEvent("contextmenu", { bubbles: true, clientX: 0, clientY: 0 }),
    );
    [...dropdown.querySelectorAll<HTMLElement>(".dd-item")]
      .find((item) => item.textContent === "コマンドを登録...")!.click();

    await vi.waitFor(() => expect(events.errors).toContainEqual({
      message: "コマンドを登録できませんでした",
      error: expect.any(Error),
    }));
  });

  // Given: 文書が「one\ntwo」、編集モードで開いている
  // When: goTo(1, 2) を実行する
  // Then: onCursor の通知値が1始まりの [2, 3] になる
  it("Scenario: goTo はキャレット位置を1始まりで通知する", async () => {
    const { editor, events } = mount("one\ntwo");
    editor.open(2, false);
    await settle();
    editor.goTo(1, 2);
    await settle();
    expect(events.cursor).toEqual([2, 3]);
  });

  // Given: 40行の文書、scroll.clientHeight=100、editor.open(40, false) の状態
  // When: goTo(20, 0) を実行する
  // Then: captureViewState().topLine が18、scroll.scrollTop が360になる
  it("Scenario: goTo も対象行をメモビューの中央へ置く", async () => {
    const { editor, host } = mount(Array.from({ length: 40 }, (_, i) => `line ${i}`).join("\n"));
    const scroll = host.querySelector<HTMLElement>(".ve-scroll")!;
    Object.defineProperty(scroll, "clientHeight", { configurable: true, value: 100 });
    editor.open(40, false);

    editor.goTo(20, 0);

    expect(editor.captureViewState().topLine).toBe(18);
    expect(scroll.scrollTop).toBe(360);
  });

  // Given: 40行の文書、clientHeight=100、topLine=2、キャレットが表示領域の最下行である6行目6列目
  // When: Enter で7行目を作り、その行へ「continued」を続けて入力する
  // Then: 入力内容が文書へ反映され、キャレット行7が表示され続けるため topLine=3、scrollTop=60になる
  it("Scenario: 表示領域の最下行で改行して続けて入力しても新しいキャレット行を表示する", async () => {
    const { editor, doc, host, press, type } = mount(Array.from({ length: 40 }, (_, i) => `line ${i}`).join("\n"));
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
    type("continued");
    await settle();

    expect(editor.captureViewState().caret).toEqual({ line: 7, col: 9 });
    expect(doc.text()).toContain("continued\nline 7");
    expect(editor.captureViewState().topLine).toBe(3);
    expect(scroll.scrollTop).toBe(60);
  });

  // Given: 文書が「start」、clientHeight=100、編集モードで開いている
  // When: 改行を8回連続入力する
  // Then: キャレットが8行目0列目、topLine が4、scrollTop が80になる
  it("Scenario: 文書末尾で改行文字を連続入力しても常に入力行を表示する", async () => {
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

  // Given: 1行だけの新規メモ、clientHeight=100、編集モードで開いている
  // When: Enterを10回連続入力する
  // Then: 11行分のスクロール範囲を作り、末尾行を表示しながら直前の行も描画する
  it("Scenario: 新規メモでEnterを連打しても行数とスクロール範囲が増える", async () => {
    const { editor, doc, host, press } = mount("");
    const scroll = host.querySelector<HTMLElement>(".ve-scroll")!;
    const inner = host.querySelector<HTMLElement>(".ve-inner")!;
    Object.defineProperty(scroll, "clientHeight", { configurable: true, value: 100 });
    editor.open(1, false);
    await settle();

    for (let i = 0; i < 10; i += 1) {
      press("Enter");
      await settle();
    }

    expect(editor.captureViewState().caret).toEqual({ line: 10, col: 0 });
    expect(doc.text()).toBe("\n".repeat(10));
    expect(inner.style.height).toBe("220px");
    expect(scroll.scrollTop).toBe(120);
    expect(host.querySelectorAll<HTMLElement>(".ve-gnum")).toHaveLength(11);
    expect([...host.querySelectorAll<HTMLElement>(".ve-gnum")].map((row) => row.dataset.line)).toContain("10");
  });

  // Feature: 編集中の垂直スクロール保持
  // Scenario: 行途中の表示位置で文字を編集してもスクロール位置を変えない
  // Given: 40行のメモを表示し、行頭に揃っていない位置を表示している
  // When: 表示中の行へ文字を入力する
  // Then: 編集前のピクセル単位の垂直スクロール位置を保持する
  it("行途中の表示位置で編集しても垂直スクロール位置を保持する", async () => {
    const { editor, host, type } = mount(Array.from({ length: 40 }, (_, i) => `line ${i}`).join("\n"));
    const scroll = host.querySelector<HTMLElement>(".ve-scroll")!;
    Object.defineProperty(scroll, "clientHeight", { configurable: true, value: 100 });
    editor.open(40, false);
    await editor.restoreViewState({
      anchor: { line: 4, col: 1 },
      caret: { line: 4, col: 1 },
      topLine: 2,
      wrapIntraLinePx: 0,
      scrollLeft: 0,
    });
    scroll.scrollTop = 47;

    type("X");
    await settle();

    expect(scroll.scrollTop).toBe(47);
  });

  // Given: 40行の文書、clientHeight=100、編集モードで開いている
  // When: 20行目の0列目から4列目を selectRange する
  // Then: topLine が18、scrollTop が360になる
  it("Scenario: 検索結果の範囲選択は対象行をメモビューの中央へ置く", async () => {
    const { editor, host } = mount(Array.from({ length: 40 }, (_, i) => `line ${i}`).join("\n"));
    const scroll = host.querySelector<HTMLElement>(".ve-scroll")!;
    Object.defineProperty(scroll, "clientHeight", { configurable: true, value: 100 });
    editor.open(40, false);

    await editor.selectRange(20, 0, 4);

    expect(editor.captureViewState().topLine).toBe(18);
    expect(scroll.scrollTop).toBe(360);
  });

  // Given: 40行の文書、clientHeight=100、forward=true/false、検索結果が20行目0〜7列
  // When: 検索欄に「line 20」を設定して次へ/前へを押す
  // Then: どちらの方向でも topLine が18、scrollTop が360になる
  it.each([
    ["次へ", true],
    ["前へ", false],
  ])("Scenario: 本文検索の%s結果は対象行をメモビューの中央へ置く", async (_label, forward) => {
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

  // Given: 古い40行文書で検索結果が release まで保留され、検索結果が旧文書20行目を指している
  // When: 旧文書を検索中に editor.open(1, false) で新文書へ切り替え、release して settle する
  // Then: 保留されていた旧検索結果で移動せず、キャレットが0行0列、topLine が0のままになる
  it("Scenario: 文書切替中に保留された本文検索結果を新しい文書へ適用しない", async () => {
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

  // Given: 文書が「needle」、最初の検索は一致し、failed=true 後の検索は Error("find failed") で失敗する
  // When: 1回目の検索後に2回目の検索を失敗させ、「changed」を入力して置換次へをクリックする
  // Then: edit( で始まる呼び出しが0件で、直前の一致を使った置換を実行しない
  it("Scenario: 本文検索に失敗した後、連続置換が直前の一致を再利用しない", async () => {
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

  // Given: 古い文書の lines 読み込みが blocked で保留されている
  // When: 20行目を selectRange している途中で editor.open(1, false) に切り替え、blocked を release する
  // Then: 古い選択結果が新文書へ適用されず、キャレットが0行0列になる
  it("Scenario: 文書切替中に保留された古い検索結果を新しい文書へ適用しない", async () => {
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

  // Given: 40行の文書、clientHeight=100、scrollTop=200、入力欄にフォーカスがある
  // When: scroll イベント後に IME の compositionstart を発生させる
  // Then: IME textarea の top が「0px」で、textarea の親要素が host になる
  it("Scenario: スクロール直後のIME入力位置を表示領域内へ維持する", async () => {
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

  // Given: 文書が「line」、入力欄の top を「-999px」に設定してフォーカスしている
  // When: window の focus イベント後に compositionstart を発生させる
  // Then: top が「-999px」から補正され、IME textarea の幅が4px以上になる
  it("Scenario: ウィンドウ復帰時にIME入力位置を再同期する", async () => {
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

  // Given: 文書が「line」、入力欄の left を「-999px」に設定してフォーカスしている
  // When: window の resize イベントを発生させる
  // Then: input.style.left が「-999px」ではなくなる
  it("Scenario: ウィンドウの横幅変更時にIME入力位置を再同期する", async () => {
    const { editor, input } = mount("line");
    editor.open(1, false);
    await settle();
    input.focus();
    input.style.left = "-999px";

    window.dispatchEvent(new Event("resize"));
    await settle();

    expect(input.style.left).not.toBe("-999px");
  });

  // Given: 文書が「line」、入力欄にフォーカスがあり blur をspyしている
  // When: syncWindowGeometry() を実行して80ms待つ
  // Then: blur が1回呼ばれ、document.activeElement が document.body になる
  it("Scenario: ウィンドウ変更後にIME用textareaを次のユーザー操作までblurする", async () => {
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

  // Given: 文書が「line」、入力欄ではなく host 内の button にフォーカスがある
  // When: syncWindowGeometry() を実行して80ms待つ
  // Then: input.focus は呼ばれず、document.activeElement はその button のままになる
  it("Scenario: ウィンドウ変更後も別UIからフォーカスを奪わない", async () => {
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

  // Given: 文書が「line」、IME composition中で入力欄にフォーカスがある
  // When: syncWindowGeometry() 後70ms待ち、compositionend 後さらに80ms待つ
  // Then: composition中は blur が呼ばれず、変換終了後に1回だけ blur が呼ばれ、activeElement が body になる
  it("Scenario: IME変換中のフォーカス再初期化は変換終了まで待つ", async () => {
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

  // Given: scroll領域の矩形が左40・上20・右240・下120、host矩形が左0・上0・右300・下150、IME textarea矩形が左上(-100,-100)の領域外
  // When: syncWindowGeometry() を実行する
  // Then: input.style.left が「48px」、top が「20px」になる
  it("Scenario: IMEアンカーの実矩形が領域外なら安全位置へ退避する", async () => {
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

  // Given: scroll.clientWidth=100、input.scrollWidth=500、IME変換中文字列が「長い変換中文字列」
  // When: compositionstart 後に composing input を発生させる
  // Then: input の幅が88px以下に制限され、scroll.scrollLeft が0より大きくなる
  it("Scenario: IME変換中文字列の幅を表示領域内に制限する", async () => {
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

  // Given: 文書が「0123456789」、折り返し有効、0行目3列目を選択し、scroll.clientWidth=300
  // When: IMEに「AB」を入力する
  // Then: input の幅が100px未満、input に ime class が付き、.ve-line の本文は「0123456789」のままになる
  it("Scenario: 折り返し中のIME背景は変換中文字列の範囲だけを覆う", async () => {
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

  // Given: 1000文字の1論理行を折り返し、キャレットが500列目、clientHeight=100、clientWidth=300、scrollTop=900、編集位置の矩形が上940〜960px
  // When: compositionstart を発生させる
  // Then: input.style.top が「40px」、left が8px以上になる
  it("Scenario: 長い折り返し行の途中ではIMEを実際の編集位置へ表示する", async () => {
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

  // Given: 1000文字の1論理行を折り返し、.ve-line の実矩形高さを2000px、scroll.clientHeight=100に設定している
  // When: deltaY=80 の wheel イベントを発生させる
  // Then: line.style.top - scroll.scrollTop が -80 になる
  it("Scenario: 1論理行が多数行へ折り返されてもホイールで行内を移動する", async () => {
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

  // Given: 1000文字の折り返し行、scroll領域100×100、.ve-line の実矩形高さ2000px
  // When: scroll処理後に横のつまみ位置で mousedown し、scrollTop=950 へ移動して mouseup する
  // Then: .ve-inner の高さが2000px、描画行の top - scrollTop が -950 になる
  it("Scenario: 長い折り返し1行でも縦スクロールバーを表示し、つまみ位置へ移動する", async () => {
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

  // Given: 文書が「ab」、IME入力「漢字」を開始して composing input 済み
  // When: compositionend を送らず blur する
  // Then: input から ime class が外れ、input.value が空、文書が「漢字ab」になる
  it("Scenario: compositionendが来ないblurでもIME状態と入力を回収する", async () => {
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

  // Given: 文書が「wide line」、通常表示で本文スクロールと独立横スクロールがある
  // When: hScroll を80へスクロールし、本文を25へスクロールした後、折り返しを有効にする
  // Then: 本文側が80、横スクロール側が25へ双方向同期し、折り返し時は hScroll.hidden と host の hscroll-hidden が true になる
  it("Scenario: 横スクロールバーを本文から分離して双方向に同期する", async () => {
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

  // Given: 50文字の1行文書、scroll.clientWidth=100、範囲終端列×10の矩形を返す Range
  // When: 0行目20列から30列まで selectRange する
  // Then: scroll.scrollLeft が0より大きくなり、hScroll.scrollLeft が本文側と同値になる
  it("Scenario: 文書切替直後の範囲選択を読み込み後に横方向へ表示する", async () => {
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

  // Given: 初回の長大行取得が保留され、scroll.clientWidth=100、範囲終端列×10の矩形を返す Range
  // When: 取得中に0行目700〜704列を selectRange し、行取得を完了する
  // Then: プレースホルダーではなく実行位置を計測し、横スクロールが0より大きくなる
  it("Scenario: 長大行の取得中に選択しても検索位置へ横スクロールする", async () => {
    const rect = vi.spyOn(Range.prototype, "getBoundingClientRect").mockImplementation(function (this: Range) {
      return {
        x: 0, y: 0, top: 0, left: 0, right: this.endOffset * 10, bottom: 20,
        width: this.endOffset * 10, height: 20, toJSON: () => ({}),
      } as DOMRect;
    });
    const { editor, doc, host } = mount("x".repeat(1000));
    const scroll = host.querySelector<HTMLElement>(".ve-scroll")!;
    Object.defineProperty(scroll, "clientWidth", { configurable: true, value: 100 });
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const originalLines = doc.client.lines;
    doc.client.lines = async (...args) => {
      await gate;
      return originalLines(...args);
    };

    editor.open(1, false);
    const selecting = editor.selectRange(0, 700, 704);
    await settle(1);
    release();
    await selecting;

    expect(scroll.scrollLeft).toBeGreaterThan(0);
    rect.mockRestore();
  });

  // Given: 1論理行を折り返し、選択範囲の実矩形が上940〜960px、scroll.clientHeight=100
  // When: 0行目700〜704列を selectRange する
  // Then: 選択範囲の中央が表示領域の中央に配置される
  it("Scenario: 折り返し時は検索結果の選択文字列を表示領域中央へ置く", async () => {
    const lineRect = vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (this: HTMLElement) {
      const height = this.classList.contains("ve-line") ? 2000 : 0;
      return {
        x: 0, y: 0, left: 0, top: 0, right: 100, bottom: height,
        width: 100, height, toJSON: () => ({}),
      } as DOMRect;
    });
    const selectionRect = {
      x: 0, y: 940, left: 0, top: 940, right: 40, bottom: 960,
      width: 40, height: 20, toJSON: () => ({}),
    } as DOMRect;
    const ranges = Object.assign([selectionRect], { item: (index: number) => [selectionRect][index] ?? null });
    const rangeRects = vi.spyOn(Range.prototype, "getClientRects").mockReturnValue(ranges as DOMRectList);
    const { editor, host } = mount("x".repeat(1000));
    const scroll = host.querySelector<HTMLElement>(".ve-scroll")!;
    const inner = host.querySelector<HTMLElement>(".ve-inner")!;
    Object.defineProperties(scroll, {
      clientHeight: { configurable: true, value: 100 },
      scrollHeight: { configurable: true, get: () => Number.parseFloat(inner.style.height) || 0 },
    });

    editor.open(1, false);
    editor.setWrap(true);
    await settle();
    await editor.selectRange(0, 700, 704);

    const selection = host.querySelector<HTMLElement>(".ve-sel")!;
    const selectionCenter = Number.parseFloat(selection.style.top) + Number.parseFloat(selection.style.height) / 2;
    expect(selectionCenter).toBeCloseTo(scroll.scrollTop + scroll.clientHeight / 2);

    rangeRects.mockRestore();
    lineRect.mockRestore();
  });

  // Given: 40行の文書、clientHeight=100、scrollTop=200・scrollLeft=35、12行目1〜4列を選択して view state を保存している
  // When: 文書を再openし、保存した view state を restore する
  // Then: anchor、caret、topLine、scrollLeft が保存前の state とそれぞれ同値になる
  it("Scenario: 選択位置と縦横の表示位置を復元する", async () => {
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

  // Given: 旧文書の行取得を保留したまま view state の復元を開始する
  // When: 復元完了前に別文書を open してから旧取得を解決する
  // Then: 旧文書の選択位置を新文書へ適用しない
  it("Scenario: 文書切替中の古い表示状態を新文書へ復元しない", async () => {
    const { editor, doc } = mount("old");
    let release!: (lines: string[]) => void;
    const oldLines = new Promise<string[]>((resolve) => { release = resolve; });
    let calls = 0;
    doc.client.lines = async () => calls++ === 0 ? oldLines : ["new"];

    editor.open(1, false);
    await Promise.resolve();
    const restoring = editor.restoreViewState({
      anchor: { line: 0, col: 2 },
      caret: { line: 0, col: 3 },
      topLine: 0,
      wrapIntraLinePx: 0,
      scrollLeft: 24,
    });
    editor.open(1, false);
    release(["old"]);
    await restoring;

    expect(editor.captureViewState().anchor).toEqual({ line: 0, col: 0 });
    expect(editor.captureViewState().caret).toEqual({ line: 0, col: 0 });
  });

  // Given: 文書が「first\nsecond」、first の0〜5列を選択している
  // When: 選択状態を描画する
  // Then: 行番号に selected-line と caret-line が付き、本文行には selected-line/caret-line が付かず、.ve-line-highlight も存在しない
  it("Scenario: キャレット行と選択行を行番号の背景だけで強調する", async () => {
    const { editor, host } = mount("first\nsecond");
    editor.open(2, false);
    await editor.selectRange(0, 0, 5);

    expect(host.querySelector(".ve-gnum.selected-line.caret-line")).not.toBeNull();
    expect(host.querySelector(".ve-line.selected-line, .ve-line.caret-line")).toBeNull();
    expect(host.querySelector(".ve-line-highlight")).toBeNull();
  });

  // Given: 文書が「line」、キャレットを0行0列に復元し、caret要素が存在する
  // When: editor.focus() 後に入力欄を blur する
  // Then: フォーカス中は caret の on class が true、blur 後は false になる
  it("Scenario: フォーカス中のキャレットは常時表示し、フォーカスを失うと隠す", async () => {
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

  // Given: 3行の本文で2行目から3行目までを選択している
  // When: CSVビューを開く
  // Then: 選択範囲だけを本文として渡し、行番号にPを表示する
  it("Scenario: opens a selected range as the preview source", async () => {
    const openViewer = vi.fn(async () => "inline-viewer");
    const { editor, host } = mount("one\ntwo\nthree", undefined, { openViewer });
    editor.open(3, false);
    await settle();
    await editor.restoreViewState({
      anchor: { line: 1, col: 0 },
      caret: { line: 2, col: 5 },
      topLine: 0,
      wrapIntraLinePx: 0,
      scrollLeft: 0,
    });

    await editor.openTextViewer("csv");

    expect(openViewer).toHaveBeenCalledWith("csv", "two\nthree", {
      start: { line: 0, col: 0 },
      end: { line: 1, col: 5 },
      caret: { line: 1, col: 5 },
    });
    const marks = [...host.querySelectorAll<HTMLElement>(".ve-preview-mark")];
    expect(marks.filter((mark) => !mark.hidden).map((mark) => mark.textContent)).toEqual(["P", "P"]);
    expect(marks.filter((mark) => mark.hidden)).toHaveLength(1);
  });

  // Given: 選択範囲だけを対象にしたCSVビューが開き、エディタのキャレットが範囲内にある
  // When: プレビュー側からMarkdownへ形式を切り替える
  // Then: 切替後も同じ選択範囲だけを本文として渡す
  it("Scenario: keeps the selected preview range when changing format", async () => {
    const openViewer = vi.fn<EditorPorts["openViewer"]>(async () => "inline-viewer");
    const { editor } = mount("one\ntwo\nthree", undefined, { openViewer });
    editor.open(3, false);
    await settle();
    await editor.restoreViewState({
      anchor: { line: 1, col: 0 },
      caret: { line: 2, col: 5 },
      topLine: 0,
      wrapIntraLinePx: 0,
      scrollLeft: 0,
    });

    await editor.openTextViewer("csv");
    editor.goTo(1, 0);
    await editor.openTextViewer("markdown", true);

    expect(openViewer.mock.calls[1][0]).toBe("markdown");
    expect(openViewer.mock.calls[1][1]).toBe("two\nthree");
  });

  // Given: プレビューが開いている
  // When: プレビューから文書位置を受け取る
  // Then: エディタのキャレットをその位置へ移し、中央表示処理を通す
  it("Scenario: moves the editor caret from a preview position", async () => {
    const openViewer = vi.fn(async () => "inline-viewer");
    const { editor, host } = mount("zero\none\ntwo", undefined, { openViewer });
    const scroll = host.querySelector<HTMLElement>(".ve-scroll")!;
    Object.defineProperties(scroll, {
      clientHeight: { configurable: true, value: 100 },
      clientWidth: { configurable: true, value: 100 },
    });
    editor.open(3, false);
    await settle();
    await editor.openTextViewer("markdown");
    await editor.goToPreview({
      start: { line: 2, col: 1 },
      end: { line: 2, col: 2 },
    });

    expect(editor.captureViewState().caret).toEqual({ line: 2, col: 2 });
    expect(host.querySelector(".ve-caret.on")).not.toBeNull();
  });

  // Given: 40行の文書、clientHeight=100・clientWidth=100、Range幅は列×10
  // When: プレビューから20行目12列を受け取る
  // Then: キャレット行を縦横とも表示領域の中央へ移動する
  it("Scenario: centers both scroll axes for a preview position", async () => {
    const rect = vi.spyOn(Range.prototype, "getBoundingClientRect").mockImplementation(function (this: Range) {
      return {
        x: 0, y: 0, top: 0, left: 0, right: this.endOffset * 10, bottom: 20,
        width: this.endOffset * 10, height: 20, toJSON: () => ({}),
      } as DOMRect;
    });
    const { editor, host } = mount(
      Array.from({ length: 40 }, (_, i) => `line ${i} ${"x".repeat(20)}`).join("\n"),
      undefined,
      { openViewer: vi.fn(async () => "preview") },
    );
    const scroll = host.querySelector<HTMLElement>(".ve-scroll")!;
    Object.defineProperties(scroll, {
      clientHeight: { configurable: true, value: 100 },
      clientWidth: { configurable: true, value: 100 },
    });
    editor.open(40, false);
    await settle();
    await editor.openTextViewer("markdown");
    await editor.goToPreview({
      start: { line: 20, col: 12 },
      end: { line: 20, col: 12 },
    });

    expect(editor.captureViewState().topLine).toBe(18);
    expect(scroll.scrollTop).toBe(360);
    expect(scroll.scrollLeft).toBeGreaterThan(0);
    rect.mockRestore();
  });
});
