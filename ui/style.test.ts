import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

const style = readFileSync(new URL("./style.css", import.meta.url), "utf8");

describe("editor caret style", () => {
  it("キャレットに点滅アニメーションを設定しない", () => {
    expect(style).not.toContain("ve-blink");
    expect(style).toMatch(/\.ve-caret\.on\s*\{\s*display:\s*block;\s*\}/);
  });
});
