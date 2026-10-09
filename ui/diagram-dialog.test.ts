// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
import { openDiagramEditor, type DiagramEditorOptions } from "./diagram-dialog";
afterEach(() => { document.body.replaceChildren(); vi.restoreAllMocks(); delete (SVGElement.prototype as SVGElement & { getBBox?: unknown }).getBBox; });

// Feature: 図編集ダイアログ
// Scenario: 赤枠を描いて保存する
// Given: 白紙の図編集画面
// When: 四角形をドラッグして OK を押す
// Then: 四角形と線の外周まで追加余白0pxでトリムして保存される
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
  expect(saved).toMatchObject({ width: 102, height: 62, elements: [{ kind: "rect", x: 1, y: 1, width: 100, height: 60, stroke: "#ff0000" }] });
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
  expect(dimensions()).toEqual(dx < 0 ? ["806", "606"] : ["800", "600"]);
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
  expect(save.mock.calls[1][0].width).toBe(102);
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
  text.value = "説明\n補足"; text.dispatchEvent(new Event("change"));
  const size = document.querySelector<HTMLInputElement>('input[aria-label="文字サイズ"]')!;
  size.value = "28"; size.dispatchEvent(new Event("change"));
  const stroke = document.querySelector<HTMLInputElement>('input[aria-label="線の色"]')!;
  stroke.value = "#0000ff"; stroke.dispatchEvent(new Event("change"));
  button("元に戻す").click(); button("やり直す").click(); button("OK").click(); await result;
  expect(saved).toMatchObject({ elements: [{ kind: "callout", text: "説明\n補足", stroke: "#0000ff", fontSize: 28 }] });
});

// Feature: 表示される内容のトリム
// Given: 小さい編集枠を超えて表示される複数行文字
// When: 文字を編集して保存する
// Then: ブラウザで実測した文字外周を使い、選択枠の寸法では切らない
it("Scenario: 文字の実測範囲まで追加余白0pxで保存する", async () => {
  Object.defineProperty(SVGElement.prototype, "getBBox", { configurable: true, value: () => ({ x: 18, y: 14, width: 300, height: 80 }) });
  const save = vi.fn<DiagramEditorOptions["save"]>(async () => {});
  const result = openDiagramEditor({ initial: { width: 800, height: 600, elements: [{ ...rect, kind: "text", width: 20, height: 10, text: "説明\n補足" }] }, sources: new Map(), save });
  document.querySelector('[data-element="1"]')!.dispatchEvent(new MouseEvent("dblclick", { bubbles: true }));
  const text = document.querySelector<HTMLTextAreaElement>(".diagram-text-editor")!;
  text.value = "長い説明\n補足"; text.dispatchEvent(new Event("change"));
  button("OK").click(); await result;
  expect(save.mock.calls[0][0]).toMatchObject({ width: 300, height: 80, elements: [{ x: -8, y: -4, width: 20, height: 10, text: "長い説明\n補足" }] });
});

// Feature: 背景画像を含むトリム
// Given: 共有背景画像と、その内側の四角形
// When: 図を編集して保存する
// Then: 背景全体と共有参照を保ち、外側のキャンバスだけをトリムする
it("Scenario: 背景画像全体と原本への参照を保持してトリムする", async () => {
  const save = vi.fn<DiagramEditorOptions["save"]>(async () => {});
  const result = openDiagramEditor({ initial: { width: 800, height: 600, elements: [{ id: 2, kind: "image", src: "shared.png", x: 20, y: 30, width: 300, height: 200 }, { ...rect, x: 50, y: 50 }] }, sources: new Map([["shared.png", "data:image/png;base64,AQID"]]), save });
  const width = document.querySelector<HTMLInputElement>('input[aria-label="図の幅"]')!;
  width.value = "900"; width.dispatchEvent(new Event("change"));
  button("OK").click(); await result;
  expect(save.mock.calls[0][0]).toMatchObject({ width: 300, height: 200, elements: [{ kind: "image", x: 0, y: 0, width: 300, height: 200, src: "shared.png" }, { x: 30, y: 20 }] });
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

// Feature: 太い線と尖った線端のトリム
// Given: 斜線、逆向き矢印、吹き出しの太い線
// When: 変更して保存する
// Then: butt端とmiterの先端を含む外周まで保存し、再編集できる
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
  expect(save.mock.calls[0][0].width).toBeCloseTo(expectedWidth, 5);
  expect(save.mock.calls[0][0].height).toBeCloseTo(expectedHeight, 5);
});
