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
    totalRows: 1,
    viewDefinition: null,
    metadataError: null,
    ...overrides,
  };
}

function rows(count: number, start = 1) {
  return Array.from({ length: count }, (_, index) => [
    { kind: "integer" as const, value: String(start + index) },
    { kind: "text" as const, value: `value-${start + index}`, truncated: false },
  ]);
}

describe("Feature: SQLite viewer", () => {
  // Given: 結果を表示し、一時ビューのSQLを実行中
  // When: 入力と注意を閉じてから実行が成功または失敗する
  // Then: 手動の開閉状態を保ち、広がった表を描画し、失敗時は外側にエラーを表示する
  it.each([true, false])("Scenario: 実行中に閉じても結果とエラーを確認できる（成功=%s）", async (succeeds) => {
    const host = document.createElement("div");
    let resolve!: (value: SqlitePreview) => void;
    let reject!: (error: Error) => void;
    const result = preview({ rows: rows(200), totalRows: 200 });
    const read = vi.fn().mockResolvedValueOnce(result).mockImplementationOnce(() =>
      new Promise<SqlitePreview>((accept, fail) => { resolve = accept; reject = fail; }));
    const controller = createSqlitePreviewController(host, document.createElement("span"), "C:\\work\\data.sqlite", {
      read,
      getRowLimit: () => 200,
    });
    const details = host.querySelector<HTMLDetailsElement>(".sqlite-disclosure")!;
    details.open = true;
    const body = host.querySelector<HTMLElement>(".sqlite-table-wrap")!;
    let height = 28;
    Object.defineProperty(body, "clientHeight", { get: () => height });
    await controller.load();
    const input = host.querySelector<HTMLTextAreaElement>("textarea")!;
    input.value = "SELECT id FROM items";
    host.querySelector(".sqlite-query")!.dispatchEvent(new SubmitEvent("submit", { cancelable: true }));
    expect(input.disabled).toBe(true);
    height = 280;
    details.open = false;
    details.dispatchEvent(new Event("toggle"));
    await Promise.resolve();

    if (succeeds) resolve(preview({ rows: rows(200, 1001), totalRows: 200 }));
    else reject(new Error("syntax error"));
    await vi.waitFor(() => expect(input.disabled).toBe(false));
    await vi.waitFor(() => expect(host.querySelectorAll(".sqlite-data-row")).toHaveLength(30));
    expect(details.open).toBe(false);
    expect(input.value).toBe("SELECT id FROM items");
    expect(host.querySelector(".sqlite-data-row td")!.textContent).toBe(succeeds ? "1001" : "1");
    const error = host.querySelector<HTMLElement>(".sqlite-query-error")!;
    expect(error.hidden).toBe(succeeds);
    expect(error.closest("details")).toBeNull();
    if (!succeeds) expect(error.textContent).toBe("syntax error");
    controller.dispose();
  });

  // Given: 一時ビューと表示上の注意を開いている
  // When: プレビューを閉じて新しく開く
  // Then: 両方の開閉状態を初期状態へ戻す
  it("Scenario: プレビューを開き直すと両方の領域を畳む", async () => {
    const host = document.createElement("div");
    const ports = { read: async () => preview(), getRowLimit: () => 100 };
    const first = createSqlitePreviewController(host, document.createElement("span"), "C:\\work\\data.sqlite", ports);
    await first.load();
    host.querySelectorAll<HTMLDetailsElement>(".sqlite-disclosure").forEach((details) => { details.open = true; });
    first.dispose();
    const reopened = createSqlitePreviewController(host, document.createElement("span"), "C:\\work\\data.sqlite", ports);
    await reopened.load();
    expect(Array.from(host.querySelectorAll<HTMLDetailsElement>(".sqlite-disclosure"), (details) => details.open)).toEqual([false, false]);
    reopened.dispose();
  });

  // Given: 入力SQLと200行の結果があり、表を途中までスクロールしている
  // When: 一時ビューまたは注意を閉じて表の高さが増える
  // Then: スクロールや入力、選択を保ったまま表示する行が増える
  it.each(["SQLite一時ビュー", "表示上の注意"])("Scenario: %sの開閉に表の表示範囲が追従する", async (title) => {
    const host = document.createElement("div");
    const read = vi.fn(async () => preview({ rows: rows(200), totalRows: 200 }));
    const controller = createSqlitePreviewController(host, document.createElement("span"), "C:\\work\\data.sqlite", {
      read,
      getRowLimit: () => 200,
    });
    const details = Array.from(host.querySelectorAll("details"))
      .find((element) => element.querySelector("summary")?.textContent === title)!;
    details.open = true;
    const body = host.querySelector<HTMLElement>(".sqlite-table-wrap")!;
    let height = 28;
    Object.defineProperty(body, "clientHeight", { get: () => height });
    body.scrollTop = 1400;
    await controller.load();
    body.scrollTop = 1400;
    body.dispatchEvent(new Event("scroll"));
    await vi.waitFor(() => expect(host.querySelectorAll(".sqlite-data-row")).toHaveLength(41));
    const input = host.querySelector<HTMLTextAreaElement>("textarea")!;
    input.value = "SELECT id FROM items";

    height = 280;
    details.open = false;
    details.dispatchEvent(new Event("toggle"));
    await vi.waitFor(() => expect(host.querySelectorAll(".sqlite-data-row")).toHaveLength(50));

    expect(body.scrollTop).toBe(1400);
    expect(input.value).toBe("SELECT id FROM items");
    expect(host.querySelector<HTMLSelectElement>("[data-sqlite-table]")!.value).toBe("items");
    expect(read).toHaveBeenCalledTimes(1);
    controller.dispose();
  });

  // Given: 新しく開いたSQLiteプレビュー
  // When: 初期表示する
  // Then: 一時ビューと注意は閉じ、入力と説明は見出しから開ける
  it("Scenario: SQLite一時ビューと表示上の注意を初期状態で畳む", async () => {
    const host = document.createElement("div");
    const controller = createSqlitePreviewController(host, document.createElement("span"), "C:\\work\\data.sqlite", {
      read: async () => preview(),
      getRowLimit: () => 100,
    });
    await controller.load();

    const disclosures = Array.from(host.querySelectorAll("details"));
    const query = disclosures.find((element) => element.querySelector("summary")?.textContent === "SQLite一時ビュー");
    const notes = disclosures.find((element) => element.querySelector("summary")?.textContent === "表示上の注意");
    expect(query).toBeDefined();
    expect(notes).toBeDefined();
    expect(query!.open).toBe(false);
    expect(notes!.open).toBe(false);
    expect(query!.querySelector("textarea")).not.toBeNull();
    expect(query!.querySelector(".sqlite-query-note")).not.toBeNull();
    expect(notes!.textContent).toContain("現在の結果順の位置です");
    controller.dispose();
  });

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
  // Then: テーブル選択、レコード表、表示範囲、総行数、行順の注意を表示し、さらに表示を置かない
  it("Scenario: 初回読込で選択欄とレコード表を表示する", async () => {
    const host = document.createElement("div");
    const summary = document.createElement("span");
    const read = vi.fn(async () => preview({ totalRows: 1 }));
    const controller = createSqlitePreviewController(host, summary, "C:\\work\\data.sqlite", {
      read,
      getRowLimit: () => 100,
    });

    await controller.load();

    expect(read).toHaveBeenCalledWith("C:\\work\\data.sqlite", null, 0, 100, true);
    expect(host.querySelector<HTMLSelectElement>("[data-sqlite-table]")?.value).toBe("items");
    expect(host.querySelector(".sqlite-data-row td")?.textContent).toBe("1");
    expect(host.textContent).toContain("現在の結果順の位置です。再読み込みやDB更新後に同じ行を指す保証はありません");
    expect(host.textContent).toContain("表示範囲 1〜1 / 全 1 行");
    expect(host.querySelector("[data-action=sqlite-more]")).toBeNull();
    controller.dispose();
  });

  // Given: SQLiteプレビューで別のテーブルを選択している
  // When: 再読み込みを実行する
  // Then: 初期選択規則へ戻るため、選択名なしで読み直す
  it("Scenario: 再読み込みでSQLiteの選択を初期化する", async () => {
    const host = document.createElement("div");
    const summary = document.createElement("span");
    const read = vi.fn(async () => preview({
      objects: [
        { name: "items", kind: "table" },
        { name: "other", kind: "table" },
      ],
    }));
    const controller = createSqlitePreviewController(host, summary, "C:\\work\\data.sqlite", {
      read,
      getRowLimit: () => 100,
    });

    await controller.load();
    const select = host.querySelector<HTMLSelectElement>("[data-sqlite-table]")!;
    select.value = "other";
    select.dispatchEvent(new Event("change"));
    await vi.waitFor(() => expect(read).toHaveBeenCalledTimes(2));
    await vi.waitFor(() => expect(select.disabled).toBe(false));
    host.querySelector<HTMLButtonElement>("[data-action=sqlite-reload]")!.click();
    await vi.waitFor(() => expect(read).toHaveBeenCalledTimes(3));

    expect(read.mock.calls[2]).toEqual(["C:\\work\\data.sqlite", null, 0, 100, true]);
    controller.dispose();
  });

  // Given: SQLiteの初回読込が完了していない
  // When: SQLiteプレビューを開始する
  // Then: 総行数を計算中であることを表示する
  it("Scenario: 総行数の計算中を表示する", async () => {
    const host = document.createElement("div");
    const summary = document.createElement("span");
    let release!: (value: SqlitePreview) => void;
    const read = vi.fn(() => new Promise<SqlitePreview>((resolve) => {
      release = resolve;
    }));
    const controller = createSqlitePreviewController(host, summary, "C:\\work\\data.sqlite", {
      read,
      getRowLimit: () => 100,
    });

    const loading = controller.load();

    expect(host.querySelector(".sqlite-row-count")?.textContent).toBe("行数を計算中…");
    release(preview());
    await loading;
    controller.dispose();
  });

  // Given: 100行ずつ取得できる250行のSQLiteテーブル
  // When: 表の下端付近までスクロールする
  // Then: ボタン操作なしで次のページだけを取得し、画面外の行DOMを増やさない
  it("Scenario: スクロール位置に応じてSQLiteの次ページを自動取得する", async () => {
    const host = document.createElement("div");
    const summary = document.createElement("span");
    const read = vi.fn(async (
      _path: string,
      _selectedName: string | null,
      offset: number,
      limit: number,
      includeMetadata: boolean,
    ) => preview({
      rows: rows(Math.min(limit, 250 - offset), offset + 1),
      hasMore: offset + limit < 250,
      totalRows: includeMetadata ? 250 : null,
    }));
    const controller = createSqlitePreviewController(host, summary, "C:\\work\\data.sqlite", {
      read,
      getRowLimit: () => 100,
    });
    const bodyHost = host.querySelector<HTMLElement>(".sqlite-table-wrap")!;
    Object.defineProperty(bodyHost, "clientHeight", { configurable: true, value: 100 });
    await controller.load();

    Object.defineProperty(bodyHost, "scrollTop", { configurable: true, writable: true, value: 2_800 });
    bodyHost.dispatchEvent(new Event("scroll"));
    await vi.waitFor(() => expect(read).toHaveBeenCalledTimes(2));

    expect(read).toHaveBeenLastCalledWith("C:\\work\\data.sqlite", "items", 100, 100, false);
    expect(host.textContent).toContain("表示範囲 81〜124 / 全 250 行");
    expect(host.querySelectorAll("tbody tr.sqlite-data-row").length).toBeLessThanOrEqual(50);
    expect(host.querySelector("[data-action=sqlite-more]")).toBeNull();
    controller.dispose();
  });

  // Given: 次ページの初回読取だけが失敗するSQLiteテーブル
  // When: 表の下端付近までスクロールして再試行する
  // Then: 表を残したまま同じページだけを再読込する
  it("Scenario: SQLiteの段階読込失敗を同じページで再試行する", async () => {
    const host = document.createElement("div");
    const summary = document.createElement("span");
    let failed = false;
    const read = vi.fn(async (
      _path: string,
      _selectedName: string | null,
      offset: number,
      limit: number,
      includeMetadata: boolean,
    ) => {
      if (!includeMetadata && offset === 100 && !failed) {
        failed = true;
        throw new Error("page locked");
      }
      return preview({
        rows: rows(Math.min(limit, 250 - offset), offset + 1),
        hasMore: offset + limit < 250,
        totalRows: includeMetadata ? 250 : null,
      });
    });
    const controller = createSqlitePreviewController(host, summary, "C:\\work\\data.sqlite", {
      read,
      getRowLimit: () => 100,
    });
    const bodyHost = host.querySelector<HTMLElement>(".sqlite-table-wrap")!;
    Object.defineProperty(bodyHost, "clientHeight", { configurable: true, value: 100 });
    await controller.load();

    Object.defineProperty(bodyHost, "scrollTop", { configurable: true, writable: true, value: 2_800 });
    bodyHost.dispatchEvent(new Event("scroll"));
    await vi.waitFor(() => expect(host.querySelector(".sqlite-page-error")?.textContent).toContain("page locked"));
    expect(host.querySelector(".viewer-grid")).not.toBeNull();
    host.querySelector<HTMLButtonElement>(".sqlite-page-error button")!.click();
    await vi.waitFor(() => expect(read).toHaveBeenCalledTimes(3));
    expect(read).toHaveBeenLastCalledWith("C:\\work\\data.sqlite", "items", 100, 100, false);
    controller.dispose();
  });

  // Given: ビューがprice_historyと複数テーブルのJOINを定義している
  // When: ビューを選択してSQLiteプレビューを開始する
  // Then: 結果表とCREATE VIEW定義SQLを確認できる
  it("Scenario: ビューの結果と定義SQLを表示する", async () => {
    const host = document.createElement("div");
    const summary = document.createElement("span");
    const read = vi.fn(async () => preview({
      selectedName: "price_history",
      totalRows: 2,
      viewDefinition: "CREATE VIEW price_history AS SELECT * FROM price_history JOIN trading_days JOIN instruments JOIN quote_statuses",
      rows: rows(2),
    }));
    const controller = createSqlitePreviewController(host, summary, "C:\\work\\data.sqlite", {
      read,
      getRowLimit: () => 100,
    });

    await controller.load();

    expect(host.querySelector("[data-sqlite-view-definition]")).not.toBeNull();
    expect(host.textContent).toContain("CREATE VIEW price_history");
    expect(host.textContent).toContain("JOIN trading_days");
    controller.dispose();
  });

  // Given: SQLiteの総行数だけ取得できず、最初のページは取得できる
  // When: SQLiteプレビューを開始する
  // Then: 表を表示したまま、総行数を取得できない理由を表示する
  it("Scenario: 総行数の取得失敗後も表を表示する", async () => {
    const host = document.createElement("div");
    const summary = document.createElement("span");
    const read = vi.fn(async (
      _path: string,
      _selectedName: string | null,
      offset: number,
      limit: number,
      includeMetadata: boolean,
    ) => preview({
      rows: rows(Math.min(limit, 250 - offset), offset + 1),
      hasMore: offset + limit < 250,
      totalRows: null,
      metadataError: includeMetadata ? "総行数を取得できませんでした: COUNT failed" : null,
    }));
    const controller = createSqlitePreviewController(host, summary, "C:\\work\\data.sqlite", {
      read,
      getRowLimit: () => 100,
    });
    const bodyHost = host.querySelector<HTMLElement>(".sqlite-table-wrap")!;
    Object.defineProperty(bodyHost, "clientHeight", { configurable: true, value: 100 });

    await controller.load();

    expect(host.querySelector(".viewer-grid")).not.toBeNull();
    expect(host.textContent).toContain("総行数を取得できませんでした: COUNT failed");
    Object.defineProperty(bodyHost, "scrollTop", { configurable: true, writable: true, value: 2_800 });
    bodyHost.dispatchEvent(new Event("scroll"));
    await vi.waitFor(() => expect(read).toHaveBeenCalledTimes(2));
    expect(read).toHaveBeenLastCalledWith("C:\\work\\data.sqlite", "items", 100, 100, false);
    controller.dispose();
  });

  // Given: 1000行のSQLiteテーブルと、先頭ページだけが取得済み
  // When: 表示位置へ移動へ501を入力する
  // Then: 501行目を含むページを取得して表示する
  it("Scenario: 表示位置を指定してSQLiteの行を開く", async () => {
    const host = document.createElement("div");
    const summary = document.createElement("span");
    const read = vi.fn(async (
      _path: string,
      _selectedName: string | null,
      offset: number,
      limit: number,
      includeMetadata: boolean,
    ) => preview({
      rows: rows(Math.min(limit, 1000 - offset), offset + 1),
      hasMore: offset + limit < 1000,
      totalRows: includeMetadata ? 1000 : null,
    }));
    const controller = createSqlitePreviewController(host, summary, "C:\\work\\data.sqlite", {
      read,
      getRowLimit: () => 100,
    });
    await controller.load();

    const input = host.querySelector<HTMLInputElement>("[data-action=sqlite-goto-input]")!;
    input.value = "501";
    host.querySelector(".sqlite-goto")!.dispatchEvent(new SubmitEvent("submit", { cancelable: true }));
    await vi.waitFor(() => expect(read).toHaveBeenCalledTimes(2));

    expect(read).toHaveBeenLastCalledWith("C:\\work\\data.sqlite", "items", 500, 100, false);
    await vi.waitFor(() => expect(host.textContent).toContain("501"));
    expect(host.textContent).toContain("表示範囲 501〜600 / 全 1,000 行");
    controller.dispose();
  });

  // Given: 1000行のSQLiteテーブルを表示している
  // When: 存在しない表示位置を指定する
  // Then: SQLiteを再読込せず、入力理由を表示する
  it("Scenario: 不正な表示位置を拒否する", async () => {
    const host = document.createElement("div");
    const summary = document.createElement("span");
    const read = vi.fn(async () => preview({ totalRows: 1000, rows: rows(100) }));
    const controller = createSqlitePreviewController(host, summary, "C:\\work\\data.sqlite", {
      read,
      getRowLimit: () => 100,
    });
    await controller.load();
    const input = host.querySelector<HTMLInputElement>("[data-action=sqlite-goto-input]")!;
    for (const invalidValue of ["0", "1001", "1.5", "abc"]) {
      input.value = invalidValue;
      host.querySelector(".sqlite-goto")!.dispatchEvent(new SubmitEvent("submit", { cancelable: true }));
      await vi.waitFor(() => expect(host.querySelector(".sqlite-goto-error")?.textContent).toContain("1〜1,000"));
    }
    expect(read).toHaveBeenCalledTimes(1);
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
    await vi.waitFor(() => expect(host.querySelector(".viewer-grid")).not.toBeNull());
    controller.dispose();
  });

  // Given: 通常のSQLiteテーブルを表示している
  // When: 有効なSELECTの後に無効なSQLを実行し、表示をスクロールする
  // Then: 一時ビューを表示し、失敗時は前回結果を残し、後続ページにも成功済みSQLを使う
  it("Scenario: 一時ビューを成功時だけ置き換え、前回のSQL結果を保つ", async () => {
    const host = document.createElement("div");
    const summary = document.createElement("span");
    const validSql = "SELECT id FROM items ORDER BY id";
    const invalidSql = "not valid SQL";
    const delayedInvalidSql = "SELECT id FROM later";
    const temporaryName = "__wasabipad_temporary_view__";
    let rejectDelayedQuery: ((error: Error) => void) | undefined;
    const read = vi.fn(async (
      _path: string,
      _selectedName: string | null,
      offset: number,
      _limit: number,
      includeMetadata: boolean,
      querySql?: string,
    ) => {
      if (querySql === invalidSql) throw new Error("syntax error");
      if (querySql === delayedInvalidSql) {
        await new Promise<never>((_resolve, reject) => { rejectDelayedQuery = reject; });
      }
      if (querySql === validSql) {
        return preview({
          objects: [{ name: temporaryName, kind: "temporary view" }],
          selectedName: temporaryName,
          columns: ["id"],
          rows: [[{ kind: "integer", value: String(42 + offset) }]],
          hasMore: offset === 0,
          totalRows: includeMetadata ? 2 : null,
          viewDefinition: includeMetadata ? validSql : null,
        });
      }
      return preview({ rows: rows(1), hasMore: true, totalRows: 2 });
    });
    const controller = createSqlitePreviewController(host, summary, "C:\\work\\data.sqlite", {
      read,
      getRowLimit: () => 1,
    });
    const bodyHost = host.querySelector<HTMLElement>(".sqlite-table-wrap")!;
    Object.defineProperty(bodyHost, "clientHeight", { configurable: true, value: 28 });

    await controller.load();

    const queryInput = host.querySelector<HTMLTextAreaElement>("[data-action=sqlite-query-input]");
    expect(queryInput).not.toBeNull();
    queryInput!.value = validSql;
    host.querySelector<HTMLFormElement>("[data-action=sqlite-query]")!
      .dispatchEvent(new SubmitEvent("submit", { cancelable: true }));
    await vi.waitFor(() => expect(read).toHaveBeenCalledTimes(2));
    expect(read).toHaveBeenLastCalledWith("C:\\work\\data.sqlite", null, 0, 1, true, validSql);
    expect(host.querySelector("[data-sqlite-view-definition]")?.textContent).toContain(validSql);
    expect(host.querySelector(".sqlite-data-row td")?.textContent).toBe("42");

    queryInput!.value = invalidSql;
    host.querySelector<HTMLFormElement>("[data-action=sqlite-query]")!
      .dispatchEvent(new SubmitEvent("submit", { cancelable: true }));
    await vi.waitFor(() => expect(host.querySelector(".sqlite-query-error")?.textContent).toContain("syntax error"));
    expect(host.querySelector(".sqlite-data-row td")?.textContent).toBe("42");
    expect(host.querySelector("[data-sqlite-view-definition]")?.textContent).toContain(validSql);

    queryInput!.value = delayedInvalidSql;
    host.querySelector<HTMLFormElement>("[data-action=sqlite-query]")!
      .dispatchEvent(new SubmitEvent("submit", { cancelable: true }));
    await vi.waitFor(() => expect(read).toHaveBeenCalledTimes(4));
    Object.defineProperty(bodyHost, "scrollTop", { configurable: true, writable: true, value: 28 });
    bodyHost.dispatchEvent(new Event("scroll"));
    await Promise.resolve();
    expect(read).toHaveBeenCalledTimes(4);
    rejectDelayedQuery!(new Error("delayed syntax error"));
    await vi.waitFor(() => expect(host.querySelector(".sqlite-query-error")?.textContent).toContain("delayed syntax error"));
    await vi.waitFor(() => expect(read).toHaveBeenCalledTimes(5));
    expect(read).toHaveBeenLastCalledWith(
      "C:\\work\\data.sqlite",
      temporaryName,
      1,
      1,
      false,
      validSql,
    );
    controller.dispose();
  });
});
