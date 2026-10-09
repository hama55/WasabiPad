// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { openDiagramEditor, type DiagramEditorOptions } from "./diagram-dialog";
afterEach(() => { document.body.replaceChildren(); vi.restoreAllMocks(); vi.useRealTimers(); delete (SVGElement.prototype as SVGElement & { getBBox?: unknown }).getBBox; });
beforeEach(() => {
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue({ measureText: (text: string) => ({ width: Array.from(text).length * 10 }) } as CanvasRenderingContext2D);
});

// Feature: 図編集ダイアログ
// Scenario: 赤枠を描いて保存する
// Given: 白紙の図編集画面
// When: 四角形をドラッグして OK を押す
// Then: 四角形を保存しキャンバスを自動縮小しない
it("Scenario: 四角形を描いて確定できる", async () => {
  let saved: unknown;
  const result = openDiagramEditor({ initial: { width: 800, height: 600, elements: [] }, sources: new Map(), save: async (diagram) => { saved = diagram; } });
  const canvas = document.querySelector<SVGSVGElement>(".diagram-canvas")!;
  canvas.getBoundingClientRect = () => ({ left: 0, top: 0, width: 800, height: 600 } as DOMRect);
  button("四角形").click();
  canvas.dispatchEvent(new MouseEvent("pointerdown", { clientX: 20, clientY: 30, bubbles: true, button: 0 }));
  window.dispatchEvent(new MouseEvent("pointermove", { clientX: 120, clientY: 90 }));
  window.dispatchEvent(new MouseEvent("pointerup", { clientX: 120, clientY: 90 }));
  button("OK").click();
  await result;
  expect(saved).toMatchObject({ width: 800, height: 600, elements: [{ kind: "rect", x: 20, y: 30, width: 100, height: 60, stroke: "#ff0000" }] });
});

// Feature: 図編集ダイアログ
// Scenario: 変更なしは保存せず閉じる
// Given: 白紙の編集画面
// When: OK を押す
// Then: 保存を呼ばない
it("Scenario: 白紙のまま OK でファイルを作らない", async () => {
  const save = vi.fn(async () => {});
  const result = openDiagramEditor({ initial: { width: 800, height: 600, elements: [] }, sources: new Map(), save });
  button("OK").click();
  await result;
  expect(save).not.toHaveBeenCalled();
});

function button(label: string): HTMLButtonElement {
  return [...document.querySelectorAll<HTMLButtonElement>("button")].find((b) => b.getAttribute("aria-label") === label || b.textContent === label)!;
}
const rect = { id: 1, kind: "rect" as const, x: 10, y: 10, width: 100, height: 60, stroke: "#ff0000", fill: "none" };

// Feature: 実際のクリック列からの直接編集
// Given: 文字が表示されている
// When: 押下・解放を二回行ってダブルクリックする
// Then: クリック対象の再生成で編集開始を失わない
it("Scenario: 押下と解放を経由したダブルクリックでも直接編集できる", async () => {
  Object.defineProperty(SVGElement.prototype, "getBBox", { configurable: true, value: () => ({ x: 18, y: 14, width: 60, height: 24 }) });
  const result = openDiagramEditor({ initial: { width: 800, height: 600, elements: [{ ...rect, kind: "text", text: "元" }] }, sources: new Map(), save: async () => {} });
  const canvas = document.querySelector<SVGSVGElement>(".diagram-canvas")!, original = canvas.querySelector('[data-element="1"] tspan')!;
  for (let click = 0; click < 2; click++) {
    const target = original.isConnected ? original : canvas;
    target.dispatchEvent(new MouseEvent("pointerdown", { bubbles: true, button: 0 }));
    window.dispatchEvent(new MouseEvent("pointerup"));
  }
  (original.isConnected ? original : canvas).dispatchEvent(new MouseEvent("dblclick", { bubbles: true }));
  expect(document.querySelector<HTMLTextAreaElement>(".diagram-text-editor")!.hidden).toBe(false);
  button("OK").click(); await result;
});

// Feature: 文字サイズ変更後の吹き出し
// Given: 折返し済みの本文と固定した先端がある
// When: 文字サイズを大きくする
// Then: 本文の高さを確保し先端位置と幅を維持する
it("Scenario: 文字サイズ変更でも本文を収め先端の位置を保つ", async () => {
  Object.defineProperty(SVGElement.prototype, "getBBox", { configurable: true, value: () => ({ x: 18, y: 14, width: 80, height: 50 }) });
  const save = vi.fn<DiagramEditorOptions["save"]>(async () => {});
  const result = openDiagramEditor({ initial: { width: 800, height: 600, elements: [{ ...rect, kind: "callout", text: "123456789", wrapText: true, tail: { x: 30, y: 90 } }] }, sources: new Map(), save });
  document.querySelector('[data-element="1"]')!.dispatchEvent(new MouseEvent("pointerdown", { bubbles: true, button: 0 })); window.dispatchEvent(new MouseEvent("pointerup"));
  const size = document.querySelector<HTMLInputElement>('input[aria-label="文字サイズ"]')!; size.value = "32"; size.dispatchEvent(new Event("change"));
  button("OK").click(); await result;
  expect(save.mock.calls[0][0].elements[0]).toMatchObject({ width: 100, height: 81.6, fontSize: 32, tail: { x: 30, y: 90 } });
});

