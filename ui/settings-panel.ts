import type { WorkspaceSearchOptions } from "./api";
import packageInfo from "../package.json";
import { releaseTag } from "../version-policy.mjs";
import { APP_NAME } from "./app-config";
import { formatByteSize, formatFontFamily } from "./format";
import { FONT_FAMILIES, INDENT_SIZES, isValidFontSize, MAX_FONT_SIZE, MIN_FONT_SIZE } from "./font-controls";
import { openModal } from "./modal";
import { commandValueKind } from "./registered-command-model";
import { updateRegisteredCommands } from "./registered-commands";
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
  applyMarkdownSoftBreaks: (enabled: boolean) => void;
  pickPreviewCacheDirectory?: () => string | null | Promise<string | null>;
  clearPreviewCache?: () => void | Promise<void>;
  getPreviewCacheInfo?: () => PreviewCacheInfo | null | Promise<PreviewCacheInfo | null>;
  getSearchOptions: () => WorkspaceSearchOptions;
  updateSearchOptions: (options: WorkspaceSearchOptions) => void;
  confirmReset: () => boolean | Promise<boolean>;
  resetSettings: () => void | Promise<void>;
}

export interface PreviewCacheInfo {
  directory: string;
  bytes: number;
}

export interface SettingsCloseHandle {
  close: () => void;
}

type CommonSettingKey =
  | "theme"
  | "fontFamily"
  | "editorFontSize"
  | "indent"
  | "previewFontSize"
  | "markdownSoftBreaks";

