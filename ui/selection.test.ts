import { describe, expect, it } from "vitest";
import { Selection } from "./selection";

const at = (line: number, col: number) => ({ line, col });

describe("Feature: Selection", () => {
  // Given: 新しいSelectionでanchorとcaretが同じ位置
  // When: 初期状態を確認し、caretを`{line:0,col:1}`へ動かす
  // Then: 初期は`hasSel()`がfalse、caret移動後はtrue
  it("Scenario: anchor と caret が同じ位置なら選択なし", () => {
    const sel = new Selection();
    expect(sel.hasSel()).toBe(false);
    sel.caret = at(0, 1);
    expect(sel.hasSel()).toBe(true);
  });

  // Given: anchor=`{line:3,col:2}`、caret=`{line:1,col:5}`の逆向き選択と、同一行の順向き選択
  // When: `norm()`を呼び、caretを`{line:3,col:9}`へ変更して再度呼ぶ
  // Then: 逆向きは先後を入れ替え、順向きは`[{3,2},{3,9}]`を返す
  it("Scenario: norm は逆向き選択でも [先, 後] を返す", () => {
    const sel = new Selection();
    sel.anchor = at(3, 2);
    sel.caret = at(1, 5);
    expect(sel.norm()).toEqual([at(1, 5), at(3, 2)]);
    sel.caret = at(3, 9);
    expect(sel.norm()).toEqual([at(3, 2), at(3, 9)]);
  });

  // Given: anchor=`{line:1,col:2}`、caret=`{line:2,col:4}`の選択と、選択を解除した状態
  // When: 端点・範囲外・選択なしの位置へ`contains()`を呼ぶ
  // Then: 端点はtrue、範囲外と選択なしはfalse
  it("Scenario: contains は端を含み、選択なしでは常に false", () => {
    const sel = new Selection();
    sel.anchor = at(1, 2);
    sel.caret = at(2, 4);
    expect(sel.contains(at(1, 2))).toBe(true);
    expect(sel.contains(at(2, 4))).toBe(true);
    expect(sel.contains(at(1, 1))).toBe(false);
    expect(sel.contains(at(3, 0))).toBe(false);
    sel.caret = sel.anchor;
    expect(sel.contains(at(1, 2))).toBe(false);
  });

  // Given: caret=`{line:5,col:0}`、secondaryが`[{6,0},{7,0}]`、goalX/multiCaretXが120
  // When: `all()`を確認後、`reset({line:2,col:2})`を呼ぶ
  // Then: 全caretを列挙し、reset後は主caretだけになりanchorは一致、goalX/multiCaretXはnull
  it("Scenario: all は主キャレットを先頭に並べ、reset で状態を捨てる", () => {
    const sel = new Selection();
    sel.caret = at(5, 0);
    sel.secondary = [at(6, 0), at(7, 0)];
    sel.goalX = 120;
    sel.multiCaretX = 120;
    expect(sel.all()).toEqual([at(5, 0), at(6, 0), at(7, 0)]);
    sel.reset(at(2, 2));
    expect(sel.all()).toEqual([at(2, 2)]);
    expect(sel.anchor).toEqual(at(2, 2));
    expect(sel.goalX).toBeNull();
    expect(sel.multiCaretX).toBeNull();
  });
});
