import type { WorkspaceSearchOptions } from "./api";
import {
  clampSearchOptions,
  DEFAULT_SEARCH_OPTIONS,
  MB,
  OPTION_TEXTS,
  type BoolOptionKey,
  type ListOptionKey,
  type NumberOptionKey,
} from "./workspace-search-options";

// 検索条件はフォルダビューの幅に収まらないため、ウィンドウ中央のモーダルで編集する。
// 変更は即座に保存し、閉じたときにだけ検索し直す (1項目触るたびに全走査させない)。

export interface SearchSettingsPorts {
  onChange: (options: WorkspaceSearchOptions) => void;
  onClose: () => void;
}

type ToggleKey = BoolOptionKey;
type CountKey = NumberOptionKey;
type ListKey = ListOptionKey;

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

  const toggle = (key: ToggleKey) =>
    toggleField(OPTION_TEXTS[key], options[key], (on) => {
      options[key] = on;
      commit();
    });

  const count = (label: string, key: CountKey) =>
    numberField(label, () => options[key], (value) => {
      options[key] = value;
      commit();
    });

  const list = (key: ListKey, placeholder: string) =>
    stringListField(() => options[key], (next) => {
      options[key] = next;
      commit();
    }, placeholder);

  left.append(
    section("検索する対象", [toggle("search_file_names"), toggle("search_contents")]),
    section("一致のしかた", [toggle("match_case"), toggle("whole_word"), toggle("use_regex")]),
    section("打ち切り条件", [
      hint("0 は無制限。上限を入れた場合だけ、途中で打ち切ったことを結果に表示する。"),
      numberField("最大ファイルサイズ (MB)", () => options.max_file_bytes / MB,
        (value) => {
          options.max_file_bytes = value * MB;
          commit();
        }),
      count("最大ファイル数", "max_files"),
      count("最大結果数", "max_results"),
      count("並列数 (0 = 自動)", "workers"),
    ])
  );

  right.append(
    section("除外するファイル", [
      toggle("exclude_binary"),
      toggle("respect_gitignore"),
      hint("glob で除外する (*.log や **/tmp/** のように書ける)。"),
      list("exclude_globs", "パターンを追加 (例: *.log)"),
    ]),
    section("除外するフォルダ", [
      hint("この名前のフォルダは中身ごと検索しない (大文字小文字は区別しない)。"),
      list("exclude_dirs", "フォルダ名を追加"),
    ])
  );

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

  const teardown = () => {
    overlay.remove();
    window.removeEventListener("keydown", onKey, true);
  };
  const finish = () => {
    teardown();
    ports.onClose();
  };
  const onKey = (e: KeyboardEvent) => {
    if (e.key !== "Escape") return;
    e.preventDefault();
    finish();
  };
  // 既定に戻したら入力欄を作り直す (閉じた扱いにはしないので onClose は呼ばない)
  reset.addEventListener("click", () => {
    options = { ...DEFAULT_SEARCH_OPTIONS };
    commit();
    teardown();
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
  texts: { label: string; hint: string },
  checked: boolean,
  onChange: (on: boolean) => void
): HTMLElement {
  const field = document.createElement("label");
  field.className = "ss-toggle";
  const input = document.createElement("input");
  input.type = "checkbox";
  input.checked = checked;
  input.addEventListener("change", () => onChange(input.checked));
  field.append(input, labelText(texts.label, texts.hint));
  return field;
}

// ラベル + 補足。補足は同じ行の小さい文字として続ける
function labelText(label: string, note: string): HTMLElement {
  const text = document.createElement("span");
  text.textContent = label;
  if (note) {
    const small = document.createElement("small");
    small.textContent = note;
    text.append(small);
  }
  return text;
}

function numberField(label: string, get: () => number, set: (value: number) => void): HTMLElement {
  const field = document.createElement("label");
  field.className = "ss-number";
  const input = document.createElement("input");
  input.type = "number";
  input.min = "0";
  input.value = String(get());
  // 丸めと範囲は clampSearchOptions が単独で決める。ここは素の値を渡し、
  // 丸められた結果を読み直して出す (同じ規則を2箇所に置かない)
  input.addEventListener("change", () => {
    set(Number(input.value) || 0);
    input.value = String(get());
  });
  field.append(labelText(label, ""), input);
  return field;
}

// 除外指定は自由編集のリスト。1行1件で、× で外し、下の欄で足す。
function stringListField(
  get: () => string[],
  set: (list: string[]) => void,
  placeholder: string
): HTMLElement {
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
      empty.textContent = "除外なし";
      list.append(empty);
    }
  };

  const adder = document.createElement("div");
  adder.className = "ss-dir-add";
  const input = document.createElement("input");
  input.placeholder = placeholder;
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
  return element;
}
