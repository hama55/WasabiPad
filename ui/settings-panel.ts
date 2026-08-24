import type { WorkspaceSearchOptions } from "./api";
import { formatFontFamily } from "./format";
import { FONT_FAMILIES, INDENT_SIZES, isValidFontSize, MAX_FONT_SIZE, MIN_FONT_SIZE } from "./font-controls";
import { openModal } from "./modal";
import { commandValueKind } from "./registered-command-model";
import { registeredStringLabel } from "./registered-strings";
import type { Settings } from "./settings";
import { createSearchSettingsEditor } from "./search-settings-dialog";
import { THEME_LABELS, THEMES, type Theme } from "./theme";

export interface SettingsPanelPorts {
  getTheme: () => Theme;
  setTheme: (theme: Theme) => void;
  getSetting: <K extends keyof Settings>(key: K) => Settings[K];
  setSetting: <K extends keyof Settings>(key: K, value: Settings[K]) => void;
  applyFontFamily: (family: string) => void;
  applyFontSize: (size: number) => void;
  applyIndent: (size: number) => void;
  applyPreviewFontSize: (size: number) => void;
  getSearchOptions: () => WorkspaceSearchOptions;
  updateSearchOptions: (options: WorkspaceSearchOptions) => void;
  confirmReset: () => boolean | Promise<boolean>;
  resetSettings: () => void | Promise<void>;
}

export interface SettingsCloseHandle {
  close: () => void;
}

type CommonSettingKey = "theme" | "fontFamily" | "editorFontSize" | "indent" | "previewFontSize";

const SETTING_FIELD_BUILDERS: Record<CommonSettingKey, (ports: SettingsPanelPorts) => HTMLElement> = {
  theme: themeField,
  fontFamily: fontFamilyField,
  editorFontSize: editorFontSizeField,
  indent: indentField,
  previewFontSize: previewFontSizeField,
};
const QUICK_SETTING_KEYS = ["theme", "fontFamily", "editorFontSize", "indent", "previewFontSize"] as const;
const EDITOR_SETTING_KEYS = ["fontFamily", "editorFontSize", "indent"] as const;

export function openSettingsMenu(
  anchor: HTMLElement,
  ports: SettingsPanelPorts,
  onOpenAll: () => void,
  onClose?: () => void,
): SettingsCloseHandle {
  const popover = document.createElement("div");
  popover.className = "settings-popover";
  popover.setAttribute("role", "dialog");
  popover.setAttribute("aria-label", "クイック設定");

  popover.append(...buildCommonSettingFields(ports, QUICK_SETTING_KEYS));

  const all = document.createElement("button");
  all.type = "button";
  all.className = "settings-open-all";
  all.textContent = "すべての設定";
  all.addEventListener("click", onOpenAll);
  popover.append(all);

  let closed = false;
  const close = () => {
    if (closed) return;
    closed = true;
    popover.remove();
    document.removeEventListener("mousedown", onDocumentMouseDown, true);
    window.removeEventListener("keydown", onKeyDown, true);
    onClose?.();
  };
  const onDocumentMouseDown = (event: MouseEvent) => {
    const target = event.target as Node | null;
    if (target && !popover.contains(target) && !anchor.contains(target)) close();
  };
  const onKeyDown = (event: KeyboardEvent) => {
    if (event.key !== "Escape") return;
    event.preventDefault();
    close();
  };

  document.body.append(popover);
  const rect = anchor.getBoundingClientRect();
  popover.style.top = `${rect.bottom + 4}px`;
  popover.style.right = `${Math.max(8, window.innerWidth - rect.right)}px`;
  document.addEventListener("mousedown", onDocumentMouseDown, true);
  window.addEventListener("keydown", onKeyDown, true);
  return { close };
}

