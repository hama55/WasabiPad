import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

const style = readFileSync(new URL("./style.css", import.meta.url), "utf8");

describe("Feature: editor caret style", () => {
  // Given: `style.css`の全文を読み込む
  // When: キャレット関連CSSを検査
  // Then: `ve-blink`を含まず、`.ve-caret.on`は`display:block`を持つ
  it("Scenario: キャレットに点滅アニメーションを設定しない", () => {
    expect(style).not.toContain("ve-blink");
    expect(style).toMatch(/\.ve-caret\.on\s*\{\s*display:\s*block;\s*\}/);
  });
});