// Feature: 拡張時の画面位置
// Given: 背景画像と四角形を100%で表示している
// When: 四角形を左上へ移動してキャンバスを拡張しUndoする
// Then: 拡張の前後で背景の画面位置を変えずUndoで画面状態も戻す
it("Scenario: 左上拡張で背景の画面位置と倍率を保持する", async () => {
  const result = openDiagramEditor({ initial: { width: 800, height: 600, elements: [rect, { id: 2, kind: "image", x: 200, y: 200, width: 100, height: 80, src: "shared.png" }] }, sources: new Map([["shared.png", "data:image/png;base64,AQID"]]), save: async () => {} });
  const zoom = document.querySelector<HTMLInputElement>('input[aria-label="倍率 %"]')!; zoom.value = "100"; zoom.dispatchEvent(new Event("change"));
  const canvas = document.querySelector<SVGSVGElement>(".diagram-canvas")!, frame = document.querySelector<HTMLElement>(".diagram-canvas-frame")!, viewport = document.querySelector<HTMLElement>(".diagram-viewport")!;
  canvas.getBoundingClientRect = () => ({ left: parseFloat(frame.style.left) - viewport.scrollLeft, top: parseFloat(frame.style.top) - viewport.scrollTop, width: parseFloat(canvas.style.width), height: parseFloat(canvas.style.height) } as DOMRect);
  const screenPosition = () => { const image = canvas.querySelector('[data-element="2"] image')!; return [parseFloat(frame.style.left) - viewport.scrollLeft + Number(image.getAttribute("x")), parseFloat(frame.style.top) - viewport.scrollTop + Number(image.getAttribute("y"))]; };
  const before = screenPosition();
  canvas.querySelector('[data-element="1"]')!.dispatchEvent(new MouseEvent("pointerdown", { bubbles: true, button: 0, clientX: 38, clientY: 38 }));
  window.dispatchEvent(new MouseEvent("pointerup", { clientX: -62, clientY: -42 }));
  expect(screenPosition()).toEqual(before); expect(zoom.value).toBe("100");
  button("元に戻す").click(); expect(screenPosition()).toEqual(before); expect(frame.style.left).toBe("160px"); expect(viewport.scrollLeft).toBe(142);
  button("OK").click(); await result;
});

// Feature: 日本語入力と編集取消
// Given: 文字を直接編集中
// When: 変換中にEnter/Escを押し、変換終了後にEscを押す
// Then: 変換を優先し、Escは文字編集だけを取り消す
it("Scenario: 日本語変換中に文字編集を終了せずEscで元へ戻す", async () => {
  const result = openDiagramEditor({ initial: { width: 800, height: 600, elements: [{ ...rect, kind: "text", text: "元" }] }, sources: new Map(), save: async () => {} });
  document.querySelector('[data-element="1"]')!.dispatchEvent(new MouseEvent("dblclick", { bubbles: true }));
  const text = document.querySelector<HTMLTextAreaElement>(".diagram-text-editor")!;
  text.value = "変換中"; text.dispatchEvent(new CompositionEvent("compositionstart"));
  for (const key of ["Enter", "Escape"]) {
    const event = new KeyboardEvent("keydown", { key, ctrlKey: key === "Enter", isComposing: true, bubbles: true, cancelable: true });
    text.dispatchEvent(event); expect(event.defaultPrevented).toBe(false); expect(text.hidden).toBe(false);
  }
  button("OK").click(); expect(text.hidden).toBe(false);
  text.dispatchEvent(new CompositionEvent("compositionend"));
  text.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
  expect(text.hidden).toBe(true); expect(document.querySelector('[data-element="1"]')!.textContent).toBe("元");
  expect(button("元に戻す").disabled).toBe(true); expect(document.querySelectorAll(".pf-overlay")).toHaveLength(1);
  button("OK").click(); await result;
});

// Feature: 未確定文字の破棄確認
// Given: 直接編集で未確定の入力がある
// When: キャンセルし、編集へ戻ってからOKで保存する
// Then: 入力途中も破棄確認し、入力を保持して保存できる
it("Scenario: 未確定入力の破棄確認から戻りOKで保存する", async () => {
  Object.defineProperty(SVGElement.prototype, "getBBox", { configurable: true, value: () => ({ x: 18, y: 14, width: 60, height: 24 }) });
  const save = vi.fn<DiagramEditorOptions["save"]>(async () => {});
  const result = openDiagramEditor({ initial: { width: 800, height: 600, elements: [{ ...rect, kind: "text", text: "元" }] }, sources: new Map(), save });
  document.querySelector('[data-element="1"]')!.dispatchEvent(new MouseEvent("dblclick", { bubbles: true }));
  const text = document.querySelector<HTMLTextAreaElement>(".diagram-text-editor")!; text.value = "未確定";
  button("キャンセル").click(); expect(document.querySelectorAll(".pf-overlay")).toHaveLength(2);
  button("編集に戻る").click(); await vi.waitFor(() => expect(document.querySelectorAll(".pf-overlay")).toHaveLength(1));
  expect(text.value).toBe("未確定"); expect(text.hidden).toBe(false);
  button("OK").click(); await result;
  expect(save.mock.calls[0][0].elements[0].text).toBe("未確定");
});