export function openSettingsModal(ports: SettingsPanelPorts): SettingsCloseHandle {
  let closed = false;
  const { box, close: closeModal } = openModal({ onCancel: () => close() }, "settings-box");
  box.setAttribute("role", "dialog");
  box.setAttribute("aria-label", "設定");

  const title = document.createElement("div");
  title.className = "pf-title";
  title.textContent = "設定";
  box.append(title);

  const content = document.createElement("div");
  content.className = "settings-content";
  box.append(content);

  const actions = document.createElement("div");
  actions.className = "pf-btns settings-actions";
  const reset = document.createElement("button");
  reset.type = "button";
  reset.className = "settings-reset";
  reset.textContent = "設定を初期化";
  const closeButton = document.createElement("button");
  closeButton.type = "button";
  closeButton.className = "pf-ok";
  closeButton.textContent = "閉じる";
  closeButton.addEventListener("click", close);
  actions.append(reset, closeButton);
  box.append(actions);

  const render = () => {
    content.replaceChildren(
      settingsSection("一般", [
        ...buildCommonSettingFields(ports, ["theme"]),
        startupPathField(ports),
      ]),
      settingsSection("エディタ", [
        ...buildCommonSettingFields(ports, EDITOR_SETTING_KEYS),
      ]),
      settingsSection("プレビュー", [
        ...buildCommonSettingFields(ports, ["previewFontSize"]),
      ]),
      settingsSection("検索", [createSearchSettingsEditor(ports.getSearchOptions(), ports.updateSearchOptions)]),
      settingsSection("登録", [
        registeredStringsField(ports),
        registeredCommandsField(ports),
      ]),
    );
  };

  reset.addEventListener("click", () => {
    void (async () => {
      if (!(await ports.confirmReset())) return;
      await ports.resetSettings();
      render();
    })();
  });
  render();
  closeButton.focus();
  return { close };

  function close() {
    if (closed) return;
    closed = true;
    closeModal();
  }
}

function settingsSection(name: string, children: HTMLElement[]): HTMLElement {
  const section = document.createElement("section");
  section.className = "settings-section";
  section.dataset.settingsSection = name;
  const heading = document.createElement("h2");
  heading.textContent = name;
  section.append(heading, ...children);
  return section;
}

function buildCommonSettingFields(
  ports: SettingsPanelPorts,
  keys: readonly CommonSettingKey[],
): HTMLElement[] {
  return keys.map((key) => SETTING_FIELD_BUILDERS[key](ports));
}

function startupPathField(ports: SettingsPanelPorts): HTMLElement {
  const row = document.createElement("label");
  row.className = "settings-field settings-startup-path";
  const label = document.createElement("span");
  label.textContent = "起動時に開くパス";
  const input = document.createElement("input");
  input.type = "text";
  input.dataset.setting = "startup-path";
  input.spellcheck = false;
  input.placeholder = "未設定";
  input.value = ports.getSetting("startupPath") ?? "";
  input.addEventListener("change", () => {
    ports.setSetting("startupPath", input.value.trim() || null);
  });
  row.append(label, input);
  return row;
}

function registeredStringsField(ports: SettingsPanelPorts): HTMLElement {
  return registeredListField(
    "登録文字列",
    () => ports.getSetting("registeredStrings"),
    (items) => ports.setSetting("registeredStrings", items),
    (text) => ({ text: registeredStringLabel(text), title: text }),
    "登録文字列を削除",
  );
}

function registeredCommandsField(ports: SettingsPanelPorts): HTMLElement {
  return registeredListField(
    "登録コマンド",
    () => ports.getSetting("registeredCommands"),
    (items) => ports.setSetting("registeredCommands", items),
    (command) => {
      const kind = commandValueKind(command);
      return {
        text: `${command.label} (${kind === "file" ? "ファイル" : "文字列"})`,
        title: [command.prefix, command.command].filter(Boolean).join(" "),
        rowClass: "settings-command-row",
      };
    },
    "登録コマンドを削除",
  );
}

