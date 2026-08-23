// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Settings } from "./settings";
import { openSettingsMenu, openSettingsModal, type SettingsPanelPorts } from "./settings-panel";
import { DEFAULT_SEARCH_OPTIONS } from "./workspace-search-options";

function makePorts(initial: Partial<Settings> = {}): SettingsPanelPorts {
  const values: Settings = {
    indentSize: 8,
    fontFamily: 'Consolas, "MS Gothic", monospace',
    fontSize: 14,
    previewFontSize: 14,
    startupPath: null,
    registeredStrings: [],
    registeredCommands: [],
    workspaceSearchOptions: null,
    openTabs: { tabs: [], activeId: null },
    ...initial,
  };
  let searchOptions = { ...DEFAULT_SEARCH_OPTIONS };
  const setSetting = vi.fn(<K extends keyof Settings>(key: K, value: Settings[K]) => {
    values[key] = value;
  });
  return {
    getTheme: () => "dark",
    setTheme: vi.fn(),
    getSetting: <K extends keyof Settings>(key: K) => values[key],
    setSetting,
    applyFontFamily: vi.fn(),
    applyFontSize: vi.fn(),
    applyIndent: vi.fn(),
    applyPreviewFontSize: vi.fn(),
    getSearchOptions: () => searchOptions,
    updateSearchOptions: vi.fn((next) => {
      searchOptions = next;
    }),
    confirmReset: vi.fn(async () => true),
    resetSettings: vi.fn(),
  };
}

describe("Feature: settings quick menu", () => {
  afterEach(() => document.body.replaceChildren());

  // Given: 設定ギアを表示できるanchorと現在の設定
  // When: クイック設定を開く
  // Then: テーマ・フォント・文字サイズ・インデント・プレビュー文字サイズと詳細入口を表示する
  it("Scenario: 頻繁な設定と詳細設定の入口を表示する", () => {
    const anchor = document.createElement("button");
    document.body.append(anchor);
    const ports = makePorts();
    const onOpenAll = vi.fn();
    const onClose = vi.fn();

    const menu = openSettingsMenu(anchor, ports, onOpenAll, onClose);

    expect(document.querySelector(".settings-popover")).not.toBeNull();
    for (const key of ["theme", "font-family", "font-size", "indent-size", "preview-font-size"]) {
      expect(document.querySelector(`[data-setting="${key}"]`)).not.toBeNull();
    }
    document.querySelector<HTMLButtonElement>(".settings-open-all")!.click();
    expect(onOpenAll).toHaveBeenCalledOnce();

    menu.close();
  });

  // Given: クイック設定を開いている
  // When: テーマとインデント幅を変更する
  // Then: 変更内容をportへ即時通知する
  it("Scenario: クイック設定の変更を即時反映する", () => {
    const anchor = document.createElement("button");
    document.body.append(anchor);
    const ports = makePorts();
    const menu = openSettingsMenu(anchor, ports, vi.fn());

    const theme = document.querySelector<HTMLSelectElement>('[data-setting="theme"]')!;
    theme.value = "light";
    theme.dispatchEvent(new Event("change", { bubbles: true }));
    const indent = document.querySelector<HTMLSelectElement>('[data-setting="indent-size"]')!;
    indent.value = "4";
    indent.dispatchEvent(new Event("change", { bubbles: true }));

    expect(ports.setTheme).toHaveBeenCalledWith("light");
    expect(ports.setSetting).toHaveBeenCalledWith("indentSize", 4);
    expect(ports.applyIndent).toHaveBeenCalledWith(4);

    menu.close();
  });

  // Given: クイック設定を開いている
  // When: 外側をクリックする
  // Then: クイック設定を閉じる
  it("Scenario: 外側クリックでクイック設定を閉じる", () => {
    const anchor = document.createElement("button");
    const outside = document.createElement("div");
    document.body.append(anchor, outside);
    openSettingsMenu(anchor, makePorts(), vi.fn());

    outside.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));

    expect(document.querySelector(".settings-popover")).toBeNull();
  });

  // Given: クイック設定を開いている
  // When: Escapeで閉じる
  // Then: 親へcloseを通知して、次のギア操作で再表示できる状態にする
  it("Scenario: クイック設定を閉じたことを通知する", () => {
    const anchor = document.createElement("button");
    document.body.append(anchor);
    const onClose = vi.fn();
    openSettingsMenu(anchor, makePorts(), vi.fn(), onClose);

    window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));

    expect(onClose).toHaveBeenCalledOnce();
  });
});

