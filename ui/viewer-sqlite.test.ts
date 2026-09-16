// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import type { SqlitePreview } from "./api";
import {
  createSqlitePreviewController,
  formatSqliteCell,
} from "./viewer-sqlite";

function preview(overrides: Partial<SqlitePreview> = {}): SqlitePreview {
  return {
    objects: [{ name: "items", kind: "table" }, { name: "sqlite_schema", kind: "table" }],
    selectedName: "items",
    columns: ["id", "value"],
    rows: [[{ kind: "integer", value: "1" }, { kind: "text", value: "one", truncated: false }]],
    hasMore: false,
    ...overrides,
  };
}

describe("Feature: SQLite viewer", () => {
  // Given: SQLite読取結果にNULL、BLOB、長文が含まれる
  // When: 表示用の値へ変換する
  // Then: NULL、バイト数、長文省略を明示する
  it("Scenario: SQLite値を仕様どおり表示する", () => {
    expect(formatSqliteCell({ kind: "null" })).toBe("NULL");
    expect(formatSqliteCell({ kind: "blob", bytes: 12 })).toBe("BLOB (12バイト)");
    expect(formatSqliteCell({ kind: "text", value: "long", truncated: true })).toBe("long…");
  });

  // Given: 通常テーブルとsqlite_schemaを含む初回読取結果
  // When: SQLiteプレビューを開始する
  // Then: テーブル選択、レコード表、行順の注意、さらに表示を表示する
  it("Scenario: 初回読込で選択欄とレコード表を表示する", async () => {
    const host = document.createElement("div");
    const summary = document.createElement("span");
    const read = vi.fn(async () => preview({ hasMore: true }));
    const controller = createSqlitePreviewController(host, summary, "C:\\work\\data.sqlite", {
      read,
      getRowLimit: () => 100,
    });

    await controller.load();

    expect(read).toHaveBeenCalledWith("C:\\work\\data.sqlite", null, 0, 100);
    expect(host.querySelector<HTMLSelectElement>("[data-sqlite-table]")?.value).toBe("items");
    expect(host.querySelector(".viewer-grid tbody tr td")?.textContent).toBe("1");
    expect(host.textContent).toContain("行順はSQLiteの取得順です（順序は保証されません）");
    expect(host.querySelector<HTMLButtonElement>("[data-action=sqlite-more]")?.hidden).toBe(false);
    controller.dispose();
  });

  // Given: 初回100行と、続き401行を返すSQLite読取
  // When: さらに表示を押す
  // Then: 同じ設定値で読み、DOMへの追加は200行単位になる
  it("Scenario: さらに表示は同じ件数を200行単位で追加する", async () => {
    const host = document.createElement("div");
    const summary = document.createElement("span");
    const read = vi.fn()
      .mockResolvedValueOnce(preview({ rows: [[{ kind: "integer", value: "1" }, { kind: "null" }]], hasMore: true }))
      .mockResolvedValueOnce(preview({ rows: Array.from({ length: 401 }, () => [
        { kind: "integer", value: "2" }, { kind: "null" },
      ]), hasMore: true }));
    const controller = createSqlitePreviewController(host, summary, "C:\\work\\data.sqlite", {
      read,
      getRowLimit: () => 3,
    });
    await controller.load();
    const body = host.querySelector<HTMLTableSectionElement>("tbody")!;
    const append = vi.spyOn(body, "append");

    host.querySelector<HTMLButtonElement>("[data-action=sqlite-more]")!.click();
    await vi.waitFor(() => expect(read).toHaveBeenCalledTimes(2));

    expect(read).toHaveBeenLastCalledWith("C:\\work\\data.sqlite", "items", 1, 3);
    expect(append).toHaveBeenCalledTimes(3);
    expect(body.rows).toHaveLength(402);
    controller.dispose();
  });

  // Given: SQLite読取がロック理由で失敗する
  // When: 初回読込を行う
  // Then: 理由と再読み込み操作をプレビューへ表示する
  it("Scenario: 読込失敗の理由と再読み込みを表示する", async () => {
    const host = document.createElement("div");
    const summary = document.createElement("span");
    const read = vi.fn()
      .mockRejectedValueOnce(new Error("database is locked"))
      .mockResolvedValueOnce(preview());
    const controller = createSqlitePreviewController(host, summary, "C:\\work\\data.sqlite", {
      read,
      getRowLimit: () => 100,
    });

    await controller.load();
    expect(host.querySelector(".viewer-error")?.textContent).toContain("database is locked");
    host.querySelector<HTMLButtonElement>("[data-action=sqlite-error-reload]")!.click();
    await vi.waitFor(() => expect(read).toHaveBeenCalledTimes(2));
    expect(host.querySelector(".viewer-grid")).not.toBeNull();
    controller.dispose();
  });
});