function registeredListField<T>(
  titleText: string,
  getItems: () => readonly T[],
  setItems: (items: T[]) => void,
  display: (item: T) => { text: string; title: string; rowClass?: string },
  removeTitle: string,
): HTMLElement {
  const group = document.createElement("div");
  group.className = "settings-list-group";
  const title = document.createElement("h3");
  title.textContent = titleText;
  group.append(title);
  const items = getItems();
  if (!items.length) {
    group.append(emptySettingsNotice("登録なし"));
    return group;
  }
  items.forEach((item) => {
    const shown = display(item);
    const row = document.createElement("div");
    row.className = `settings-list-row${shown.rowClass ? ` ${shown.rowClass}` : ""}`;
    const value = document.createElement("span");
    value.textContent = shown.text;
    value.title = shown.title;
    const remove = document.createElement("button");
    remove.type = "button";
    remove.textContent = "削除";
    remove.title = removeTitle;
    remove.addEventListener("click", () => {
      setItems(getItems().filter((current) => current !== item));
      row.remove();
    });
    row.append(value, remove);
    group.append(row);
  });
  return group;
}

function emptySettingsNotice(text: string): HTMLElement {
  const notice = document.createElement("p");
  notice.className = "settings-empty";
  notice.textContent = text;
  return notice;
}

function themeField(ports: SettingsPanelPorts): HTMLElement {
  return selectField("テーマ", "theme", THEMES.map((theme) => ({ value: theme, label: THEME_LABELS[theme] })),
    ports.getTheme(), (value) => ports.setTheme(value as Theme));
}

function fontFamilyField(ports: SettingsPanelPorts): HTMLElement {
  return selectField("フォント", "font-family", fontOptions(ports.getSetting("fontFamily")),
    ports.getSetting("fontFamily"), (value) => {
      ports.setSetting("fontFamily", value);
      ports.applyFontFamily(value);
    });
}

function editorFontSizeField(ports: SettingsPanelPorts): HTMLElement {
  return numberField("文字サイズ", "font-size", ports.getSetting("fontSize"), (value) => {
    ports.setSetting("fontSize", value);
    ports.applyFontSize(value);
  });
}

function indentField(ports: SettingsPanelPorts): HTMLElement {
  return selectField("インデント幅", "indent-size", INDENT_SIZES.map((size) => ({ value: String(size), label: `${size}` })),
    String(ports.getSetting("indentSize")), (value) => {
      const size = Number(value);
      ports.setSetting("indentSize", size);
      ports.applyIndent(size);
    });
}

function previewFontSizeField(ports: SettingsPanelPorts): HTMLElement {
  return numberField("プレビュー文字サイズ", "preview-font-size", ports.getSetting("previewFontSize"), (value) => {
    ports.setSetting("previewFontSize", value);
    ports.applyPreviewFontSize(value);
  });
}

function fontOptions(current: string): { value: string; label: string }[] {
  const values = [...FONT_FAMILIES];
  if (!values.includes(current)) values.unshift(current);
  return values.map((value) => ({ value, label: formatFontFamily(value) }));
}

function selectField(
  labelText: string,
  setting: string,
  options: { value: string; label: string }[],
  current: string,
  onChange: (value: string) => void,
): HTMLElement {
  const row = document.createElement("label");
  row.className = "settings-field";
  const label = document.createElement("span");
  label.textContent = labelText;
  const select = document.createElement("select");
  select.dataset.setting = setting;
  for (const option of options) {
    const element = document.createElement("option");
    element.value = option.value;
    element.textContent = option.label;
    select.append(element);
  }
  select.value = current;
  select.addEventListener("change", () => onChange(select.value));
  row.append(label, select);
  return row;
}

function numberField(
  labelText: string,
  setting: string,
  initial: number,
  onChange: (value: number) => void,
): HTMLElement {
  let current = initial;
  const row = document.createElement("label");
  row.className = "settings-field";
  const label = document.createElement("span");
  label.textContent = labelText;
  const input = document.createElement("input");
  input.type = "number";
  input.dataset.setting = setting;
  input.min = String(MIN_FONT_SIZE);
  input.max = String(MAX_FONT_SIZE);
  input.step = "1";
  input.value = String(current);
  input.addEventListener("change", () => {
    const value = Number(input.value);
    if (!isValidFontSize(value)) {
      input.value = String(current);
      return;
    }
    current = value;
    onChange(value);
  });
  row.append(label, input);
  return row;
}