describe("Feature: settings modal", () => {
  afterEach(() => document.body.replaceChildren());

  // Given: 現在のアプリ設定
  // When: 詳細設定を開く
  // Then: カテゴリと既存設定の管理項目を表示する
  it("Scenario: 設定をカテゴリ別に管理する", () => {
    const ports = makePorts();

    openSettingsModal(ports);

    expect(document.querySelector(".settings-box")).not.toBeNull();
    expect(document.querySelector("[data-settings-section=一般]")).not.toBeNull();
    expect(document.querySelector("[data-settings-section=エディタ]")).not.toBeNull();
    expect(document.querySelector("[data-settings-section=プレビュー]")).not.toBeNull();
    expect(document.querySelector("[data-settings-section=検索]")).not.toBeNull();
    expect(document.querySelector("[data-settings-section=登録]")).not.toBeNull();
    expect(document.querySelector('[data-setting="startup-path"]')).not.toBeNull();
    expect(document.querySelector(".settings-reset")).not.toBeNull();
  });

  // Given: 詳細設定を開いている
  // When: 検索条件のチェックを変更する
  // Then: 同じ設定モーダルから現在値を更新し、モーダルは閉じない
  it("Scenario: 検索条件を詳細設定内で編集する", () => {
    const ports = makePorts();
    openSettingsModal(ports);

    const searchSection = document.querySelector<HTMLElement>("[data-settings-section=検索]")!;
    const toggle = searchSection.querySelector<HTMLInputElement>(".ss-toggle input")!;
    toggle.click();

    expect(ports.updateSearchOptions).toHaveBeenCalledWith(expect.objectContaining({ search_file_names: false }));
    expect(document.querySelector(".settings-box")).not.toBeNull();
  });

  // Given: 詳細設定のエディタ文字サイズを20へ変更している
  // When: 同じ入力欄へ不正な値を入力する
  // Then: 直近の保存値20へ戻す
  it("Scenario: 不正な文字サイズ入力は直近の値へ戻す", () => {
    const ports = makePorts();
    openSettingsModal(ports);
    const input = document.querySelector<HTMLInputElement>('[data-setting="font-size"]')!;

    input.value = "20";
    input.dispatchEvent(new Event("change", { bubbles: true }));
    input.value = "invalid";
    input.dispatchEvent(new Event("change", { bubbles: true }));

    expect(input.value).toBe("20");
    expect(ports.setSetting).toHaveBeenCalledWith("fontSize", 20);
  });

  // Given: 詳細設定を開いている
  // When: 初期化を承認する
  // Then: アプリ設定の初期化処理を呼び出す
  it("Scenario: 初期化の確認後にアプリ設定だけを戻す", async () => {
    const ports = makePorts();
    openSettingsModal(ports);

    document.querySelector<HTMLButtonElement>(".settings-reset")!.click();
    await vi.waitFor(() => expect(ports.resetSettings).toHaveBeenCalledOnce());

    expect(ports.confirmReset).toHaveBeenCalledOnce();
  });

  // Given: 登録文字列と登録コマンドが詳細設定に表示されている
  // When: 登録一覧から項目を削除する
  // Then: 対象項目だけを設定ストアから削除する
  it("Scenario: 登録項目を設定モーダルから削除する", () => {
    const ports = makePorts({
      registeredStrings: ["one", "two"],
      registeredCommands: [{ extension: ".md", label: "Editor", prefix: "", command: "code {file}" }],
    });
    openSettingsModal(ports);

    const groups = [...document.querySelectorAll<HTMLElement>(".settings-list-group")];
    groups[0].querySelector<HTMLButtonElement>(".settings-list-row button")!.click();
    groups[0].querySelector<HTMLButtonElement>(".settings-list-row button")!.click();
    groups[1].querySelector<HTMLButtonElement>(".settings-list-row button")!.click();

    expect(ports.setSetting).toHaveBeenCalledWith("registeredStrings", ["two"]);
    expect(ports.setSetting).toHaveBeenCalledWith("registeredStrings", []);
    expect(ports.setSetting).toHaveBeenCalledWith("registeredCommands", []);
  });
});
