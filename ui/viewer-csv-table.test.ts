// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import { renderCsvTable } from "./viewer-csv-table";

describe("Feature: CSVテーブル描画", () => {
  // Given: タブ区切りの2行データと列幅状態
  // When: CSVテーブルを描画する
  // Then: タブで列が分かれ、行番号幅と列幅変更ハンドルが共通仕様になる
  it("Scenario: TSVをCSVビューと同じ列構造で描画する", () => {
    const result = renderCsvTable({
      text: "name\tvalue\nA\t1",
      delimiter: "\\t",
      selection: null,
      columnWidths: [120, 80],
      onColumnResize: vi.fn(),
    });

    const lineNumber = result.table.querySelector(".viewer-line-number-column") as HTMLElement;
    expect(lineNumber.style.width).toBe("64px");
    expect([...result.table.rows[0].cells].map((cell) => cell.textContent)).toEqual([
      "1",
      "name",
      "value",
    ]);
    expect(result.table.querySelectorAll(".viewer-column-resizer")).toHaveLength(2);
    expect(result.table.style.tableLayout).toBe("fixed");
  });

  // Given: 描画済みの列幅状態
  // When: 1列目のリサイズハンドルを押す
  // Then: 親へテーブルと対象列を渡す
  it("Scenario: 列幅変更を呼び出し側へ委譲する", () => {
    const onColumnResize = vi.fn();
    const result = renderCsvTable({
      text: "a,b",
      delimiter: ",",
      selection: null,
      columnWidths: [],
      onColumnResize,
    });
    result.table.querySelector<HTMLElement>(".viewer-column-resizer")!
      .dispatchEvent(new PointerEvent("pointerdown", { bubbles: true }));

    expect(onColumnResize).toHaveBeenCalledWith(
      expect.any(PointerEvent),
      result.table,
      expect.any(Array),
      0,
    );
  });
});
