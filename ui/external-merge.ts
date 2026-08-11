import type * as api from "./api";
import { openModal } from "./modal";

export type ExternalMergeChoice = "merge" | "keep" | "reload";

function side(label: string, lines: string[], className: string): HTMLElement {
  const box = document.createElement("div");
  box.className = `em-side ${className}`;
  const heading = document.createElement("div");
  heading.className = "em-side-label";
  heading.textContent = label;
  const body = document.createElement("pre");
  body.className = "em-side-body";
  body.textContent = lines.length ? lines.join("\n") : "（変更なし）";
  box.append(heading, body);
  return box;
}

export function confirmExternalMerge(
  preview: api.ExternalMergePreview,
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
    message.textContent = preview.conflict_count
      ? `外部の変更を表示しています。競合 ${preview.conflict_count} 箇所は自分の編集を優先します。`
      : "外部の変更を自分の編集へ取り込みますか？";
    box.append(message);

    const changes = document.createElement("div");
    changes.className = "em-changes";
    for (const change of preview.changes) {
      const item = document.createElement("section");
      item.className = `em-change${change.conflict ? " is-conflict" : ""}`;
      const heading = document.createElement("div");
      heading.className = "em-change-heading";
      heading.textContent = `行 ${change.start_line}${change.conflict ? "（競合）" : ""}`;
      item.append(heading);
      const columns = document.createElement("div");
      columns.className = "em-columns";
      columns.append(
        side("WasabiPad側", change.mine, "em-mine"),
        side("外部アプリ側", change.theirs, "em-theirs"),
      );
      item.append(columns);
      changes.append(item);
    }
    if (!preview.changes.length) {
      const empty = document.createElement("div");
      empty.className = "em-empty";
      empty.textContent = "表示する差分はありません。外部ファイルを採用するか、自分の編集を維持できます。";
      changes.append(empty);
    }
    box.append(changes);

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
      close();
      resolve(choice);
    };
    cancel.addEventListener("click", () => finish(null));
    reload.addEventListener("click", () => finish("reload"));
    keep.addEventListener("click", () => finish("keep"));
    merge.addEventListener("click", () => finish("merge"));
    merge.focus();
  });
}
