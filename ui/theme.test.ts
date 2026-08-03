import { describe, expect, it } from "vitest";
import { normalizeTheme } from "./theme";

describe("theme", () => {
  it("保存済みテーマを正規化する", () => {
    expect(normalizeTheme("light")).toBe("light");
    expect(normalizeTheme("dark")).toBe("dark");
    expect(normalizeTheme("other")).toBe("dark");
    expect(normalizeTheme(null)).toBe("dark");
  });
});