// Feature: 文字確定の上限超過
// Given: 入力するとキャンバスの上限を超える文字
// When: 文字を確定またはOKで保存する
// Then: 部分反映せず入力を保持し、修正後に確定できる
it("Scenario: 文字確定が上限を超えても入力を失わず修正できる", async () => {
  Object.defineProperty(SVGElement.prototype, "getBBox", { configurable: true, value: function (this: SVGElement) { return { x: 18, y: 14, width: 60, height: this.textContent === "超過" ? 11000 : 24 }; } });
  const save = vi.fn<DiagramEditorOptions["save"]>(async () => {});
  const result = openDiagramEditor({ initial: { width: 800, height: 600, elements: [{ ...rect, kind: "text", text: "元" }] }, sources: new Map(), save });
  document.querySelector('[data-element="1"]')!.dispatchEvent(new MouseEvent("dblclick", { bubbles: true }));
  const text = document.querySelector<HTMLTextAreaElement>(".diagram-text-editor")!; text.value = "超過";
  text.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", ctrlKey: true, bubbles: true }));
  expect(text.hidden).toBe(false); expect(text.value).toBe("超過"); expect(document.querySelector(".diagram-message")!.textContent).toContain("上限");
  button("OK").click(); expect(save).not.toHaveBeenCalled(); expect(button("元に戻す").disabled).toBe(true);
  text.value = "修正"; button("OK").click(); await result;
  expect(save.mock.calls[0][0].elements[0].text).toBe("修正");
});

// Feature: ドラッグ終了時の上限超過
// Given: 有効な位置まで移動したドラッグ
// When: 上限を超えた位置で離す
// Then: 最後の有効位置を部分反映せず操作全体を戻す
it("Scenario: 有効な中間位置があっても上限超過で操作全体を戻す", async () => {
  const save = vi.fn(async () => {});
  const result = openDiagramEditor({ initial: { width: 800, height: 600, elements: [rect] }, sources: new Map(), save });
  const canvas = document.querySelector<SVGSVGElement>(".diagram-canvas")!;
  canvas.getBoundingClientRect = () => ({ left: 0, top: 0, width: 800, height: 600 } as DOMRect);
  canvas.querySelector('[data-element="1"]')!.dispatchEvent(new MouseEvent("pointerdown", { bubbles: true, button: 0, clientX: 20, clientY: 20 }));
  window.dispatchEvent(new MouseEvent("pointermove", { clientX: 100, clientY: 20 }));
  window.dispatchEvent(new MouseEvent("pointerup", { clientX: 11000, clientY: 20 }));
  expect(canvas.querySelector('[data-element="1"] rect')!.getAttribute("x")).toBe("10");
  expect(button("元に戻す").disabled).toBe(true); expect(document.querySelector(".diagram-message")!.textContent).toContain("上限");
  button("OK").click(); await result; expect(save).not.toHaveBeenCalled();
});

// Feature: 作業領域の自動スクロールとドラッグ取消
// Given: 狭い作業領域で図形をドラッグしている
// When: 端で待ち、Escで中断する
// Then: 自動スクロールと作業余白を広げ、中断では画面位置も戻す
it("Scenario: 端で自動スクロールしてEscで配置と画面を戻す", async () => {
  vi.useFakeTimers();
  const result = openDiagramEditor({ initial: { width: 800, height: 600, elements: [rect] }, sources: new Map(), save: async () => {} });
  const viewport = document.querySelector<HTMLElement>(".diagram-viewport")!;
  const workspace = document.querySelector<HTMLElement>(".diagram-workspace")!;
  viewport.getBoundingClientRect = () => ({ left: 0, top: 0, width: 300, height: 200, right: 300, bottom: 200 } as DOMRect);
  const zoom = document.querySelector<HTMLInputElement>('input[aria-label="倍率 %"]')!; zoom.value = "100"; zoom.dispatchEvent(new Event("change"));
  const canvas = document.querySelector<SVGSVGElement>(".diagram-canvas")!;
  canvas.getBoundingClientRect = () => ({ left: 18, top: 18, width: 800, height: 600 } as DOMRect);
  canvas.querySelector('[data-element="1"]')!.dispatchEvent(new MouseEvent("pointerdown", { bubbles: true, button: 0, clientX: 38, clientY: 38 }));
  window.dispatchEvent(new MouseEvent("pointermove", { clientX: 298, clientY: 100 }));
  vi.advanceTimersByTime(1200);
  expect(viewport.scrollLeft).toBeGreaterThan(142);
  expect(parseFloat(workspace.style.width)).toBeGreaterThan(1120);
  expect(document.querySelector<HTMLInputElement>('input[aria-label="図の幅"]')!.value).toBe("800");
  window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
  expect(viewport.scrollLeft).toBe(142); expect(workspace.style.width).toBe("1120px");
  expect(canvas.querySelector('[data-element="1"] rect')!.getAttribute("x")).toBe("10");
  expect(button("元に戻す").disabled).toBe(true);
  expect(document.querySelectorAll(".pf-overlay")).toHaveLength(1);
  vi.useRealTimers(); button("OK").click(); await result;
});