const SETTING_FIELD_BUILDERS: Record<CommonSettingKey, (ports: SettingsPanelPorts) => HTMLElement> = {
  theme: themeField,
  fontFamily: fontFamilyField,
  editorFontSize: editorFontSizeField,
  indent: indentField,
  previewFontSize: previewFontSizeField,
  markdownSoftBreaks: markdownSoftBreaksField,
};
const QUICK_SETTING_KEYS = ["theme", "fontFamily", "editorFontSize", "indent", "previewFontSize"] as const;
const EDITOR_SETTING_KEYS = ["fontFamily", "editorFontSize", "indent"] as const;
// package.jsonのversionはsync-versionによりCargo.tomlのworkspace versionから同期される。
// Aboutの表示値はversion-policy.jsonを読む共有releaseTagで生成する。
const APP_VERSION = releaseTag(packageInfo.version);

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

  const layout = document.createElement("div");
  layout.className = "settings-layout";

  const tabList = document.createElement("nav");
  tabList.className = "settings-tabs";
  tabList.setAttribute("role", "tablist");
  tabList.setAttribute("aria-orientation", "vertical");
  tabList.setAttribute("aria-label", "設定カテゴリ");

  const content = document.createElement("div");
  content.className = "settings-content";
  content.tabIndex = 0;
  content.setAttribute("aria-label", "設定内容");

  layout.append(tabList, content);
  box.append(title, layout);

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

  const sectionSpecs = [
    {
      name: "一般",
      id: "settings-general",
      build: () => [
        ...buildCommonSettingFields(ports, ["theme"]),
        startupPathField(ports),
      ],
    },
    {
      name: "エディタ",
      id: "settings-editor",
      build: () => [
        ...buildCommonSettingFields(ports, EDITOR_SETTING_KEYS),
      ],
    },
    {
      name: "プレビュー",
      id: "settings-preview",
      build: () => [
        ...buildCommonSettingFields(ports, ["previewFontSize", "markdownSoftBreaks"]),
        previewCacheField(ports),
      ],
    },
    {
      name: "検索",
      id: "settings-search",
      build: () => [createSearchSettingsEditor(ports.getSearchOptions(), ports.updateSearchOptions)],
    },
    {
      name: "登録",
      id: "settings-registered",
      build: () => [
        registeredStringsField(ports),
        registeredCommandsField(ports),
      ],
    },
    {
      name: "About",
      id: "settings-about",
      build: () => [aboutField()],
    },
  ] as const;

  const tabs = new Map<string, HTMLButtonElement>();
  let renderedSections: HTMLElement[] = [];
  let activeSectionId: string = sectionSpecs[0].id;

  const setActiveSection = (sectionId: string) => {
    activeSectionId = sectionId;
    for (const [id, tab] of tabs) tab.setAttribute("aria-selected", String(id === sectionId));
    content.setAttribute("aria-activedescendant", sectionId);
  };

  const updateActiveTabFromScroll = () => {
    if (!renderedSections.length) return;
    const containerTop = content.getBoundingClientRect().top;
    const activationLine = containerTop + 24;
    let active = renderedSections[0];
    for (const section of renderedSections) {
      if (section.getBoundingClientRect().top > activationLine) break;
      active = section;
    }
    setActiveSection(active.id);
  };

  for (const spec of sectionSpecs) {
    const tab = document.createElement("button");
    tab.type = "button";
    tab.className = "settings-tab";
    tab.dataset.settingsTab = spec.name;
    tab.setAttribute("role", "tab");
    tab.setAttribute("aria-controls", spec.id);
    tab.setAttribute("aria-selected", "false");
    tab.textContent = spec.name;
    tab.addEventListener("click", () => {
      const section = renderedSections.find((current) => current.id === spec.id);
      if (!section) return;
      setActiveSection(spec.id);
      section.scrollIntoView({ behavior: "smooth", block: "start" });
    });
    tabs.set(spec.id, tab);
    tabList.append(tab);
  }

  content.addEventListener("scroll", updateActiveTabFromScroll);

  const render = () => {
    renderedSections = sectionSpecs.map(({ name, id, build }) => settingsSection(name, id, build()));
    content.replaceChildren(...renderedSections);
    const activeExists = renderedSections.some((section) => section.id === activeSectionId);
    setActiveSection(activeExists ? activeSectionId : sectionSpecs[0].id);
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

function settingsSection(name: string, id: string, children: HTMLElement[]): HTMLElement {
  const section = document.createElement("section");
  section.className = "settings-section";
  section.dataset.settingsSection = name;
  const headingId = `${id}-heading`;
  section.id = id;
  section.setAttribute("role", "region");
  section.setAttribute("aria-labelledby", headingId);
  const heading = document.createElement("h2");
  heading.id = headingId;
  heading.textContent = name;
  section.append(heading, ...children);
  return section;
}

function aboutField(): HTMLElement {
  const details = document.createElement("dl");
  details.className = "settings-about";

  const appNameLabel = document.createElement("dt");
  appNameLabel.textContent = "アプリ名";
  const appNameValue = document.createElement("dd");
  appNameValue.dataset.aboutValue = "app-name";
  appNameValue.textContent = APP_NAME;

  const versionLabel = document.createElement("dt");
  versionLabel.textContent = "バージョン";
  const versionValue = document.createElement("dd");
  versionValue.dataset.aboutValue = "version";
  versionValue.textContent = APP_VERSION;

  details.append(appNameLabel, appNameValue, versionLabel, versionValue);
  return details;
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
  const group = registeredListField(
    "登録文字列",
    () => ports.getSetting("registeredStrings"),
    (items) => ports.setSetting("registeredStrings", items),
    (text) => ({ text: registeredStringLabel(text), title: text }),
    "登録文字列を削除",
  );
  group.dataset.settingGroup = "registered-strings";
  return group;
}

function registeredCommandsField(ports: SettingsPanelPorts): HTMLElement {
  const group = document.createElement("div");
  group.className = "settings-list-group";
  group.dataset.settingGroup = "registered-commands";
  const title = document.createElement("h3");
  title.textContent = "登録コマンド";
  let draggingIndex: number | null = null;

  const reorder = (from: number, to: number) => {
    const commands = ports.getSetting("registeredCommands");
    const kind = commands[from] && commandValueKind(commands[from]);
    if (!kind || !commands[to] || commandValueKind(commands[to]) !== kind || from === to) return;
    const kindIndexes = commands.flatMap((command, index) => commandValueKind(command) === kind ? [index] : []);
    const fromKindIndex = kindIndexes.indexOf(from);
    const toKindIndex = kindIndexes.indexOf(to);
    if (fromKindIndex < 0 || toKindIndex < 0) return;
    const ordered = kindIndexes.map((index) => commands[index]);
    const [moved] = ordered.splice(fromKindIndex, 1);
    ordered.splice(toKindIndex, 0, moved);
    const next = [...commands];
    kindIndexes.forEach((index, position) => { next[index] = ordered[position]; });
    ports.setSetting("registeredCommands", next);
    render();
  };

  const update = (index: number, key: "label" | "prefix" | "command", value: string) => {
    const commands = ports.getSetting("registeredCommands");
    const command = commands[index];
    if (!command) return;
    const changes = { label: command.label, prefix: command.prefix, command: command.command };
    changes[key] = value;
    const next = updateRegisteredCommands(commands, command, changes);
    if (next) ports.setSetting("registeredCommands", next);
  };

  const render = () => {
    group.replaceChildren(title);
    const commands = ports.getSetting("registeredCommands");
    if (!commands.length) {
      group.append(emptySettingsNotice("登録なし。エディタやファイルツリーの右クリックから登録できる。"));
      return;
    }
    for (const kind of ["file", "string"] as const) {
      const kindIndexes = commands.flatMap((command, index) => commandValueKind(command) === kind ? [index] : []);
      if (!kindIndexes.length) continue;
      const kindGroup = document.createElement("div");
      kindGroup.className = "settings-command-kind-group";
      const kindTitle = document.createElement("h4");
      kindTitle.textContent = kind === "file" ? "ファイル用" : "文字列用";
      kindGroup.append(kindTitle);
      for (const index of kindIndexes) {
        const command = commands[index];
        const row = document.createElement("div");
        row.className = "settings-list-row settings-command-row";
        row.dataset.commandIndex = String(index);
        row.draggable = true;
        row.addEventListener("dragstart", () => { draggingIndex = index; });
        row.addEventListener("dragend", () => { draggingIndex = null; });
        row.addEventListener("dragover", (event) => {
          if (draggingIndex === null || draggingIndex === index
            || commandValueKind(commands[draggingIndex]) !== kind) return;
          event.preventDefault();
        });
        row.addEventListener("drop", (event) => {
          event.preventDefault();
          const source = draggingIndex;
          draggingIndex = null;
          if (source !== null) reorder(source, index);
        });

        for (const [key, labelText] of [
          ["label", "表示名"],
          ["prefix", "前置き"],
          ["command", "コマンド"],
        ] as const) {
          const field = document.createElement("label");
          field.className = "settings-command-field";
          const label = document.createElement("span");
          label.textContent = labelText;
          const input = key === "command"
            ? document.createElement("textarea")
            : document.createElement("input");
          if (input instanceof HTMLInputElement) input.type = "text";
          if (input instanceof HTMLTextAreaElement) input.rows = 2;
          input.dataset.setting = `registered-command-${index}-${key}`;
          input.setAttribute("aria-label", `${command.label}の${labelText}`);
          input.value = command[key];
          input.spellcheck = false;
          input.addEventListener("change", () => update(index, key, input.value));
          field.append(label, input);
          row.append(field);
        }

        const actions = document.createElement("div");
        actions.className = "settings-command-actions";
        const position = kindIndexes.indexOf(index);
        for (const [direction, text, titleText] of [
          ["up", "↑", "上へ移動"],
          ["down", "↓", "下へ移動"],
        ] as const) {
          const move = document.createElement("button");
          move.type = "button";
          move.textContent = text;
          move.title = titleText;
          move.dataset.action = `move-registered-command-${direction}`;
          move.dataset.commandIndex = String(index);
          const target = kindIndexes[position + (direction === "up" ? -1 : 1)];
          move.disabled = target === undefined;
          move.addEventListener("click", () => {
            if (target !== undefined) reorder(index, target);
          });
          actions.append(move);
        }
        const remove = document.createElement("button");
        remove.type = "button";
        remove.textContent = "削除";
        remove.title = "登録コマンドを削除";
        remove.addEventListener("click", () => {
          ports.setSetting("registeredCommands", ports.getSetting("registeredCommands").filter((_, current) => current !== index));
          render();
        });
        actions.append(remove);
        row.append(actions);
        kindGroup.append(row);
      }
      group.append(kindGroup);
    }
  };
  render();
  return group;
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

function markdownSoftBreaksField(ports: SettingsPanelPorts): HTMLElement {
  const row = document.createElement("label");
  row.className = "settings-field settings-checkbox";
  const input = document.createElement("input");
  input.type = "checkbox";
  input.dataset.setting = "markdown-soft-breaks";
  input.checked = ports.getSetting("markdownSoftBreaks");
  input.addEventListener("change", () => {
    ports.setSetting("markdownSoftBreaks", input.checked);
    ports.applyMarkdownSoftBreaks(input.checked);
  });
  const label = document.createElement("span");
  label.textContent = "Markdownの通常改行を表示";
  row.append(input, label);
  return row;
}

function previewCacheField(ports: SettingsPanelPorts): HTMLElement {
  const group = document.createElement("div");
  group.className = "settings-field settings-preview-cache";

  const title = document.createElement("span");
  title.textContent = "プレビューキャッシュ保存場所";

  const locationRow = document.createElement("div");
  locationRow.className = "settings-list-row";
  const location = document.createElement("span");
  location.dataset.setting = "preview-cache-directory";
  let currentDirectory = ports.getSetting("previewCacheDirectory");
  location.textContent = currentDirectory ?? "バックエンド既定場所を確認中…";
  location.title = location.textContent;
  locationRow.append(location);

  const size = document.createElement("span");
  size.dataset.setting = "preview-cache-size";
  size.textContent = "使用量: 確認中…";
  locationRow.append(size);

  const refreshInfo = () => {
    const getInfo = ports.getPreviewCacheInfo;
    if (!getInfo) {
      if (currentDirectory === null) location.textContent = "バックエンド既定場所";
      size.textContent = "使用量: 確認できません";
      location.title = location.textContent;
      return;
    }
    void Promise.resolve(getInfo()).then((info) => {
      if (!info) {
        size.textContent = "使用量: 確認できません";
        return;
      }
      if (currentDirectory === null) location.textContent = info.directory;
      location.title = info.directory;
      size.textContent = `使用量: ${formatByteSize(info.bytes)}`;
    }).catch(() => {
      size.textContent = "使用量: 確認できません";
    });
  };
  refreshInfo();

  const actions = document.createElement("div");
  actions.className = "settings-list-row";

  const pick = document.createElement("button");
  pick.type = "button";
  pick.dataset.action = "pick-preview-cache-directory";
  pick.textContent = "保存場所を変更";
  pick.disabled = !ports.pickPreviewCacheDirectory;
  pick.addEventListener("click", () => {
    const pickDirectory = ports.pickPreviewCacheDirectory;
    if (!pickDirectory) return;
    void Promise.resolve(pickDirectory()).then((directory) => {
      if (typeof directory !== "string" || directory.trim().length === 0) return;
      currentDirectory = directory;
      ports.setSetting("previewCacheDirectory", directory);
      location.textContent = directory;
      location.title = directory;
      refreshInfo();
    });
  });

  const clear = document.createElement("button");
  clear.type = "button";
  clear.dataset.action = "clear-preview-cache";
  clear.textContent = "キャッシュを全削除";
  clear.disabled = !ports.clearPreviewCache;
  clear.addEventListener("click", () => {
    void Promise.resolve(ports.clearPreviewCache?.()).then(refreshInfo);
  });

  actions.append(pick, clear);
  group.append(title, locationRow, actions);
  return group;
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
