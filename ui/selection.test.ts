import { describe, expect, it } from "vitest";
import { Selection } from "./selection";

const at = (line: number, col: number) => ({ line, col });

describe("Selection", () => {
  it("anchor と caret が同じ位置なら選択なし", () => {
    const sel = new Selection();
    expect(sel.hasSel()).toBe(false);
    sel.caret = at(0, 1);
    expect(sel.hasSel()).toBe(true);
  });

  it("norm は逆向き選択でも [先, 後] を返す", () => {
    const sel = new Selection();
    sel.anchor = at(3, 2);
    sel.caret = at(1, 5);
    expect(sel.norm()).toEqual([at(1, 5), at(3, 2)]);
    sel.caret = at(3, 9);
    expect(sel.norm()).toEqual([at(3, 2), at(3, 9)]);
  });

  it("contains は端を含み、選択なしでは常に false", () => {
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

  it("all は主キャレットを先頭に並べ、reset で状態を捨てる", () => {
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
