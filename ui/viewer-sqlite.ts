import type { SqliteCell, SqliteObject, SqlitePreview } from "./api";

export const SQLITE_DOM_ROW_CHUNK = 200;

export interface SqlitePreviewRendererPorts {
  read: (
    path: string,
    selectedName: string | null,
    offset: number,
    limit: number,
  ) => Promise<SqlitePreview>;
  getRowLimit: () => number;
}

export interface SqlitePreviewController {
  load: () => Promise<boolean>;
  dispose: () => void;
}

export function formatSqliteCell(cell: SqliteCell): string {
  switch (cell.kind) {
    case "null":
      return "NULL";
    case "integer":
    case "real":
      return cell.value;
    case "text":
      return cell.value + (cell.truncated ? "…" : "");
    case "blob":
      return `BLOB (${cell.bytes.toLocaleString("ja-JP")}バイト)`;
  }
}

export function createSqlitePreviewController(
  host: HTMLElement,
  summary: HTMLElement,
  sourcePath: string,
  ports: SqlitePreviewRendererPorts,
): SqlitePreviewController {
  const listeners = new AbortController();
  const root = document.createElement("section");
  root.className = "sqlite-preview";

  const toolbar = document.createElement("div");
  toolbar.className = "sqlite-toolbar";
  const tableLabel = document.createElement("label");
  tableLabel.textContent = "テーブル";
  const tableSelect = document.createElement("select");
  tableSelect.dataset.sqliteTable = "";
  tableSelect.setAttribute("aria-label", "SQLiteテーブル");
  tableLabel.append(tableSelect);
  const reload = document.createElement("button");
  reload.type = "button";
  reload.dataset.action = "sqlite-reload";
  reload.textContent = "再読み込み";
  const count = document.createElement("span");
  count.className = "sqlite-row-count";
  toolbar.append(tableLabel, reload, count);

  const orderNote = document.createElement("p");
  orderNote.className = "sqlite-order-note";
  orderNote.textContent = "行順はSQLiteの取得順です（順序は保証されません）";
  const bodyHost = document.createElement("div");
  bodyHost.className = "sqlite-table-wrap";
  root.append(toolbar, orderNote, bodyHost);
  host.replaceChildren(root);

  let selectedName: string | null = null;
  let pageSize = 0;
  let rows: SqliteCell[][] = [];
  let hasMore = false;
  let pending = false;
  let requestId = 0;
  let disposed = false;
  let tableBody: HTMLTableSectionElement | null = null;
  let moreButton: HTMLButtonElement | null = null;

  function isCurrent(id: number): boolean {
    return !disposed && id === requestId;
  }

  function setSummary() {
    const table = selectedName ?? "SQLite";
    const text = `${table}: ${rows.length.toLocaleString("ja-JP")}行表示`;
    count.textContent = text;
    summary.classList.remove("warning");
    summary.title = "";
    summary.textContent = text;
  }

  function setError(error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    const wrapper = document.createElement("div");
    wrapper.className = "sqlite-error";
    const reason = document.createElement("p");
    reason.className = "viewer-error";
    reason.textContent = `SQLiteを読み込めませんでした: ${message}`;
    const retry = document.createElement("button");
    retry.type = "button";
    retry.dataset.action = "sqlite-error-reload";
    retry.textContent = "再読み込み";
    retry.addEventListener("click", () => {
      void load(false, true);
    }, { signal: listeners.signal });
    wrapper.append(reason, retry);
    bodyHost.replaceChildren(wrapper);
    count.textContent = "読み込めません";
    summary.classList.add("warning");
    summary.title = message;
    summary.textContent = "SQLiteを読み込めません";
  }

  function setObjects(objects: SqliteObject[]) {
    tableSelect.replaceChildren(...objects.map((object) => {
      const option = document.createElement("option");
      option.value = object.name;
      option.textContent = `${object.name}（${object.kind}）`;
      return option;
    }));
    tableSelect.disabled = objects.length === 0 || pending;
    if (selectedName && objects.some((object) => object.name === selectedName)) {
      tableSelect.value = selectedName;
    }
  }

  function createTable(columns: string[]) {
    const table = document.createElement("table");
    table.className = "viewer-grid sqlite-grid";
    table.setAttribute("aria-label", "SQLiteレコード");
    const head = document.createElement("thead");
    const headerRow = document.createElement("tr");
    for (const column of columns) {
      const cell = document.createElement("th");
      cell.scope = "col";
      cell.textContent = column;
      cell.title = column;
      headerRow.append(cell);
    }
    head.append(headerRow);
    tableBody = document.createElement("tbody");
    table.append(head, tableBody);
    bodyHost.replaceChildren(table);
  }

  function appendRows(values: SqliteCell[][]) {
    if (!tableBody) return;
    for (let start = 0; start < values.length; start += SQLITE_DOM_ROW_CHUNK) {
      const fragment = document.createDocumentFragment();
      for (const rowValues of values.slice(start, start + SQLITE_DOM_ROW_CHUNK)) {
        const row = document.createElement("tr");
        for (const value of rowValues) {
          const cell = document.createElement("td");
          cell.textContent = formatSqliteCell(value);
          row.append(cell);
        }
        fragment.append(row);
      }
      tableBody.append(fragment);
    }
  }

  function updateMoreButton() {
    if (!moreButton) return;
    moreButton.hidden = !hasMore;
    moreButton.disabled = pending;
  }

  function addMoreButton() {
    moreButton?.remove();
    moreButton = document.createElement("button");
    moreButton.type = "button";
    moreButton.dataset.action = "sqlite-more";
    moreButton.textContent = "さらに表示";
    moreButton.addEventListener("click", () => {
      void load(true, false);
    }, { signal: listeners.signal });
    toolbar.append(moreButton);
    updateMoreButton();
  }

  async function load(append: boolean, resetPageSize: boolean): Promise<boolean> {
    if (disposed || pending) return false;
    pending = true;
    const id = ++requestId;
    if (resetPageSize || !pageSize) {
      const configured = ports.getRowLimit();
      pageSize = Number.isInteger(configured) && configured > 0 ? configured : 1;
    }
    const offset = append ? rows.length : 0;
    if (!append) {
      rows = [];
      tableBody = null;
      bodyHost.replaceChildren();
    }
    tableSelect.disabled = true;
    updateMoreButton();
    try {
      const result = await ports.read(sourcePath, append ? selectedName : (selectedName ?? null), offset, pageSize);
      if (!isCurrent(id)) return false;
      selectedName = result.selectedName;
      setObjects(result.objects);
      if (!append) createTable(result.columns);
      appendRows(result.rows);
      rows = append ? rows.concat(result.rows) : result.rows;
      hasMore = result.hasMore;
      setSummary();
      if (!moreButton) addMoreButton();
      updateMoreButton();
      return true;
    } catch (error) {
      if (!isCurrent(id)) return false;
      hasMore = false;
      setError(error);
      if (!moreButton) addMoreButton();
      updateMoreButton();
      return true;
    } finally {
      if (isCurrent(id)) {
        pending = false;
        tableSelect.disabled = tableSelect.options.length === 0;
        updateMoreButton();
      }
    }
  }

  tableSelect.addEventListener("change", () => {
    selectedName = tableSelect.value || null;
    void load(false, true);
  }, { signal: listeners.signal });
  reload.addEventListener("click", () => {
    void load(false, true);
  }, { signal: listeners.signal });

  return {
    load: () => load(false, true),
    dispose: () => {
      if (disposed) return;
      disposed = true;
      requestId += 1;
      listeners.abort();
      root.remove();
    },
  };
}
