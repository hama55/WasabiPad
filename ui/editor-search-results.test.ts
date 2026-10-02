// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";
import { EditorSearchResults } from "./editor-search-results";
import type { FindResult } from "./api";

const query = { pat: "foo", matchCase: false, useRegex: false, wholeWord: false };
const hit = (line: number): FindResult => ({ start: { line, col: 0 }, end: { line, col: 3 } });
beforeEach(() => document.body.replaceChildren());

describe("Feature: エディタ検索結果パネル", () => {
  it("Scenario: 上下の辺をドラッグして反対側を固定したまま高さを変える", () => {
    // Given: 開いた結果パネル
    const panel = new EditorSearchResults({ search: async () => [], line: async () => "", select: vi.fn() });
    panel.open(query);
    const root = document.querySelector<HTMLElement>(".editor-search-results")!;
    const top = Number.parseFloat(root.style.top);
    const pointer = (type: string, y: number) => new MouseEvent(type, { button: 0, clientY: y, bubbles: true });
    // When: 上辺を40px上へドラッグする
    root.querySelector(".editor-search-results-resize-top")!.dispatchEvent(pointer("pointerdown", top));
    window.dispatchEvent(pointer("pointermove", top - 40));
    window.dispatchEvent(pointer("pointerup", top - 40));
    // Then: 下辺を維持して高さだけ増える
    expect(Number.parseFloat(root.style.top)).toBe(top - 40);
    expect(root.style.height).toBe("380px");
    // When: 下辺を10px下へドラッグする
    root.querySelector(".editor-search-results-resize-bottom")!.dispatchEvent(pointer("pointerdown", top + 340));
    window.dispatchEvent(pointer("pointermove", top + 350));
    window.dispatchEvent(pointer("pointerup", top + 350));
    // Then: 上辺を維持して高さだけ増える
    expect(Number.parseFloat(root.style.top)).toBe(top - 40);
    expect(root.style.height).toBe("390px");
    panel.close();
  });
  it("Scenario: 一覧の連続キー移動でフォーカスを維持する", async () => {
    // Given: 2件の一致がある結果一覧
    const panel = new EditorSearchResults({ search: async () => [hit(0), hit(1)], line: async () => "foo", select: vi.fn() });
    panel.open(query);
    await vi.waitFor(() => expect(document.querySelectorAll(".editor-search-result")).toHaveLength(2));
    const list = document.querySelector<HTMLElement>(".editor-search-results-list")!;
    // When: 一覧にフォーカスして連続して下へ移動する
    list.focus();
    for (let index = 0; index < 2; index++) {
      list.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true }));
      await vi.waitFor(() => expect(document.querySelector('[aria-selected="true"]')?.textContent).toContain(`${index + 1}:1`));
      // Then: 再描画しても一覧のフォーカスを維持する
      expect(document.activeElement).toBe(list);
    }
    expect(document.querySelector<HTMLButtonElement>(".editor-search-result")!.tabIndex).toBe(-1);
    panel.close();
  });
  // Given: 検索が未完了のパネル
  // When: 条件を変えて新しい検索が完了した後に古い検索が完了する
  // Then: 新しい条件の結果を維持する
  it("Scenario: 古い検索の遅延結果を破棄する", async () => {
    let finish!: (matches: FindResult[]) => void;
    const search = vi.fn().mockReturnValueOnce(new Promise(resolve => { finish = resolve; })).mockResolvedValue([hit(1)]);
    const panel = new EditorSearchResults({ search, line: async line => line === 1 ? "bar" : "foo", select: vi.fn() });
    panel.open(query);
    await vi.waitFor(() => expect(search).toHaveBeenCalledOnce());
    panel.refresh({ ...query, pat: "bar" }, 0);
    await vi.waitFor(() => expect(document.querySelector(".editor-search-result")?.textContent).toContain("bar"));
    finish([hit(0)]);
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(document.querySelector(".editor-search-result")!.textContent).toContain("bar");
    panel.close();
  });

  // Given: 一致が5000箇所ある本文
  // When: 結果一覧を末尾までスクロールする
  // Then: 全件数を示し、末尾へ到達でき、画面外の行を大量描画しない
  it("Scenario: 多数の一致も末尾まで一覧表示する", async () => {
    const select = vi.fn();
    const panel = new EditorSearchResults({ search: async () => Array.from({ length: 5000 }, (_, i) => hit(i)), line: async () => "foo", select });
    panel.open(query);
    await vi.waitFor(() => expect(document.querySelector(".editor-search-results-status")!.textContent).toBe("5,000件"));
    const list = document.querySelector<HTMLElement>(".editor-search-results-list")!;
    list.scrollTop = 4990 * 26;
    list.dispatchEvent(new Event("scroll"));
    await vi.waitFor(() => expect(document.querySelectorAll(".editor-search-result")).toHaveLength(12));
    const rows = document.querySelectorAll<HTMLButtonElement>(".editor-search-result");
    rows[rows.length - 1].click();
    expect(select).toHaveBeenCalledWith(hit(4999), query);
    panel.close();
  });

  // Given: 開いた結果パネルと入力欄のフォーカス
  // When: キーボードで移動・サイズ変更して閉じる
  // Then: 開く操作がフォーカスを奪わず、寸法変更が有効になる
  it("Scenario: フォーカスを奪わず移動とサイズ変更ができる", () => {
    const input = document.createElement("input");
    document.body.append(input);
    input.focus();
    const panel = new EditorSearchResults({ search: async () => [], line: async () => "", select: vi.fn() });
    panel.open(query);
    expect(document.activeElement).toBe(input);
    const root = document.querySelector<HTMLElement>(".editor-search-results")!;
    const before = Number.parseFloat(root.style.left);
    root.querySelector("header")!.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowLeft", bubbles: true }));
    expect(Number.parseFloat(root.style.left)).toBe(before - 10);
    root.querySelector(".editor-search-results-resize")!.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true }));
    expect(root.style.width).toBe("570px");
    panel.close();
    expect(root.hidden).toBe(true);
  });
});