// Feature: キャンバス外からの作成
// Given: 四辺に作業用余白のある図
// When: 左上の外側から新規四角形を作成する
// Then: ドラッグ中は寸法を維持し終了時に拡張し、一回で戻せる
it("Scenario: 外側で作成を開始して終了時だけキャンバスを広げる", async () => {
  const result = openDiagramEditor({ initial: { width: 800, height: 600, elements: [] }, sources: new Map(), save: async () => {} });
  const canvas = document.querySelector<SVGSVGElement>(".diagram-canvas")!;
  canvas.getBoundingClientRect = () => ({ left: 0, top: 0, width: 800, height: 600 } as DOMRect);
  button("四角形").click();
  document.querySelector(".diagram-viewport")!.dispatchEvent(new MouseEvent("pointerdown", { bubbles: true, button: 0, clientX: -50, clientY: -40 }));
  window.dispatchEvent(new MouseEvent("pointermove", { clientX: -10, clientY: -10 }));
  const dimensions = () => ["図の幅", "図の高さ"].map((label) => document.querySelector<HTMLInputElement>(`input[aria-label="${label}"]`)!.value);
  expect(dimensions()).toEqual(["800", "600"]);
  expect(canvas.querySelector('[data-element="1"]')).not.toBeNull();
  window.dispatchEvent(new MouseEvent("pointerup", { clientX: -10, clientY: -10 }));
  expect(dimensions()).toEqual(["851", "641"]);
  button("元に戻す").click();
  expect(dimensions()).toEqual(["800", "600"]); expect(canvas.querySelector('[data-element]')).toBeNull();
  expect(button("元に戻す").disabled).toBe(true);
  button("OK").click(); await result;
});

// Feature: 吹き出しの先端編集
// Given: 旧形式の吹き出しがある
// When: 先端を右へドラッグし、本体のサイズと位置を変更する
// Then: サイズ変更では先端を固定し、本体移動では一緒に移動して保存する
it("Scenario: 先端を自由に移動し本体の移動とサイズ変更を区別する", async () => {
  const save = vi.fn<DiagramEditorOptions["save"]>(async () => {});
  const result = openDiagramEditor({ initial: { width: 800, height: 600, elements: [{ ...rect, kind: "callout", height: 80, text: "" }] }, sources: new Map(), save });
  const canvas = document.querySelector<SVGSVGElement>(".diagram-canvas")!;
  canvas.getBoundingClientRect = () => ({ left: 0, top: 0, width: 800, height: 600 } as DOMRect);
  const down = (node: Element, x: number, y: number) => node.dispatchEvent(new MouseEvent("pointerdown", { bubbles: true, button: 0, clientX: x, clientY: y }));
  const up = (x: number, y: number) => window.dispatchEvent(new MouseEvent("pointerup", { clientX: x, clientY: y }));
  down(canvas.querySelector('[data-element="1"]')!, 20, 20); up(20, 20);
  const tip = () => canvas.querySelector('[data-handle="tail"]')!;
  expect(tip()).not.toBeNull();
  down(tip(), 30, 90); up(150, 20);
  expect(canvas.querySelector('[data-element="1"] path')!.getAttribute("d")).toContain("L 150 20");
  down(canvas.querySelector('[data-handle="se"]')!, 110, 70); up(130, 100);
  expect(tip().getAttribute("cx")).toBe("150"); expect(tip().getAttribute("cy")).toBe("20");
  down(canvas.querySelector('[data-element="1"]')!, 20, 20); up(40, 50);
  expect(tip().getAttribute("cx")).toBe("170"); expect(tip().getAttribute("cy")).toBe("50");
  button("元に戻す").click(); button("やり直す").click(); button("OK").click(); await result;
  expect(save.mock.calls[0][0]).toMatchObject({ elements: [{ x: 30, y: 40, width: 120, height: 90, tail: { x: 170, y: 50 } }] });
});

// Feature: 文字の収まりとキャンバス拡張
// Given: 下端近くに単独文字がある
// When: 幅を超える文字と改行を入力し確定する
// Then: 折返しと高さ・キャンバス拡張を一回のUndoで戻せる
it("Scenario: 文字の折返しと高さ・キャンバスをまとめて拡張する", async () => {
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue({ measureText: (text: string) => ({ width: Array.from(text).length * 10 }) } as CanvasRenderingContext2D);
  Object.defineProperty(SVGElement.prototype, "getBBox", { configurable: true, value: () => ({ x: 18, y: 564, width: 80, height: 72 }) });
  const save = vi.fn<DiagramEditorOptions["save"]>(async () => {});
  const result = openDiagramEditor({ initial: { width: 800, height: 600, elements: [{ ...rect, kind: "text", y: 560, text: "元" }] }, sources: new Map(), save });
  document.querySelector('[data-element="1"]')!.dispatchEvent(new MouseEvent("dblclick", { bubbles: true }));
  const text = document.querySelector<HTMLTextAreaElement>(".diagram-text-editor")!;
  text.value = "123456789\n次";
  text.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", ctrlKey: true, bubbles: true }));
  expect([...document.querySelectorAll('[data-element="1"] tspan')].map((node) => node.textContent)).toEqual(["12345678", "9", "次"]);
  expect(document.querySelector<HTMLInputElement>('input[aria-label="図の高さ"]')!.value).toBe("640");
  button("元に戻す").click();
  expect(document.querySelector<HTMLInputElement>('input[aria-label="図の高さ"]')!.value).toBe("600");
  expect(document.querySelector('[data-element="1"]')!.textContent).toBe("元");
  expect(button("元に戻す").disabled).toBe(true);
  button("やり直す").click(); button("OK").click(); await result;
  expect(save.mock.calls[0][0]).toMatchObject({ width: 800, height: 640, elements: [{ text: "123456789\n次", width: 100, height: 80 }] });
});

