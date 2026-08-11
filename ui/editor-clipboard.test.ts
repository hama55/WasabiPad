import { describe, expect, it } from "vitest";
import { RectangularClipboard } from "./editor-clipboard";

describe("Feature: 矩形クリップボード状態", () => {
  // Given: 「bc\nBC」を矩形コピーした状態
  // When: 同じ文字列を問い合わせる
  // Then: 貼り付け対象の行をスナップショットで返す
  it("Scenario: 同じクリップボード文字列から矩形行を取得する", () => {
    const clipboard = new RectangularClipboard();
    clipboard.set("bc\nBC");

    const rows = clipboard.rowsFor("bc\nBC");
    expect(rows).toEqual(["bc", "BC"]);
    rows?.push("stale");
    expect(clipboard.rowsFor("bc\nBC")).toEqual(["bc", "BC"]);
  });

  // Given: 矩形コピーのメタデータが残っている
  // When: ネイティブクリップボードへの書き込み失敗後に状態を消す
  // Then: 同じ文字列でも通常貼り付けへフォールバックできる
  it("Scenario: クリップボード失敗後は矩形メタデータを使わない", () => {
    const clipboard = new RectangularClipboard();
    clipboard.set("bc\nBC");
    clipboard.clear();

    expect(clipboard.rowsFor("bc\nBC")).toBeNull();
  });
});
