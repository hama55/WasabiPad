import type { WorkspaceSearchOptions } from "./api";
import { clampSearchOptions, DEFAULT_SEARCH_OPTIONS } from "./workspace-search-options";

// 検索条件はフォルダビューの幅に収まらないため、ウィンドウ中央のモーダルで編集する。
// 変更は即座に保存し、閉じたときにだけ検索し直す (1項目触るたびに全走査させない)。

export interface SearchSettingsPorts {
  onChange: (options: WorkspaceSearchOptions) => void;
  onClose: () => void;
}

type ToggleKey = "match_case" | "search_file_names" | "search_contents" | "exclude_binary";
type CountKey = "max_files" | "max_results" | "workers";

export function openSearchSettings(
  current: WorkspaceSearchOptions,
  ports: SearchSettingsPorts
): void {
  let options = { ...current };
  const commit = () => {
    options = clampSearchOptions(options);
    ports.onChange(options);
  };

  const overlay = document.createElement("div");
  overlay.className = "pf-overlay";
  const box = document.createElement("div");
  box.className = "pf-box ss-box";

  const title = document.createElement("div");
  title.className = "pf-title";
  title.textContent = "検索の設定";

  const columns = document.createElement("div");
  columns.className = "ss-columns";
  const left = document.createElement("div");
  const right = document.createElement("div");
  columns.append(left, right);

  const toggle = (label: string, key: ToggleKey, hint = "") =>
    toggleField(label, hint, options[key], (on) => {
      options[key] = on;
      commit();
    });

  const count = (label: string, key: CountKey) =>
    numberField(label, "", () => options[key], (value) => {
      options[key] = value;
      commit();
    });

  left.append(
    section("検索する対象", [
      toggle("大文字小文字を区別する", "match_case"),
      toggle("ファイル名", "search_file_names"),
      toggle("本文", "search_contents"),
    ]),
    section("除外するファイル", [
      toggle("バイナリファイル", "exclude_binary", ".pyc / .exe / 画像など (先頭にNULを含むもの)"),
    ]),
    section("打ち切り条件", [
      hint("0 は無制限。上限を入れた場合だけ、途中で打ち切ったことを結果に表示する。"),
      numberField("最大ファイルサイズ (MB)", "", () => options.max_file_bytes / (1024 * 1024),
        (value) => {
          options.max_file_bytes = value * 1024 * 1024;
          commit();
        }),
      count("最大ファイル数", "max_files"),
      count("最大結果数", "max_results"),
      count("並列数 (0 = 自動)", "workers"),
    ])
  );

  const dirs = excludeDirsField(
    () => options.exclude_dirs,
    (list) => {
      options.exclude_dirs = list;
      commit();
    }
  );
  right.append(section("除外するフォルダ", [
    hint("この名前のフォルダは中身ごと検索しない (大文字小文字は区別しない)。"),
    dirs.element,
  ]));

  const buttons = document.createElement("div");
  buttons.className = "pf-btns";
  const reset = document.createElement("button");
  reset.textContent = "既定に戻す";
  const close = document.createElement("button");
  close.className = "pf-ok";
  close.textContent = "閉じる";
  buttons.append(reset, close);

  box.append(title, columns, buttons);
  overlay.append(box);
  document.body.append(overlay);

  const finish = () => {
    overlay.remove();
    window.removeEventListener("keydown", onKey, true);
    ports.onClose();
  };
  const onKey = (e: KeyboardEvent) => {
    if (e.key !== "Escape") return;
    e.preventDefault();
    finish();
  };
  reset.addEventListener("click", () => {
    options = { ...DEFAULT_SEARCH_OPTIONS };
    commit();
    overlay.remove();
    window.removeEventListener("keydown", onKey, true);
    openSearchSettings(options, ports);
  });
  close.addEventListener("click", finish);
  overlay.addEventListener("mousedown", (e) => {
    if (e.target === overlay) finish();
  });
  window.addEventListener("keydown", onKey, true);
  close.focus();
}

function section(heading: string, fields: HTMLElement[]): HTMLElement {
  const element = document.createElement("div");
  element.className = "ss-section";
  const title = document.createElement("div");
  title.className = "ss-section-title";
  title.textContent = heading;
  element.append(title, ...fields);
  return element;
}

function hint(text: string): HTMLElement {
  const element = document.createElement("p");
  element.className = "ss-hint";
  element.textContent = text;
  return element;
}

function toggleField(
  label: string,
  note: string,
  checked: boolean,
  onChange: (on: boolean) => void
): HTMLElement {
  const field = document.createElement("label");
  field.className = "ss-toggle";
  const input = document.createElement("input");
  input.type = "checkbox";
  input.checked = checked;
  input.addEventListener("change", () => onChange(input.checked));
  const text = document.createElement("span");
  text.textContent = label;
  if (note) {
    const small = document.createElement("small");
    small.textContent = note;
    text.append(small);
  }
  field.append(input, text);
  return field;
}

function numberField(
  label: string,
  note: string,
  get: () => number,
  set: (value: number) => void
): HTMLElement {
  const field = document.createElement("label");
  field.className = "ss-number";
  const text = document.createElement("span");
  text.textContent = label;
  if (note) {
    const small = document.createElement("small");
    small.textContent = note;
    text.append(small);
  }
  const input = document.createElement("input");
  input.type = "number";
  input.min = "0";
  input.value = String(get());
  input.addEventListener("change", () => {
    set(Math.max(0, Math.round(Number(input.value) || 0)));
    input.value = String(get());
  });
  field.append(text, input);
  return field;
}

// 除外フォルダは自由編集のリスト。1行1フォルダ名で、× で外し、下の欄で足す。
function excludeDirsField(
  get: () => string[],
  set: (list: string[]) => void
): { element: HTMLElement } {
  const element = document.createElement("div");
  element.className = "ss-dirs";
  const list = document.createElement("div");
  list.className = "ss-dir-list";

  const redraw = () => {
    list.replaceChildren();
    for (const name of get()) {
      const row = document.createElement("div");
      row.className = "ss-dir-row";
      const text = document.createElement("span");
      text.textContent = name;
      const remove = document.createElement("button");
      remove.type = "button";
      remove.textContent = "×";
      remove.title = `${name} を除外リストから外す`;
      remove.addEventListener("click", () => {
        set(get().filter((dir) => dir !== name));
        redraw();
      });
      row.append(text, remove);
      list.append(row);
    }
    if (!get().length) {
      const empty = document.createElement("div");
      empty.className = "ss-dir-empty";
      empty.textContent = "除外なし (すべてのフォルダを検索する)";
      list.append(empty);
    }
  };

  const adder = document.createElement("div");
  adder.className = "ss-dir-add";
  const input = document.createElement("input");
  input.placeholder = "フォルダ名を追加";
  input.spellcheck = false;
  const add = document.createElement("button");
  add.type = "button";
  add.textContent = "追加";
  const submit = () => {
    const name = input.value.trim();
    if (!name) return;
    set([...get(), name]);
    input.value = "";
    redraw();
  };
  add.addEventListener("click", submit);
  input.addEventListener("keydown", (e) => {
    if (e.key !== "Enter") return;
    e.preventDefault();
    submit();
  });
  adder.append(input, add);

  redraw();
  element.append(list, adder);
  return { element };
}