// Feature: 図上の直接文字編集
// Given: 文字のある図を選択している
// When: ダブルクリックで入力しCtrl+Enterで確定する
// Then: 図上で編集し、一回のUndoで入力前に戻せる
it("Scenario: 選択だけでは入力欄を出さず図上で文字を確定する", async () => {
  Object.defineProperty(SVGElement.prototype, "getBBox", { configurable: true, value: () => ({ x: 18, y: 14, width: 60, height: 24 }) });
  const result = openDiagramEditor({ initial: { width: 800, height: 600, elements: [{ ...rect, kind: "text", text: "元" }] }, sources: new Map(), save: async () => {} });
  const element = () => document.querySelector('[data-element="1"]')!;
  element().dispatchEvent(new MouseEvent("pointerdown", { bubbles: true, button: 0 }));
  window.dispatchEvent(new MouseEvent("pointerup"));
  const text = document.querySelector<HTMLTextAreaElement>(".diagram-text-editor")!;
  expect(text.hidden).toBe(true);
  element().dispatchEvent(new MouseEvent("dblclick", { bubbles: true }));
  expect(text.closest(".diagram-canvas-frame")).not.toBeNull();
  expect(text.hidden).toBe(false);
  text.value = "編集\n次";
  text.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", ctrlKey: true, bubbles: true }));
  expect(text.hidden).toBe(true);
  expect(element().textContent).toContain("編集");
  button("元に戻す").click();
  expect(element().textContent).toBe("元");
  expect(button("元に戻す").disabled).toBe(true);
  button("OK").click(); await result;
});

// Feature: キャンバスの寸法変更
// Given: 四角形のある図を50%で表示している
// When: 右下角をドラッグし、undo/redoした後に幅を小さく入力する
// Then: 倍率に応じて両寸法を変更し、一度のundoで戻り、内容が切れる縮小を防ぐ
it("Scenario: キャンバスをドラッグで変更し数値入力でも内容を保護する", async () => {
  const result = openDiagramEditor({ initial: { width: 800, height: 600, elements: [rect] }, sources: new Map(), save: async () => {} });
  const field = (label: string) => document.querySelector<HTMLInputElement>(`input[aria-label="${label}"]`)!;
  const zoom = field("倍率 %"); zoom.value = "50"; zoom.dispatchEvent(new Event("change"));
  document.querySelector('[data-canvas-resize="se"]')!.dispatchEvent(new MouseEvent("pointerdown", { clientX: 400, clientY: 300, bubbles: true, button: 0 }));
  window.dispatchEvent(new MouseEvent("pointermove", { clientX: 425, clientY: 325 }));
  window.dispatchEvent(new MouseEvent("pointerup", { clientX: 450, clientY: 350 }));
  expect([field("図の幅").value, field("図の高さ").value]).toEqual(["900", "700"]);
  button("元に戻す").click(); expect(field("図の幅").value).toBe("800");
  button("やり直す").click(); expect(field("図の高さ").value).toBe("700");
  const width = field("図の幅"); width.value = "20"; width.dispatchEvent(new Event("change"));
  expect(width.value).toBe("111");
  width.value = "111.5"; width.dispatchEvent(new Event("change"));
  button("元に戻す").click(); expect(width.value).toBe("111");
  button("キャンセル").click(); button("破棄").click(); await result;
});

// Feature: キャンバスの四方向自動拡張
// Given: 四角形と共有背景画像のある図
// When: 図形を左上または右下の外へ移動し、undo/redoする
// Then: 内容が見えるまで拡張し、一度のundoで配置と寸法が戻る
it.each([[-30, -30, "821", "621"], [850, 650, "961", "721"]])("Scenario: 範囲外配置と拡張を一度で戻す (%i, %i)", async (dx, dy, expectedWidth, expectedHeight) => {
  const save = vi.fn(async () => {});
  const result = openDiagramEditor({ initial: { width: 800, height: 600, elements: [rect, { id: 2, kind: "image", src: "shared.png", x: 200, y: 200, width: 50, height: 40 }] }, sources: new Map([["shared.png", "data:image/png;base64,AQID"]]), save });
  const canvas = document.querySelector<SVGSVGElement>(".diagram-canvas")!;
  canvas.getBoundingClientRect = () => ({ left: 0, top: 0, width: 800, height: 600 } as DOMRect);
  canvas.querySelector('[data-element="1"]')!.dispatchEvent(new MouseEvent("pointerdown", { bubbles: true, button: 0, clientX: 20, clientY: 20 }));
  window.dispatchEvent(new MouseEvent("pointermove", { clientX: 20 + dx / 2, clientY: 20 + dy / 2 }));
  const dimensions = () => ["図の幅", "図の高さ"].map((label) => document.querySelector<HTMLInputElement>(`input[aria-label="${label}"]`)!.value);
  expect(dimensions()).toEqual(["800", "600"]);
  window.dispatchEvent(new MouseEvent("pointerup", { clientX: 20 + dx, clientY: 20 + dy }));
  const width = document.querySelector<HTMLInputElement>('input[aria-label="図の幅"]')!;
  const height = document.querySelector<HTMLInputElement>('input[aria-label="図の高さ"]')!;
  expect([width.value, height.value]).toEqual([expectedWidth, expectedHeight]);
  button("元に戻す").click();
  expect([width.value, height.value]).toEqual(["800", "600"]);
  expect(canvas.querySelector('[data-element="1"] rect')!.getAttribute("x")).toBe("10");
  expect(button("元に戻す").disabled).toBe(true);
  button("やり直す").click();
  expect(width.value).toBe(expectedWidth);
  button("キャンセル").click(); button("破棄").click(); await result;
  expect(save).not.toHaveBeenCalled();
});

