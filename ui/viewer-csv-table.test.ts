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

  // Given: 2行のCSVと2行目のキャレット位置
  // When: CSVテーブルを描画する
  // Then: キャレット行の行番号だけ色変更用クラスを持つ
  it("Scenario: キャレット行の行番号を強調する", () => {
    const result = renderCsvTable({
      text: "name,value\nA,1",
      delimiter: ",",
      selection: { start: { line: 1, col: 2 }, end: { line: 1, col: 2 } },
      columnWidths: [],
      onColumnResize: vi.fn(),
    });

    expect(result.table.rows[0].querySelector(".viewer-line-number")?.classList.contains("viewer-caret-line-number"))
      .toBe(false);
    expect(result.table.rows[1].querySelector(".viewer-line-number")?.classList.contains("viewer-caret-line-number"))
      .toBe(true);
  });

  // Given: 複数行選択と、その選択を操作しているキャレット位置
  // When: CSVテーブルを描画する
  // Then: 選択範囲が複数行でもキャレット行の行番号だけを強調する
  it("Scenario: 複数行選択中もキャレット行の行番号を強調する", () => {
    const result = renderCsvTable({
      text: "name,value\nA,1\nB,2",
      delimiter: ",",
      selection: {
        start: { line: 1, col: 0 },
        end: { line: 2, col: 3 },
        caret: { line: 2, col: 3 },
      },
      columnWidths: [],
      onColumnResize: vi.fn(),
    });

    expect(result.table.rows[0].querySelector(".viewer-line-number")?.classList.contains("viewer-caret-line-number"))
      .toBe(false);
    expect(result.table.rows[1].querySelector(".viewer-line-number")?.classList.contains("viewer-caret-line-number"))
      .toBe(false);
    expect(result.table.rows[2].querySelector(".viewer-line-number")?.classList.contains("viewer-caret-line-number"))
      .toBe(true);
  });
});
