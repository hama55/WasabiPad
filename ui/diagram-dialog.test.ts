// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
import { openDiagramEditor } from "./diagram-dialog";
afterEach(() => document.body.replaceChildren());

// Feature: 図編集ダイアログ
// Scenario: 赤枠を描いて保存する
// Given: 白紙の図編集画面
// When: 四角形をドラッグして OK を押す
// Then: 編集モデルに四角形が保存される
it("Scenario: 四角形を描いて確定できる", async () => {
  let saved: unknown;
  const result = openDiagramEditor({ initial: { width: 800, height: 600, elements: [] }, sources: new Map(), save: async (diagram) => { saved = diagram; } });
  const canvas = document.querySelector<SVGSVGElement>(".diagram-canvas")!;
  canvas.getBoundingClientRect = () => ({ left: 0, top: 0, width: 800, height: 600 } as DOMRect);
  [...document.querySelectorAll("button")].find((b) => b.textContent === "四角形")!.click();
  canvas.dispatchEvent(new MouseEvent("pointerdown", { clientX: 20, clientY: 30, bubbles: true, button: 0 }));
  window.dispatchEvent(new MouseEvent("pointermove", { clientX: 120, clientY: 90 }));
  window.dispatchEvent(new MouseEvent("pointerup", { clientX: 120, clientY: 90 }));
  [...document.querySelectorAll("button")].find((b) => b.textContent === "OK")!.click();
  await result;
  expect(saved).toMatchObject({ elements: [{ kind: "rect", x: 20, y: 30, width: 100, height: 60, stroke: "#ff0000" }] });
});

// Feature: 図編集ダイアログ
// Scenario: 変更なしは保存せず閉じる
// Given: 白紙の編集画面
// When: OK を押す
// Then: 保存を呼ばない
it("Scenario: 白紙のまま OK でファイルを作らない", async () => {
  const save = vi.fn(async () => {});
  const result = openDiagramEditor({ initial: { width: 800, height: 600, elements: [] }, sources: new Map(), save });
  [...document.querySelectorAll("button")].find((b) => b.textContent === "OK")!.click();
  await result;
  expect(save).not.toHaveBeenCalled();
});

function button(label: string): HTMLButtonElement {
  return [...document.querySelectorAll<HTMLButtonElement>("button")].find((b) => b.textContent === label)!;
}
const rect = { id: 1, kind: "rect" as const, x: 10, y: 10, width: 100, height: 60, stroke: "#ff0000", fill: "none" };

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