// Feature: キャンバスの辺ハンドル
// Given: 白紙を50%で表示している
// When: 右辺または下辺をドラッグする
// Then: 対応する寸法だけを変更する
it.each([["e", "900", "600"], ["s", "800", "700"]])("Scenario: %sの辺で一方向だけ変更する", async (edge, w, h) => {
  const result = openDiagramEditor({ initial: { width: 800, height: 600, elements: [] }, sources: new Map(), save: async () => {} });
  const zoom = document.querySelector<HTMLInputElement>('input[aria-label="倍率 %"]')!;
  zoom.value = "50"; zoom.dispatchEvent(new Event("change"));
  document.querySelector(`[data-canvas-resize="${edge}"]`)!.dispatchEvent(new MouseEvent("pointerdown", { clientX: 0, clientY: 0, bubbles: true, button: 0 }));
  window.dispatchEvent(new MouseEvent("pointerup", { clientX: 50, clientY: 50 }));
  expect(document.querySelector<HTMLInputElement>('input[aria-label="図の幅"]')!.value).toBe(w);
  expect(document.querySelector<HTMLInputElement>('input[aria-label="図の高さ"]')!.value).toBe(h);
  button("OK").click(); await result;
});

// Feature: 図編集のアイコン操作
// Given: 図の編集画面
// When: ツールと操作ボタンを確認する
// Then: アイコンに日本語ツールチップと読み上げ名がある
it("Scenario: 全操作を名前付きアイコンで表示する", async () => {
  const result = openDiagramEditor({ initial: { width: 800, height: 600, elements: [] }, sources: new Map(), save: async () => {} });
  for (const b of document.querySelectorAll<HTMLButtonElement>(".diagram-tools button, .diagram-heading button, .diagram-editor .pf-btns button")) {
    expect(b.getAttribute("aria-label")).toBeTruthy();
    expect(b.title).toBe(b.getAttribute("aria-label"));
    expect(b.querySelector('[aria-hidden="true"]')).not.toBeNull();
  }
  button("OK").click(); await result;
});

// Feature: 単一要素選択
// Scenario: 空白をドラッグしても選択済み図形を動かさない
// Given: 選択した四角形
// When: 空白をドラッグして OK
// Then: 図形に変更がなく保存しない
it("Scenario: 空白クリックは選択を解除する", async () => {
  const save = vi.fn(async () => {});
  const result = openDiagramEditor({ initial: { width: 800, height: 600, elements: [rect] }, sources: new Map(), save });
  const canvas = document.querySelector<SVGSVGElement>(".diagram-canvas")!;
  canvas.getBoundingClientRect = () => ({ left: 0, top: 0, width: 800, height: 600 } as DOMRect);
  canvas.querySelector('[data-element="1"]')!.dispatchEvent(new MouseEvent("pointerdown", { bubbles: true, button: 0, clientX: 20, clientY: 20 }));
  window.dispatchEvent(new MouseEvent("pointerup", { clientX: 20, clientY: 20 }));
  canvas.dispatchEvent(new MouseEvent("pointerdown", { bubbles: true, button: 0, clientX: 400, clientY: 400 }));
  window.dispatchEvent(new MouseEvent("pointerup", { clientX: 500, clientY: 500 }));
  button("OK").click(); await result;
  expect(save).not.toHaveBeenCalled();
});

// Feature: 図保存失敗
// Scenario: 失敗後も編集内容を残して再試行する
// Given: 既存の図と一度失敗する保存先
// When: 図の寸法を変更して保存し、再試行する
// Then: ダイアログと編集内容を維持し、再試行で保存できる
it("Scenario: 保存失敗後も編集内容を保持して再試行する", async () => {
  const save = vi.fn().mockRejectedValueOnce(new Error("保存先に書き込めません")).mockResolvedValueOnce(undefined);
  const result = openDiagramEditor({ initial: { width: 800, height: 600, elements: [rect] }, sources: new Map(), save });
  const width = document.querySelector<HTMLInputElement>('input[aria-label="図の幅"]')!;
  width.value = "900"; width.dispatchEvent(new Event("change")); button("OK").click();
  await vi.waitFor(() => expect(document.querySelector(".diagram-message")?.textContent).toContain("保存できませんでした"));
  expect(width.value).toBe("900"); expect(button("OK").disabled).toBe(false);
  button("OK").click(); await result;
  expect(save.mock.calls[1][0].width).toBe(900);
});

