import type * as api from "./api";
import type { ExternalMergePreviewSubscription } from "./external-watch";
import { openModal } from "./modal";

export type ExternalMergeChoice = "merge" | "keep" | "reload";
const EXTERNAL_MERGE_RETRY_CODE = "external_merge_retry";

export function isExternalMergeRetryError(error: unknown): boolean {
  if (error === EXTERNAL_MERGE_RETRY_CODE) return true;
  const message = error instanceof Error ? error.message : String(error);
  return message.includes("外部ファイルが再度変更されました");
}

function diffCell(marker: string, line: string | undefined, className: string): HTMLElement {
  const cell = document.createElement("div");
  const cellClass = line === undefined ? "em-empty-cell" : className;
  cell.className = `em-diff-cell ${cellClass}${line === undefined ? " is-empty" : ""}`;
  const markerEl = document.createElement("span");
  markerEl.className = "em-diff-marker";
  markerEl.textContent = line === undefined ? " " : marker;
  const text = document.createElement("span");
  text.className = "em-diff-text";
  text.textContent = line ?? "";
  cell.append(markerEl, text);
  return cell;
}

function diffCellWithNumber(
  marker: string,
  lineNumber: number | undefined,
  line: string | undefined,
  className: string,
): HTMLElement {
  const cell = diffCell(marker, line, className);
  const lineNumberEl = document.createElement("span");
  lineNumberEl.className = "em-line-number";
  lineNumberEl.textContent = line === undefined || lineNumber === undefined ? "" : String(lineNumber);
  cell.insertBefore(lineNumberEl, cell.firstChild);
  return cell;
}

function renderDiff(changes: HTMLElement, preview: api.ExternalMergePreview) {
  changes.replaceChildren();
  if (!preview.changes.length) {
    const empty = document.createElement("div");
    empty.className = "em-empty";
    empty.textContent = "表示する差分はありません。外部ファイルを採用するか、自分の編集を維持できます。";
    changes.append(empty);
    return;
  }

  const diff = document.createElement("div");
  diff.className = "em-diff";
  const headers = document.createElement("div");
  headers.className = "em-diff-columns em-diff-headers";
  const mineHeader = document.createElement("div");
  mineHeader.className = "em-diff-header-mine";
  mineHeader.textContent = "WasabiPad側";
  const theirsHeader = document.createElement("div");
  theirsHeader.className = "em-diff-header-theirs";
  theirsHeader.textContent = "外部アプリ側";
  headers.append(mineHeader, theirsHeader);
  diff.append(headers);

  for (const change of preview.changes) {
    const group = document.createElement("section");
    group.className = `em-diff-group${change.conflict ? " is-conflict" : ""}`;

    const rows = document.createElement("div");
    rows.className = "em-diff-body";
    const appendRow = (
      mine: string | undefined,
      theirs: string | undefined,
      mineLine: number | undefined,
      theirsLine: number | undefined,
      context: boolean,
    ) => {
      const row = document.createElement("div");
      row.className = `em-diff-row${context ? " is-context" : ""}`;
      row.append(
        diffCellWithNumber(context ? " " : "-", mineLine, mine, context ? "em-context" : "em-mine"),
        diffCellWithNumber(context ? " " : "+", theirsLine, theirs, context ? "em-context" : "em-theirs"),
      );
      rows.append(row);
    };

    for (let i = 0; i < change.before.length; i++) {
      const context = change.before[i];
      appendRow(
        context.text,
        context.text,
        context.mine_line,
        context.theirs_line,
        true,
      );
    }
    const changedRows = Math.max(change.mine.length, change.theirs.length, 1);
    for (let i = 0; i < changedRows; i++) {
      appendRow(
        change.mine[i],
        change.theirs[i],
        change.mine[i] === undefined ? undefined : change.mine_start_line + i,
        change.theirs[i] === undefined ? undefined : change.theirs_start_line + i,
        false,
      );
    }
    for (let i = 0; i < change.after.length; i++) {
      const context = change.after[i];
      appendRow(
        context.text,
        context.text,
        context.mine_line,
        context.theirs_line,
        true,
      );
    }
    group.append(rows);
    diff.append(group);
  }
  changes.append(diff);
}

export function confirmExternalMerge(
  preview: api.ExternalMergePreview,
  subscribe?: ExternalMergePreviewSubscription,
): Promise<ExternalMergeChoice | null> {
  return new Promise((resolve) => {
    let closed = false;
    const { box, close } = openModal({
      onCancel: () => finish(null),
      onAccept: () => finish("merge"),
    }, "pf-merge-box");

    const title = document.createElement("div");
    title.className = "pf-title";
    title.textContent = "ほかのアプリで編集されました";
    box.append(title);

    const message = document.createElement("div");
    message.className = "pf-message";
    box.append(message);

    const changes = document.createElement("div");
    changes.className = "em-changes";
    box.append(changes);

    let unsubscribe: (() => void) | undefined;
    const renderPreview = (next: api.ExternalMergePreview) => {
      message.textContent = next.conflict_count
        ? `外部の変更を表示しています。競合 ${next.conflict_count} 箇所は自分の編集を優先します。`
        : "外部の変更を自分の編集へ取り込みますか？";
      renderDiff(changes, next);
    };
    renderPreview(preview);

    const note = document.createElement("div");
    note.className = "em-note";
    note.textContent = "マージ後は未保存状態になります。内容を確認してから保存してください。";
    box.append(note);

    const buttons = document.createElement("div");
    buttons.className = "pf-btns";
    const cancel = document.createElement("button");
    cancel.textContent = "キャンセル";
    const reload = document.createElement("button");
    reload.textContent = "外部を採用";
    const keep = document.createElement("button");
    keep.textContent = "自分を維持";
    const merge = document.createElement("button");
    merge.className = "pf-ok";
    merge.textContent = "マージする";
    buttons.append(cancel, reload, keep, merge);
    box.append(buttons);

    const finish = (choice: ExternalMergeChoice | null) => {
      if (closed) return;
      closed = true;
      unsubscribe?.();
      close();
      resolve(choice);
    };
    cancel.addEventListener("click", () => finish(null));
    reload.addEventListener("click", () => finish("reload"));
    keep.addEventListener("click", () => finish("keep"));
    merge.addEventListener("click", () => finish("merge"));
    unsubscribe = subscribe?.(renderPreview);
    merge.focus();
  });
}
