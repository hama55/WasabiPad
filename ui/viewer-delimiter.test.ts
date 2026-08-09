import { describe, expect, it } from "vitest";
import {
  CSV_DELIMITER_OPTIONS,
  CUSTOM_DELIMITER_VALUE,
  delimiterPresetFor,
} from "./viewer-delimiter";

describe("Feature: CSV delimiter presets", () => {
  // Given: 現在の区切り文字がタブ文字または `\\t`
  // When: ダイアログの初期プリセットを求める
  // Then: `\\t=タブ` のプリセットが選ばれる
  it("Scenario: タブ区切りをプリセットとして表示する", () => {
    expect(delimiterPresetFor("\\t")).toBe("\\t");
    expect(delimiterPresetFor("\t")).toBe("\\t");
    expect(CSV_DELIMITER_OPTIONS.find((option) => option.value === "\\t")?.label).toBe("\\t=タブ");
  });

  // Given: 現在の区切り文字が登録済みでない文字列
  // When: ダイアログの初期プリセットを求める
  // Then: その他が選ばれる
  it("Scenario: 未登録の区切り文字はその他として表示する", () => {
    expect(delimiterPresetFor("::")).toBe(CUSTOM_DELIMITER_VALUE);
  });
});