// Feature: 変更の破棄確認
// Scenario: Escape で破棄確認だけ閉じる
// Given: 図を変更し破棄確認を開いた
// When: Escape を押す
// Then: 図の編集画面と変更が残る
it("Scenario: 破棄確認の Escape は図編集を閉じない", async () => {
  const result = openDiagramEditor({ initial: { width: 800, height: 600, elements: [rect] }, sources: new Map(), save: async () => {} });
  const width = document.querySelector<HTMLInputElement>('input[aria-label="図の幅"]')!;
  width.value = "900"; width.dispatchEvent(new Event("change")); button("キャンセル").click();
  expect(document.querySelectorAll(".pf-overlay")).toHaveLength(2);
  window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
  await vi.waitFor(() => expect(document.querySelectorAll(".pf-overlay")).toHaveLength(1));
  expect(width.value).toBe("900");
  button("キャンセル").click(); button("破棄").click(); await result;
});

// Feature: 既存図の変更なし
// Scenario: 再編集を開いて変更せず OK
// Given: 保存済みの図
// When: OK を押す
// Then: 新しいファイルは保存しない
it("Scenario: 既存図も変更なしなら保存しない", async () => {
  const save = vi.fn(async () => {});
  const result = openDiagramEditor({ initial: { width: 800, height: 600, elements: [rect] }, sources: new Map(), save });
  button("OK").click(); await result; expect(save).not.toHaveBeenCalled();
});

// Feature: 図の文字・属性と履歴
// Scenario: 説明文を改行付きで編集して戻す
// Given: 吹き出しのある図
// When: 説明文、線の色、文字サイズを変更し Undo/Redo する
// Then: 最終属性と改行が保存される
it("Scenario: 吹き出しの本文と属性を編集できる", async () => {
  Object.defineProperty(SVGElement.prototype, "getBBox", { configurable: true, value: () => ({ x: 18, y: 14, width: 120, height: 64 }) });
  let saved: unknown;
  const result = openDiagramEditor({ initial: { width: 800, height: 600, elements: [{ ...rect, kind: "callout", text: "元" }] }, sources: new Map(), save: async (d) => { saved = d; } });
  const element = document.querySelector('[data-element="1"]')!;
  element.dispatchEvent(new MouseEvent("dblclick", { bubbles: true }));
  const text = document.querySelector<HTMLTextAreaElement>(".diagram-text-editor")!;
  text.value = "説明\n補足"; text.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", ctrlKey: true, bubbles: true }));
  const size = document.querySelector<HTMLInputElement>('input[aria-label="文字サイズ"]')!;
  size.value = "28"; size.dispatchEvent(new Event("change"));
  const stroke = document.querySelector<HTMLInputElement>('input[aria-label="線の色"]')!;
  stroke.value = "#0000ff"; stroke.dispatchEvent(new Event("change"));
  button("元に戻す").click(); button("やり直す").click(); button("OK").click(); await result;
  expect(saved).toMatchObject({ elements: [{ kind: "callout", text: "説明\n補足", stroke: "#0000ff", fontSize: 28 }] });
});

// Feature: 表示される文字範囲の保持
// Given: 小さい編集枠を超えて表示される複数行文字
// When: 文字を編集して保存する
// Then: 文字の高さを広げ、キャンバスを自動縮小しない
it("Scenario: 文字の収まりを調整してキャンバス寸法を保持する", async () => {
  Object.defineProperty(SVGElement.prototype, "getBBox", { configurable: true, value: () => ({ x: 18, y: 14, width: 300, height: 80 }) });
  const save = vi.fn<DiagramEditorOptions["save"]>(async () => {});
  const result = openDiagramEditor({ initial: { width: 800, height: 600, elements: [{ ...rect, kind: "text", width: 20, height: 10, text: "説明\n補足" }] }, sources: new Map(), save });
  document.querySelector('[data-element="1"]')!.dispatchEvent(new MouseEvent("dblclick", { bubbles: true }));
  const text = document.querySelector<HTMLTextAreaElement>(".diagram-text-editor")!;
  text.value = "長い説明\n補足"; text.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", ctrlKey: true, bubbles: true }));
  button("OK").click(); await result;
  expect(save.mock.calls[0][0]).toMatchObject({ width: 800, height: 600, elements: [{ x: 10, y: 10, width: 20, height: 158, text: "長い説明\n補足" }] });
});

