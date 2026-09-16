import type { SqliteCell, SqliteObject, SqlitePreview } from "./api";

const SQLITE_ROW_HEIGHT = 28;
const SQLITE_OVERSCAN_ROWS = 20;

export interface SqlitePreviewRendererPorts {
  read: (
    path: string,
    selectedName: string | null,
    offset: number,
    limit: number,
    includeMetadata: boolean,
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
  const gotoForm = document.createElement("form");
  gotoForm.className = "sqlite-goto";
  gotoForm.noValidate = true;
  const gotoLabel = document.createElement("label");
  gotoLabel.textContent = "表示位置へ移動";
  const gotoInput = document.createElement("input");
  gotoInput.type = "number";
  gotoInput.min = "1";
  gotoInput.step = "1";
  gotoInput.inputMode = "numeric";
  gotoInput.placeholder = "行番号";
  gotoInput.dataset.action = "sqlite-goto-input";
  gotoInput.setAttribute("aria-label", "表示位置へ移動");
  const gotoButton = document.createElement("button");
  gotoButton.type = "submit";
  gotoButton.dataset.action = "sqlite-goto";
  gotoButton.textContent = "移動";
  const gotoError = document.createElement("span");
  gotoError.className = "sqlite-goto-error";
  gotoError.setAttribute("aria-live", "polite");
  gotoLabel.append(gotoInput);
  gotoForm.append(gotoLabel, gotoButton, gotoError);
  const orderNote = document.createElement("p");
  orderNote.className = "sqlite-order-note";
  orderNote.textContent = "現在の結果順の位置です。再読み込みやDB更新後に同じ行を指す保証はありません";
  const viewDefinition = document.createElement("details");
  viewDefinition.className = "sqlite-view-definition";
  viewDefinition.dataset.sqliteViewDefinition = "";
  const viewDefinitionSummary = document.createElement("summary");
  viewDefinitionSummary.textContent = "ビュー定義";
  const viewDefinitionText = document.createElement("pre");
  viewDefinition.append(viewDefinitionSummary, viewDefinitionText);
  viewDefinition.hidden = true;
  const pageError = document.createElement("div");
  pageError.className = "sqlite-page-error";
  pageError.setAttribute("role", "alert");
  pageError.hidden = true;
  const objectControls = document.createElement("div");
  objectControls.className = "sqlite-object-controls";
  objectControls.append(tableLabel, viewDefinition);
  toolbar.append(objectControls, reload, count, gotoForm);
  const bodyHost = document.createElement("div");
  bodyHost.className = "sqlite-table-wrap";
  bodyHost.tabIndex = 0;
  bodyHost.setAttribute("aria-label", "SQLiteレコード");
  root.append(toolbar, orderNote, pageError, bodyHost);
  host.replaceChildren(root);

  let selectedName: string | null = null;
  let pageSize = 0;
  let totalRows: number | null = null;
  let metadataError: string | null = null;
  let hasMore = false;
  let knownRows = 0;
  let pages = new Map<number, SqliteCell[][]>();
  let pending = false;
  let generation = 0;
  let disposed = false;
  let renderScheduled = false;
  let renderInProgress = false;
  let renderAgain = false;
  let currentWindowStart = 0;
  let currentWindowEnd = 0;
  let tableBody: HTMLTableSectionElement | null = null;
  let topSpacer: HTMLTableRowElement | null = null;
  let bottomSpacer: HTMLTableRowElement | null = null;

  function isCurrent(id: number): boolean {
    return !disposed && id === generation;
  }

  function setPending(value: boolean) {
    pending = value;
    tableSelect.disabled = value || tableSelect.options.length === 0;
    reload.disabled = value;
    gotoInput.disabled = value;
    gotoButton.disabled = value;
  }

  function setGotoError(message = "") {
    gotoError.textContent = message;
    gotoInput.setCustomValidity(message);
  }

  function gotoValidationError(): string | null {
    if (totalRows === null) return "総行数を取得できないため移動できません";
    const value = Number(gotoInput.value.trim());
    if (!Number.isSafeInteger(value) || value < 1 || value > totalRows) {
      return `1〜${totalRows.toLocaleString("ja-JP")}の整数を指定してください`;
    }
    return null;
  }

  function setSummary() {
    const table = selectedName ?? "SQLite";
    const end = currentWindowEnd;
    const error = metadataError ? ` / ${metadataError}` : "";
    const text = totalRows === null
      ? `${table}: ${end.toLocaleString("ja-JP")}行表示${error}`
      : `${table}: 表示中 ${Math.max(0, end - currentWindowStart).toLocaleString("ja-JP")} / 全 ${totalRows.toLocaleString("ja-JP")} 行${error}`;
    count.textContent = text;
    summary.classList.toggle("warning", metadataError !== null);
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
      selectedName = null;
      void load(false);
    }, { signal: listeners.signal });
    wrapper.append(reason, retry);
    clearPageError();
    bodyHost.replaceChildren(wrapper);
    tableBody = null;
    topSpacer = null;
    bottomSpacer = null;
    count.textContent = "読み込めません";
    summary.classList.add("warning");
    summary.title = message;
    summary.textContent = "SQLiteを読み込めません";
  }

  function clearPageError() {
    pageError.hidden = true;
    pageError.replaceChildren();
  }

  function setPageError(error: unknown, offset: number) {
    const message = error instanceof Error ? error.message : String(error);
    const reason = document.createElement("span");
    reason.textContent = `この範囲を読み込めませんでした: ${message}`;
    const retry = document.createElement("button");
    retry.type = "button";
    retry.textContent = "この範囲を再試行";
    retry.addEventListener("click", () => {
      clearPageError();
      void retryPage(offset);
    }, { signal: listeners.signal });
    pageError.replaceChildren(reason, retry);
    pageError.hidden = false;
  }

  function setObjects(objects: SqliteObject[]) {
    tableSelect.replaceChildren(...objects.map((object) => {
      const option = document.createElement("option");
      option.value = object.name;
      option.textContent = `${object.name}（${object.kind}）`;
      return option;
    }));
    if (selectedName && objects.some((object) => object.name === selectedName)) {
      tableSelect.value = selectedName;
    }
    tableSelect.disabled = pending || objects.length === 0;
  }

  function setViewDefinition(definition: string | null) {
    viewDefinition.hidden = !definition;
    viewDefinitionText.textContent = definition ?? "";
  }

  function createSpacer(position: "top" | "bottom", columnCount: number): HTMLTableRowElement {
    const row = document.createElement("tr");
    row.className = `sqlite-spacer sqlite-spacer-${position}`;
    const cell = document.createElement("td");
    cell.colSpan = Math.max(columnCount, 1);
    const space = document.createElement("div");
    space.dataset.sqliteSpacer = position;
    cell.append(space);
    row.append(cell);
    return row;
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
    topSpacer = createSpacer("top", columns.length);
    bottomSpacer = createSpacer("bottom", columns.length);
    tableBody.append(topSpacer, bottomSpacer);
    table.append(head, tableBody);
    bodyHost.replaceChildren(table);
  }

  function rowAt(index: number): SqliteCell[] | undefined {
    const offset = Math.floor(index / pageSize) * pageSize;
    return pages.get(offset)?.[index - offset];
  }

  function createDataRow(values: SqliteCell[]): HTMLTableRowElement {
    const row = document.createElement("tr");
    row.className = "sqlite-data-row";
    for (const value of values) {
      const cell = document.createElement("td");
      cell.textContent = formatSqliteCell(value);
      row.append(cell);
    }
    return row;
  }

  function renderWindow(start: number, end: number) {
    if (!tableBody || !topSpacer || !bottomSpacer) return;
    currentWindowStart = start;
    currentWindowEnd = end;
    const fragment = document.createDocumentFragment();
    fragment.append(topSpacer);
    for (let index = start; index < end; index += 1) {
      const row = rowAt(index);
      if (row) fragment.append(createDataRow(row));
    }
    fragment.append(bottomSpacer);
    tableBody.replaceChildren(fragment);
    const layoutRows = totalRows ?? knownRows + (hasMore ? pageSize : 0);
    const bottom = Math.max(0, layoutRows - end) * SQLITE_ROW_HEIGHT;
    topSpacer.firstElementChild!.setAttribute("style", `height:${start * SQLITE_ROW_HEIGHT}px`);
    bottomSpacer.firstElementChild!.setAttribute("style", `height:${bottom}px`);
    setSummary();
  }

  function windowRange() {
    const firstVisible = Math.max(0, Math.floor(bodyHost.scrollTop / SQLITE_ROW_HEIGHT));
    const visibleRows = Math.max(1, Math.ceil((bodyHost.clientHeight || 600) / SQLITE_ROW_HEIGHT));
    const lastPossible = totalRows ?? Math.max(
      knownRows + (hasMore ? pageSize : 0),
      firstVisible + visibleRows + SQLITE_OVERSCAN_ROWS,
    );
    return {
      start: Math.max(0, firstVisible - SQLITE_OVERSCAN_ROWS),
      end: Math.min(lastPossible, firstVisible + visibleRows + SQLITE_OVERSCAN_ROWS),
    };
  }

  async function readPage(offset: number, includeMetadata: boolean, id: number): Promise<SqlitePreview | null> {
    const result = await ports.read(sourcePath, selectedName, offset, pageSize, includeMetadata);
    if (!isCurrent(id)) return null;
    pages.set(offset, result.rows);
    knownRows = Math.max(knownRows, offset + result.rows.length);
    hasMore = result.hasMore;
    if (result.totalRows !== null) totalRows = result.totalRows;
    if (includeMetadata) {
      metadataError = result.metadataError;
      selectedName = result.selectedName;
      setObjects(result.objects);
      setViewDefinition(result.viewDefinition);
    }
    return result;
  }

  async function ensurePages(start: number, end: number, id: number): Promise<boolean> {
    if (end <= start) return true;
    const firstPage = Math.floor(start / pageSize) * pageSize;
    const lastPage = Math.floor((end - 1) / pageSize) * pageSize;
    for (let offset = firstPage; offset <= lastPage; offset += pageSize) {
      if (pages.has(offset)) continue;
      try {
        if (!await readPage(offset, false, id)) return false;
      } catch (error) {
        if (isCurrent(id)) setPageError(error, offset);
        return false;
      }
    }
    return true;
  }

  async function renderForScroll() {
    if (disposed) return;
    if (pending) {
      renderAgain = true;
      return;
    }
    renderInProgress = true;
    pending = true;
    const id = generation;
    let range = windowRange();
    setPending(true);
    try {
      if (await ensurePages(range.start, range.end, id) && isCurrent(id)) {
        if (totalRows === null && hasMore && range.end >= knownRows) {
          await ensurePages(knownRows, knownRows + pageSize, id);
          range = windowRange();
        }
        renderWindow(range.start, range.end);
      }
    } catch (error) {
      if (isCurrent(id)) setError(error);
    } finally {
      if (isCurrent(id)) {
        pending = false;
        setPending(false);
        if (renderAgain) {
          renderAgain = false;
          scheduleRender();
        }
      }
      renderInProgress = false;
    }
  }

  async function retryPage(offset: number) {
    if (disposed || pending) return;
    pending = true;
    const id = generation;
    let succeeded = false;
    setPending(true);
    try {
      if (!await readPage(offset, false, id) || !isCurrent(id)) return;
      clearPageError();
      succeeded = true;
    } catch (error) {
      if (isCurrent(id)) setPageError(error, offset);
    } finally {
      if (isCurrent(id)) {
        pending = false;
        setPending(false);
        if (succeeded) scheduleRender();
      }
    }
  }

  function scheduleRender() {
    if (renderScheduled || disposed) return;
    renderScheduled = true;
    queueMicrotask(() => {
      renderScheduled = false;
      if (!renderInProgress) void renderForScroll();
      else renderAgain = true;
    });
  }

  async function moveToRow() {
    setGotoError();
    const error = gotoValidationError();
    if (error) {
      setGotoError(error);
      return;
    }
    const total = totalRows;
    if (total === null) return;
    const value = Number(gotoInput.value.trim());
    if (pending) return;
    pending = true;
    const id = generation;
    setPending(true);
    const index = value - 1;
    const offset = Math.floor(index / pageSize) * pageSize;
    try {
      if (!pages.has(offset) && !await readPage(offset, false, id)) return;
      if (!isCurrent(id)) return;
      const end = Math.min(total, offset + pageSize);
      renderWindow(offset, end);
      bodyHost.scrollTop = index * SQLITE_ROW_HEIGHT;
    } catch (error) {
      if (isCurrent(id)) setPageError(error, offset);
    } finally {
      if (isCurrent(id)) {
        pending = false;
        setPending(false);
      }
    }
  }

  async function load(_resetPageSize: boolean): Promise<boolean> {
    if (disposed || pending) return false;
    pending = true;
    const id = ++generation;
    if (!pageSize || _resetPageSize) {
      const configured = ports.getRowLimit();
      pageSize = Number.isInteger(configured) && configured > 0 ? configured : 1;
    }
    pages = new Map();
    totalRows = null;
    metadataError = null;
    hasMore = false;
    knownRows = 0;
    currentWindowStart = 0;
    currentWindowEnd = 0;
    tableBody = null;
    topSpacer = null;
    bottomSpacer = null;
    clearPageError();
    bodyHost.replaceChildren();
    bodyHost.scrollTop = 0;
    setViewDefinition(null);
    setGotoError();
    count.textContent = "行数を計算中…";
    summary.classList.remove("warning");
    summary.title = "";
    summary.textContent = "行数を計算中…";
    setPending(true);
    try {
      const result = await readPage(0, true, id);
      if (!result || !isCurrent(id)) return false;
      createTable(result.columns);
      const range = windowRange();
      renderWindow(range.start, range.end);
      return true;
    } catch (error) {
      if (!isCurrent(id)) return false;
      setError(error);
      return true;
    } finally {
      if (isCurrent(id)) {
        pending = false;
        setPending(false);
      }
    }
  }

  tableSelect.addEventListener("change", () => {
    selectedName = tableSelect.value || null;
    void load(true);
  }, { signal: listeners.signal });
  reload.addEventListener("click", () => {
    selectedName = null;
    void load(true);
  }, { signal: listeners.signal });
  gotoInput.addEventListener("input", () => setGotoError(), { signal: listeners.signal });
  gotoInput.addEventListener("invalid", () => {
    setGotoError(gotoValidationError() ?? "表示位置を指定してください");
  }, { signal: listeners.signal });
  gotoForm.addEventListener("submit", (event) => {
    event.preventDefault();
    void moveToRow();
  }, { signal: listeners.signal });
  bodyHost.addEventListener("scroll", scheduleRender, { signal: listeners.signal });

  return {
    load: () => load(true),
    dispose: () => {
      if (disposed) return;
      disposed = true;
      generation += 1;
      listeners.abort();
      root.remove();
    },
  };
}
