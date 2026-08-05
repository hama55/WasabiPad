import { describe, expect, it } from "vitest";
import { normalizeTheme } from "./theme";

describe("Feature: theme", () => {
  // Given: `light`、`dark`、`other`、`null`をテーマ値として渡す
  // When: `normalizeTheme`を呼ぶ
  // Then: `light`/`dark`は維持し、その他は`dark`
  it("Scenario: 保存済みテーマを正規化する", () => {
    expect(normalizeTheme("light")).toBe("light");
    expect(normalizeTheme("dark")).toBe("dark");
    expect(normalizeTheme("other")).toBe("dark");
    expect(normalizeTheme(null)).toBe("dark");
  });
});