// Feature: 背景画像とキャンバスの保持
// Given: 共有背景画像と、その内側の四角形
// When: 図を編集して保存する
// Then: 背景全体と共有参照とキャンバス寸法を保つ
it("Scenario: 背景画像全体と原本への参照を保持して保存する", async () => {
  const save = vi.fn<DiagramEditorOptions["save"]>(async () => {});
  const result = openDiagramEditor({ initial: { width: 800, height: 600, elements: [{ id: 2, kind: "image", src: "shared.png", x: 20, y: 30, width: 300, height: 200 }, { ...rect, x: 50, y: 50 }] }, sources: new Map([["shared.png", "data:image/png;base64,AQID"]]), save });
  const width = document.querySelector<HTMLInputElement>('input[aria-label="図の幅"]')!;
  width.value = "900"; width.dispatchEvent(new Event("change"));
  button("OK").click(); await result;
  expect(save.mock.calls[0][0]).toMatchObject({ width: 900, height: 600, elements: [{ kind: "image", x: 20, y: 30, width: 300, height: 200, src: "shared.png" }, { x: 50, y: 50 }] });
  expect(save.mock.calls[0][1].size).toBe(0);
});

// Feature: キャンバスの上限とドラッグ取り消し
// Given: 保存済みの四角形
// When: 上限を超えて移動する、またはドラッグをキャンセルする
// Then: 内容を切り捨てず元の状態を保ち、変更なしとして閉じられる
it("Scenario: 上限超過とpointercancelで編集内容を失わない", async () => {
  const save = vi.fn(async () => {});
  const result = openDiagramEditor({ initial: { width: 800, height: 600, elements: [rect] }, sources: new Map(), save });
  const canvas = document.querySelector<SVGSVGElement>(".diagram-canvas")!;
  canvas.getBoundingClientRect = () => ({ left: 0, top: 0, width: 800, height: 600 } as DOMRect);
  const down = () => canvas.querySelector('[data-element="1"]')!.dispatchEvent(new MouseEvent("pointerdown", { bubbles: true, button: 0, clientX: 20, clientY: 20 }));
  down(); window.dispatchEvent(new MouseEvent("pointerup", { clientX: 11000, clientY: 20 }));
  expect(document.querySelector(".diagram-message")!.textContent).toContain("上限");
  expect(canvas.querySelector('[data-element="1"] rect')!.getAttribute("x")).toBe("10");
  down(); window.dispatchEvent(new MouseEvent("pointermove", { clientX: -50, clientY: -50 }));
  window.dispatchEvent(new MouseEvent("pointercancel"));
  expect(document.querySelector<HTMLInputElement>('input[aria-label="図の幅"]')!.value).toBe("800");
  button("OK").click(); await result; expect(save).not.toHaveBeenCalled();
});

// Feature: ドラッグ中の履歴保護
// Given: 幅を変更した図でキャンバスをドラッグしている
// When: ドラッグ中にCtrl+Zを押してからドラッグを完了する
// Then: ドラッグとその前の変更を順番にundoできる
it("Scenario: ドラッグ中のCtrl+Zで以前の履歴を失わない", async () => {
  const result = openDiagramEditor({ initial: { width: 800, height: 600, elements: [] }, sources: new Map(), save: async () => {} });
  const width = document.querySelector<HTMLInputElement>('input[aria-label="図の幅"]')!;
  width.value = "900"; width.dispatchEvent(new Event("change"));
  const zoom = document.querySelector<HTMLInputElement>('input[aria-label="倍率 %"]')!; zoom.value = "50"; zoom.dispatchEvent(new Event("change"));
  const handle = document.querySelector<HTMLButtonElement>('[data-canvas-resize="e"]')!;
  handle.dispatchEvent(new MouseEvent("pointerdown", { clientX: 0, clientY: 0, bubbles: true, button: 0 }));
  handle.dispatchEvent(new KeyboardEvent("keydown", { key: "z", ctrlKey: true, bubbles: true }));
  window.dispatchEvent(new MouseEvent("pointerup", { clientX: 50, clientY: 0 }));
  button("元に戻す").click(); expect(width.value).toBe("900");
  button("元に戻す").click(); expect(width.value).toBe("800");
  button("OK").click(); await result;
});

// Feature: 太い線と尖った線端の保持
// Given: 斜線、逆向き矢印、吹き出しの太い線
// When: 変更して保存する
// Then: butt端とmiterの先端を含む外周を保持し、再編集できる
it.each([
  [{ ...rect, kind: "line" as const, x: 20, y: 20, width: 100, height: 100, strokeWidth: 20 }, 114.142136, 114.142136],
  [{ ...rect, kind: "arrow" as const, x: 120, y: 20, width: -100, height: 0, strokeWidth: 20 }, 122.990327, 44.106874],
  [{ ...rect, kind: "callout" as const, width: 100, height: 80, strokeWidth: 20, text: "" }, 120, 114.142136],
])("Scenario: 太い線端を切らずに保存する (例%#)", async (element, expectedWidth, expectedHeight) => {
  const save = vi.fn<DiagramEditorOptions["save"]>(async () => {});
  const result = openDiagramEditor({ initial: { width: 800, height: 600, elements: [element] }, sources: new Map(), save });
  const width = document.querySelector<HTMLInputElement>('input[aria-label="図の幅"]')!;
  width.value = "900"; width.dispatchEvent(new Event("change"));
  button("OK").click(); await result;
  expect(save.mock.calls[0][0].width).toBeGreaterThanOrEqual(expectedWidth);
  expect(save.mock.calls[0][0].height).toBeGreaterThanOrEqual(expectedHeight);
  expect(save.mock.calls[0][0].width).toBeGreaterThanOrEqual(900);
});
