// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import packageInfo from "../package.json";
import { releaseTag } from "../version-policy.mjs";
import { APP_NAME } from "./app-config";
import type { Settings } from "./settings";
import {
  createSettingsOpener,
  openSettingsModal,
  returnToSettings,
  type SettingsModalState,
  type SettingsPanelPorts,
} from "./settings-panel";

function makePorts(initial: Partial<Settings> = {}): SettingsPanelPorts {
  const values: Settings = {
    indentSize: 8,
    sidebarWidth: 220,
    fontFamily: 'Consolas, "MS Gothic", monospace',
    fontSize: 14,
    previewFontSize: 14,
    markdownSoftBreaks: true,
    markdownLineHeight: 1.65,
    markdownHeadingUnderlines: false,
    sqlitePreviewRows: 100,
    previewCacheDirectory: null,
    lilypondExecutablePath: null,
    startupPath: null,
    registeredStrings: [],
    registeredCommands: [],
    externalPreviewAdapters: [],
    workspaceSearchOptions: null,
    openTabs: { tabs: [], activeId: null },
    ...initial,
  };
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
    applyMarkdownSoftBreaks: vi.fn(),
    applyMarkdownLineHeight: vi.fn(),
    applyMarkdownHeadingUnderlines: vi.fn(),
    getMusicAddonStatus: vi.fn(async (id: string) => ({
      id, version: null, installed: false, enabled: false,
    })),
    getMusicAddonCatalog: vi.fn(async () => []),
    installMusicAddon: vi.fn(async () => {}),
    setMusicAddonEnabled: vi.fn(async () => {}),
    removeMusicAddon: vi.fn(async () => {}),
    openSearchSettings: vi.fn(),
    openRegisteredString: vi.fn(),
    openRegisteredCommand: vi.fn(),
    openExternalPreviewAdapter: vi.fn(),
    confirmReset: vi.fn(async () => true),
    resetSettings: vi.fn(),
  };
}

describe("Feature: settings modal", () => {
  afterEach(() => document.body.replaceChildren());

  // Feature: 外部プレビューアダプタの設定画面
  // Scenario: 一覧から追加・削除の操作を各portへ委譲する
  // Given: 外部プレビューアダプタが1件登録されている
  // When: 設定画面で追加と削除を操作する
  // Then: 追加ダイアログと設定保存portへ通知される
  it("Scenario: 外部プレビューアダプタ一覧を編集する", () => {
    const adapter = {
      extensions: ["abc"],
      command: "renderer",
      args: "{file} {output}",
      outputFormat: "html" as const,
      preferExternal: false,
    };
    const ports = makePorts({ externalPreviewAdapters: [adapter] });
    openSettingsModal(ports);

    const group = document.querySelector<HTMLElement>('[data-setting-group="external-preview-adapters"]')!;
    expect(group.querySelector('[data-external-preview-row]')?.textContent).toContain(".abc → renderer");
    group.querySelector<HTMLButtonElement>('[data-action="add-external-preview-adapter"]')!.click();
    expect(ports.openExternalPreviewAdapter).toHaveBeenCalledOnce();

    group.querySelector<HTMLButtonElement>('[data-action="delete-external-preview-adapter"]')!.click();
    expect(ports.setSetting).toHaveBeenCalledWith("externalPreviewAdapters", []);
    expect(group.querySelector('[data-external-preview-row]')).toBeNull();
  });

  // Given: 設定モーダルを開く処理と閉じる処理を注入する
  // When: ギア相当の開閉処理を開く・閉じる・再表示の順に呼ぶ
  // Then: 同じモーダルを閉じ、閉じた後だけ新しいモーダルを開く
  it("Scenario: 設定ギアは全設定モーダルを開閉できる", () => {
    const close = vi.fn();
    const onClose: (() => void)[] = [];
    const open = vi.fn((closed: () => void) => {
      onClose.push(closed);
      return { close };
    });
    const toggle = createSettingsOpener(open);

    toggle();
    toggle();
    expect(open).toHaveBeenCalledOnce();
    expect(close).toHaveBeenCalledOnce();

    onClose[0]();
    toggle();
    expect(open).toHaveBeenCalledTimes(2);
  });

  // Feature: 公式音楽アドインの設定
  // Scenario: 公式カタログがオフラインでも固定アドインとローカル状態を表示する
  // Given: ABCは端末内で無効、LilyPondは未インストールで、公式カタログの取得は失敗する
  // When: 設定モーダルを開く
  // Then: 2つの公式アドインとローカル状態、カタログ接続エラーを別々に表示する
  it("Scenario: 公式カタログが使えなくてもローカルアドイン状態を表示する", async () => {
    const ports = makePorts();
    ports.getMusicAddonStatus = vi.fn(async (id: string) => id === "abc"
      ? { id, version: "1.2.3", installed: true, enabled: false }
      : { id, version: null, installed: false, enabled: false });
    ports.getMusicAddonCatalog = vi.fn(async () => { throw new Error("offline"); });

    expect(ports.getMusicAddonCatalog).not.toHaveBeenCalled();
    openSettingsModal(ports);

    const section = document.querySelector<HTMLElement>("#settings-addons")!;
    await vi.waitFor(() => expect(section.querySelector('[data-addon-local-status="abc"]')?.textContent)
      .toContain("無効"));
    expect(section.querySelector('[data-addon-local-status="abc"]')?.textContent).toContain("1.2.3");
    expect(section.querySelector('[data-addon-local-status="lilypond"]')?.textContent).toContain("未インストール");
    expect(section.querySelector('[data-addon-remote-status="lilypond"]')).not.toBeNull();
    expect(section.querySelector('[data-addon-catalog-status]')?.textContent).toContain("取得できません");
    expect(section.querySelector('[data-addon-catalog-status]')?.textContent).toContain("ネットワーク接続を確認");
    expect(section.querySelector('[data-addon-remote-status="lilypond"]')?.textContent).not.toContain("非互換");
    expect(ports.getMusicAddonStatus).toHaveBeenCalledWith("abc");
    expect(ports.getMusicAddonStatus).toHaveBeenCalledWith("lilypond");
    expect(ports.getMusicAddonCatalog).toHaveBeenCalledOnce();
    const addFromZip = section.querySelector<HTMLButtonElement>('[data-addon-id="lilypond"] [data-action="music-addon-add"]')!;
    expect(addFromZip.textContent).toBe("ZIPから追加");
    expect(addFromZip.disabled).toBe(false);
    addFromZip.click();
    await vi.waitFor(() => expect(ports.installMusicAddon).toHaveBeenCalledWith("lilypond"));
    document.querySelector<HTMLButtonElement>(".settings-reset")!.click();
    await vi.waitFor(() => expect(ports.resetSettings).toHaveBeenCalledOnce());
    expect(ports.getMusicAddonCatalog).toHaveBeenCalledOnce();
  });

  // Feature: 公式カタログの互換性表示
  // Scenario: 非互換カタログでもローカルZIP追加・更新を許可する
  // Given: ABCは互換、導入済みLilyPondは必要版が99.0.0で非互換
  // When: 設定モーダルを開き、ZIPから追加・更新とLilyPond有効切替・削除を行う
  // Then: 非互換理由を表示してもZIP操作は有効で、各操作をportへ送る
  it("Scenario: 非互換カタログでもZIPから追加と更新できる", async () => {
    const ports = makePorts();
    ports.getMusicAddonStatus = vi.fn(async (id: string) => id === "abc"
      ? { id, version: null, installed: false, enabled: false }
      : { id, version: "1.0.0", installed: true, enabled: true });
    ports.getMusicAddonCatalog = vi.fn(async () => [
      { id: "abc", version: "1.3.0", minimumAppVersion: "1.0.0", compatible: true, archiveUrl: "", sha256: "" },
      { id: "lilypond", version: "99.0.0", minimumAppVersion: "99.0.0", compatible: false, archiveUrl: "", sha256: "" },
    ]);
    openSettingsModal(ports);

    const section = document.querySelector<HTMLElement>("#settings-addons")!;
    const abc = section.querySelector<HTMLElement>('[data-addon-id="abc"]')!;
    const lilypond = section.querySelector<HTMLElement>('[data-addon-id="lilypond"]')!;
    await vi.waitFor(() => expect(section.querySelector('[data-addon-catalog-status]')?.textContent).toContain("取得しました"));

    const abcAdd = abc.querySelector<HTMLButtonElement>('[data-action="music-addon-add"]')!;
    const lilypondUpdate = lilypond.querySelector<HTMLButtonElement>('[data-action="music-addon-update"]')!;
    expect(abcAdd.disabled).toBe(false);
    expect(abcAdd.textContent).toBe("ZIPから追加");
    expect(abcAdd.getAttribute("aria-label")).toBe("ABC記譜法をZIPから追加");
    expect(lilypond.querySelector('[data-addon-remote-status]')?.textContent)
      .toContain("このWasabiPad版では非互換（必要版 99.0.0）");
    expect(lilypondUpdate.textContent).toBe("ZIPから更新");
    expect(lilypondUpdate.getAttribute("aria-label")).toBe("LilyPondをZIPから更新");
    expect(lilypondUpdate.disabled).toBe(false);
    expect(lilypond.querySelector<HTMLButtonElement>('[data-action="music-addon-toggle"]')?.disabled).toBe(false);
    expect(lilypond.querySelector<HTMLButtonElement>('[data-action="music-addon-remove"]')?.disabled).toBe(false);

    abcAdd.click();
    await vi.waitFor(() => expect(ports.installMusicAddon).toHaveBeenCalledWith("abc"));
    lilypondUpdate.click();
    await vi.waitFor(() => expect(ports.installMusicAddon).toHaveBeenCalledWith("lilypond"));
    await vi.waitFor(() => expect(lilypond.getAttribute("aria-busy")).toBe("false"));
    lilypond.querySelector<HTMLButtonElement>('[data-action="music-addon-toggle"]')!.click();
    await vi.waitFor(() => expect(ports.setMusicAddonEnabled).toHaveBeenCalledWith("lilypond", false));
    await vi.waitFor(() => expect(lilypond.getAttribute("aria-busy")).toBe("false"));
    lilypond.querySelector<HTMLButtonElement>('[data-action="music-addon-remove"]')!.click();
    await vi.waitFor(() => expect(ports.removeMusicAddon).toHaveBeenCalledWith("lilypond"));
  });

  // Feature: 公式音楽アドインの設定
  // Scenario: ZIPからの追加・有効切替・更新・削除を選んだ行へ反映する
  // Given: ABCは有効で、LilyPondは未インストール
  // When: LilyPondをZIPから追加し、ABCの有効状態を切り替えて更新・削除する
  // Then: 各操作を対象IDでportへ委譲し、取得したローカル状態を表示する
  it("Scenario: 公式音楽アドインをZIPから追加・切替・更新・削除する", async () => {
    const statuses = new Map([
      ["abc", { id: "abc", version: "1.0.0", installed: true, enabled: true }],
      ["lilypond", { id: "lilypond", version: null, installed: false, enabled: false }],
    ]);
    const ports = makePorts();
    ports.getMusicAddonStatus = vi.fn(async (id: string) => ({ ...statuses.get(id)! }));
    ports.getMusicAddonCatalog = vi.fn(async () => []);
    ports.installMusicAddon = vi.fn(async (id: string) => {
      statuses.set(id, { id, version: "2.0.0", installed: true, enabled: true });
    });
    ports.setMusicAddonEnabled = vi.fn(async (id: string, enabled: boolean) => {
      statuses.set(id, { ...statuses.get(id)!, enabled });
    });
    ports.removeMusicAddon = vi.fn(async (id: string) => {
      statuses.set(id, { id, version: null, installed: false, enabled: false });
    });
    openSettingsModal(ports);

    const section = document.querySelector<HTMLElement>("#settings-addons")!;
    const abc = section.querySelector<HTMLElement>('[data-addon-id="abc"]')!;
    const lilypond = section.querySelector<HTMLElement>('[data-addon-id="lilypond"]')!;
    await vi.waitFor(() => expect(abc.querySelector('[data-addon-local-status]')?.textContent).toContain("有効"));

    lilypond.querySelector<HTMLButtonElement>('[data-action="music-addon-add"]')!.click();
    await vi.waitFor(() => expect(lilypond.querySelector('[data-addon-local-status]')?.textContent).toContain("有効"));
    abc.querySelector<HTMLButtonElement>('[data-action="music-addon-toggle"]')!.click();
    await vi.waitFor(() => expect(abc.querySelector('[data-addon-local-status]')?.textContent).toContain("無効"));
    abc.querySelector<HTMLButtonElement>('[data-action="music-addon-toggle"]')!.click();
    await vi.waitFor(() => expect(abc.querySelector('[data-addon-local-status]')?.textContent).toContain("有効"));
    abc.querySelector<HTMLButtonElement>('[data-action="music-addon-update"]')!.click();
    await vi.waitFor(() => expect(abc.querySelector('[data-addon-local-status]')?.textContent).toContain("v2.0.0"));
    abc.querySelector<HTMLButtonElement>('[data-action="music-addon-remove"]')!.click();
    await vi.waitFor(() => expect(abc.querySelector('[data-addon-local-status]')?.textContent).toContain("未インストール"));

    expect(ports.installMusicAddon).toHaveBeenCalledWith("lilypond");
    expect(ports.setMusicAddonEnabled).toHaveBeenNthCalledWith(1, "abc", false);
    expect(ports.setMusicAddonEnabled).toHaveBeenNthCalledWith(2, "abc", true);
    expect(ports.removeMusicAddon).toHaveBeenCalledWith("abc");
  });

  // Feature: ローカルアドインZIPの設定
  // Scenario: ZIP更新中の重複要求を防ぎ、失敗時は既存状態を保つ
  // Given: ABCはインストール済みで、更新処理が未完了
  // When: ZIPから更新を連続して押し、不正なZIPで失敗する
  // Then: 追加の更新を送らず、既存状態とZIPエラーを表示する
  it("Scenario: ZIP更新エラーを表示し既存状態を保つ", async () => {
    let rejectInstall!: (error: Error) => void;
    const ports = makePorts();
    ports.getMusicAddonStatus = vi.fn(async (id: string) => ({
      id, version: "1.2.3", installed: true, enabled: true,
    }));
    ports.installMusicAddon = vi.fn(() => new Promise<void>((_resolve, reject) => { rejectInstall = reject; }));
    openSettingsModal(ports);

    const abc = document.querySelector<HTMLElement>('[data-addon-id="abc"]')!;
    await vi.waitFor(() => expect(abc.querySelector('[data-addon-local-status]')?.textContent).toContain("有効"));
    const update = abc.querySelector<HTMLButtonElement>('[data-action="music-addon-update"]')!;
    update.click();
    update.click();
    expect(update.disabled).toBe(true);
    expect(ports.installMusicAddon).toHaveBeenCalledOnce();
    rejectInstall(new Error("invalid addon ZIP"));

    await vi.waitFor(() => expect(abc.querySelector('[data-addon-feedback]')?.textContent).toContain("invalid addon ZIP"));
    expect(abc.querySelector('[data-addon-local-status]')?.textContent).toContain("1.2.3");
    expect(abc.querySelector('[data-addon-local-status]')?.textContent).toContain("有効");
  });

  // Feature: LilyPond実行ファイルの設定
  // Scenario: 実行ファイルのパスを保存し、空欄で解除する
  // Given: LilyPond実行ファイルのパス入力欄を表示している
  // When: パスを入力し、続けて空欄へ変更する
  // Then: 設定を文字列から`null`へ更新する
  it("Scenario: LilyPond実行ファイルのパスを保存・解除する", () => {
    const ports = makePorts();
    openSettingsModal(ports);
    const input = document.querySelector<HTMLInputElement>('[data-setting="lilypond-executable-path"]')!;
    const explanation = document.querySelector<HTMLElement>(".settings-lilypond-path")?.parentElement?.textContent ?? "";
    expect(explanation).toContain("別途インストール");
    expect(explanation).toContain("信頼できる楽譜");

    input.value = "C:\\LilyPond\\bin\\lilypond.exe";
    input.dispatchEvent(new Event("change", { bubbles: true }));
    input.value = "   ";
    input.dispatchEvent(new Event("change", { bubbles: true }));

    expect(ports.setSetting).toHaveBeenCalledWith("lilypondExecutablePath", "C:\\LilyPond\\bin\\lilypond.exe");
    expect(ports.setSetting).toHaveBeenLastCalledWith("lilypondExecutablePath", null);
    expect(input.getAttribute("aria-label")).toBe("LilyPond実行ファイルのパス");
  });

  // Given: 設定画面から開いた子ダイアログと、設定画面を再表示する処理がある
  // When: 子ダイアログの処理が完了する
  // Then: 設定画面を再表示する
  it("Scenario: 子ダイアログを閉じると設定画面へ戻る", async () => {
    const reopen = vi.fn();

    await returnToSettings(async () => {}, reopen);

    expect(reopen).toHaveBeenCalledOnce();
  });

  // Given: 設定モーダルを任意の位置までスクロールしている
  // When: 子ダイアログを開くために設定モーダルを閉じ、同じ位置で再表示する
  // Then: 設定モーダルのスクロール位置を保持する
  it("Scenario: 子ダイアログから設定画面へ戻ると編集位置を保持する", () => {
    const closedStates: SettingsModalState[] = [];
    const modal = openSettingsModal(makePorts(), (state) => closedStates.push(state));
    const content = document.querySelector<HTMLElement>(".settings-content")!;
    Object.defineProperty(content, "scrollTop", { configurable: true, writable: true, value: 320 });

    modal.close();

    expect(closedStates[0].scrollTop).toBe(320);
    expect(closedStates[0].activeSectionId).toBe("settings-general");
    openSettingsModal(makePorts(), undefined, closedStates[0]);

    expect(document.querySelector<HTMLElement>(".settings-content")!.scrollTop).toBe(320);
    expect(document.querySelector<HTMLButtonElement>('[data-settings-tab="一般"]')!
      .getAttribute("aria-selected")).toBe("true");
  });

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
    expect(document.querySelector("[data-settings-section=登録文字列]")).not.toBeNull();
    expect(document.querySelector("[data-settings-section='登録コマンド（ファイル）']")).not.toBeNull();
    expect(document.querySelector("[data-settings-section='登録コマンド（選択文字列）']")).not.toBeNull();
    expect(document.querySelector('[data-setting="startup-path"]')).not.toBeNull();
    expect(document.querySelector('[data-setting="markdown-line-height"]')).not.toBeNull();
    expect(document.querySelector('[data-setting="markdown-heading-underlines"]')).not.toBeNull();
    expect(document.querySelector('[data-setting="sqlite-preview-rows"]')).not.toBeNull();
    expect(document.querySelector(".settings-reset")).not.toBeNull();
  });

  // Given: 現在のアプリ設定
  // When: 設定モーダルを開く
  // Then: 左側に縦タブを表示し、右側のセクションを一般からAboutの順に表示する
  it("Scenario: 設定カテゴリを縦タブで選択でき、Aboutを最後に表示する", () => {
    openSettingsModal(makePorts());

    const tabList = document.querySelector<HTMLElement>(".settings-tabs")!;
    const tabs = [...tabList.querySelectorAll<HTMLButtonElement>('[role="tab"]')];
    const content = document.querySelector<HTMLElement>(".settings-content")!;
    const sections = [...content.querySelectorAll<HTMLElement>("[data-settings-section]")];

    expect(tabList.getAttribute("role")).toBe("tablist");
    expect(tabList.getAttribute("aria-orientation")).toBe("vertical");
    expect(tabs.map((tab) => tab.textContent)).toEqual([
      "一般",
      "エディタ",
      "プレビュー",
      "アドイン",
      "検索",
      "登録文字列",
      "登録コマンド（ファイル）",
      "登録コマンド（選択文字列）",
      "About",
    ]);
    expect(sections.map((section) => section.dataset.settingsSection)).toEqual([
      "一般",
      "エディタ",
      "プレビュー",
      "アドイン",
      "検索",
      "登録文字列",
      "登録コマンド（ファイル）",
      "登録コマンド（選択文字列）",
      "About",
    ]);
    expect(tabs[0].getAttribute("aria-selected")).toBe("true");

    const about = sections.at(-1)!;
    expect(about.textContent).toContain(APP_NAME);
    expect(about.querySelector('[data-about-value="version"]')?.textContent)
      .toBe(releaseTag(packageInfo.version));
  });

  // Given: 複雑な設定を含む現在のアプリ設定
  // When: 設定モーダルを開く
  // Then: 詳細編集ではなく、既存ダイアログを開く入口を表示する
  it("Scenario: 複雑な設定は編集ボタンから既存ダイアログを開く", () => {
    const ports = makePorts({
      registeredStrings: ["one"],
      registeredCommands: [{ label: "Editor", prefix: "", command: "code {file}" }],
    });

    openSettingsModal(ports);

    const search = document.querySelector<HTMLElement>('[data-setting-group="workspace-search"]')!;
    const strings = document.querySelector<HTMLElement>('[data-setting-group="registered-strings"]')!;
    const fileCommands = document.querySelector<HTMLElement>('[data-setting-group="registered-commands-file"]')!;
    const stringCommands = document.querySelector<HTMLElement>('[data-setting-group="registered-commands-string"]')!;
    expect(search.querySelector('[data-action="edit-search-settings"]')).not.toBeNull();
    expect(search.querySelector(".ss-columns")).toBeNull();
    expect(strings.querySelector('[data-action="add-registered-string"]')).not.toBeNull();
    expect(strings.querySelector('[data-action="edit-registered-string"]')).not.toBeNull();
    expect(fileCommands.querySelector('[data-action="add-registered-command-file"]')).not.toBeNull();
    expect(stringCommands.querySelector('[data-action="add-registered-command-string"]')).not.toBeNull();
    expect(fileCommands.querySelector('[data-action="edit-registered-command"]')).not.toBeNull();
    expect(stringCommands.querySelector('[data-action="edit-registered-command"]')).toBeNull();
    expect(fileCommands.querySelector('[data-setting^="registered-command-"]')).toBeNull();
  });

  // Given: 登録文字列とファイル用・文字列用コマンドが設定済み
  // When: 設定画面の追加・編集・削除操作を表示する
  // Then: 右クリックメニューと同じアイコンと記号を表示する
  it("Scenario: 登録項目の操作表示を右クリックメニューと揃える", () => {
    const ports = makePorts({
      registeredStrings: ["one"],
      registeredCommands: [
        { label: "Editor", prefix: "", command: "code {file}" },
        { label: "Browser", prefix: "", command: "open {string}", valueKind: "string" },
      ],
    });
    openSettingsModal(ports);

    const strings = document.querySelector<HTMLElement>('[data-setting-group="registered-strings"]')!;
    expect(strings.querySelector('[data-action="add-registered-string"] .menu-icon-registered-string')).not.toBeNull();
    expect(strings.querySelector('[data-action="add-registered-string"]')?.textContent).toBe("登録文字列を追加");
    expect(strings.querySelector('[data-action="edit-registered-string"]')?.textContent).toBe("⚙");
    expect(strings.querySelector('[data-action="delete-registered-string"]')?.textContent).toBe("×");

    expect(strings.lastElementChild).toBe(strings.querySelector('[data-action="add-registered-string"]'));

    const fileCommands = document.querySelector<HTMLElement>('[data-setting-group="registered-commands-file"]')!;
    const stringCommands = document.querySelector<HTMLElement>('[data-setting-group="registered-commands-string"]')!;
    for (const [kind, group] of [["file", fileCommands], ["string", stringCommands]] as const) {
      expect(group.querySelector(`[data-action="add-registered-command-${kind}"] .menu-icon-command`)).not.toBeNull();
      expect(group.querySelector('[data-action^="add-registered-command-"]')?.textContent).toBe("コマンドを登録...");
      expect(group.querySelector('[data-action="edit-registered-command"]')?.textContent).toBe("⚙");
      expect(group.querySelector('[data-action="delete-registered-command"]')?.textContent).toBe("×");
      expect(group.lastElementChild).toBe(group.querySelector(`[data-action="add-registered-command-${kind}"]`));
    }
  });

  // Given: 設定モーダルを開いている
  // When: 検索設定の編集ボタンを押す
  // Then: 親モーダルを閉じて検索設定ダイアログの入口へ委譲する
  it("Scenario: 検索設定の編集入口をportへ委譲する", () => {
    const ports = makePorts();
    openSettingsModal(ports);

    document.querySelector<HTMLButtonElement>('[data-action="edit-search-settings"]')!.click();

    expect(ports.openSearchSettings).toHaveBeenCalledOnce();
    expect(document.querySelector(".settings-box")).toBeNull();
  });

  // Given: 登録文字列と登録コマンドが設定済み
  // When: 登録文字列の編集と登録コマンドの編集を選ぶ
  // Then: 種別と対象をportへ渡して親モーダルを閉じる
  it("Scenario: 登録項目の編集入口をportへ委譲する", () => {
    const command = { label: "Editor", prefix: "", command: "code {file}" };
    const ports = makePorts({ registeredStrings: ["one"], registeredCommands: [command] });
    openSettingsModal(ports);

    document.querySelector<HTMLButtonElement>('[data-action="edit-registered-string"]')!.click();
    expect(ports.openRegisteredString).toHaveBeenCalledWith("one");
    expect(document.querySelector(".settings-box")).toBeNull();

    openSettingsModal(ports);
    document.querySelector<HTMLButtonElement>('[data-action="edit-registered-command"]')!.click();
    expect(ports.openRegisteredCommand).toHaveBeenCalledWith("file", command);
    expect(document.querySelector(".settings-box")).toBeNull();
  });

  // Given: 登録設定を開いている
  // When: 登録文字列とファイル用・文字列用コマンドの追加入口を選ぶ
  // Then: 対応するダイアログのportへ委譲する
  it("Scenario: 登録項目の追加入口をportへ委譲する", () => {
    const ports = makePorts();
    openSettingsModal(ports);

    document.querySelector<HTMLButtonElement>('[data-action="add-registered-string"]')!.click();
    expect(ports.openRegisteredString).toHaveBeenCalledWith(undefined);

    openSettingsModal(ports);
    document.querySelector<HTMLButtonElement>('[data-action="add-registered-command-file"]')!.click();
    expect(ports.openRegisteredCommand).toHaveBeenCalledWith("file", undefined);

    openSettingsModal(ports);
    document.querySelector<HTMLButtonElement>('[data-action="add-registered-command-string"]')!.click();
    expect(ports.openRegisteredCommand).toHaveBeenCalledWith("string", undefined);
  });

  // Given: 設定モーダルを開いている
  // When: プレビュータブをクリックする
  // Then: 対応する設定セクションへスクロールし、タブを選択状態にする
  it("Scenario: タブクリックで対応セクションへ移動する", () => {
    openSettingsModal(makePorts());

    const content = document.querySelector<HTMLElement>(".settings-content")!;
    const preview = document.querySelector<HTMLElement>('[data-settings-section="プレビュー"]')!;
    const scrollIntoView = vi.fn();
    Object.defineProperty(preview, "scrollIntoView", { configurable: true, value: scrollIntoView });

    document.querySelector<HTMLButtonElement>('[data-settings-tab="プレビュー"]')!.click();

    expect(scrollIntoView).toHaveBeenCalledWith({ behavior: "smooth", block: "start" });
    expect(preview.id).toBeTruthy();
    expect(content.getAttribute("aria-activedescendant")).toBe(preview.id);
    expect(document.querySelector<HTMLButtonElement>('[data-settings-tab="プレビュー"]')!
      .getAttribute("aria-selected")).toBe("true");
  });

  // Given: 設定セクションがスクロール領域内に並んでいる
  // When: 検索セクションが先頭に近づくまで設定領域をスクロールする
  // Then: 対応する検索タブを選択状態にする
  it("Scenario: スクロール位置に応じて選択中タブを追従させる", () => {
    openSettingsModal(makePorts());

    const content = document.querySelector<HTMLElement>(".settings-content")!;
    const sections = [...content.querySelectorAll<HTMLElement>("[data-settings-section]")];
    const searchIndex = sections.findIndex((section) => section.dataset.settingsSection === "検索");
    vi.spyOn(content, "getBoundingClientRect").mockReturnValue({ top: 100, bottom: 500 } as DOMRect);
    sections.forEach((section, index) => {
      vi.spyOn(section, "getBoundingClientRect").mockReturnValue({
        top: index < searchIndex ? -500 + index * 100 : index === searchIndex ? 105 : 700 + index * 100,
        bottom: index < searchIndex ? -400 + index * 100 : index === searchIndex ? 300 : 900 + index * 100,
      } as DOMRect);
    });

    content.dispatchEvent(new Event("scroll"));

    expect(document.querySelector<HTMLButtonElement>('[data-settings-tab="検索"]')!
      .getAttribute("aria-selected")).toBe("true");
    expect(content.getAttribute("aria-activedescendant"))
      .toBe(document.querySelector<HTMLElement>('[data-settings-section="検索"]')!.id);
  });

  // Given: Markdown通常改行設定を有効にした現在のアプリ設定
  // When: 詳細設定のプレビュー項目を開いて切り替える
  // Then: 設定を保存し、表示中のプレビューへ即時反映する
  it("Scenario: Markdown通常改行をプレビュー設定から切り替える", () => {
    const ports = makePorts();
    openSettingsModal(ports);

    const previewSection = document.querySelector<HTMLElement>("[data-settings-section=プレビュー]")!;
    const input = previewSection.querySelector<HTMLInputElement>('[data-setting="markdown-soft-breaks"]')!;
    expect(input.type).toBe("checkbox");
    expect(input.checked).toBe(true);
    input.click();

    expect(ports.setSetting).toHaveBeenCalledWith("markdownSoftBreaks", false);
    expect(ports.applyMarkdownSoftBreaks).toHaveBeenCalledWith(false);
    expect(document.querySelector(".settings-box")).not.toBeNull();
  });

  // Given: Markdown行間1.65の現在のアプリ設定
  // When: プレビュー設定の行間を1.8へ変更する
  // Then: 設定を保存し、表示中のプレビューへ即時反映する
  it("Scenario: Markdown行間をプレビュー設定から変更する", () => {
    const ports = makePorts();
    openSettingsModal(ports);

    const input = document.querySelector<HTMLInputElement>('[data-setting="markdown-line-height"]')!;
    expect(input.type).toBe("number");
    expect(input.min).toBe("1.4");
    expect(input.max).toBe("2");
    expect(input.step).toBe("0.05");
    input.value = "1.8";
    input.dispatchEvent(new Event("change"));

    expect(ports.setSetting).toHaveBeenCalledWith("markdownLineHeight", 1.8);
    expect(ports.applyMarkdownLineHeight).toHaveBeenCalledWith(1.8);
  });

  // Given: SQLiteプレビュー行数100の現在のアプリ設定
  // When: 設定画面で上限なしの1000000行へ変更する
  // Then: その値を設定ストアへ保存し、入力要素にmax属性を付けない
  it("Scenario: SQLiteプレビュー行数を上限なしで変更する", () => {
    const ports = makePorts();
    openSettingsModal(ports);

    const input = document.querySelector<HTMLInputElement>('[data-setting="sqlite-preview-rows"]')!;
    expect(input.type).toBe("number");
    expect(input.min).toBe("1");
    expect(input.max).toBe("");
    input.value = "1000000";
    input.dispatchEvent(new Event("change"));

    expect(ports.setSetting).toHaveBeenCalledWith("sqlitePreviewRows", 1000000);
  });

  // Given: Markdown見出し下線を無効にした現在のアプリ設定
  // When: プレビュー設定の見出し下線を有効にする
  // Then: 設定を保存し、表示中のプレビューへ即時反映する
  it("Scenario: Markdown見出し下線をプレビュー設定から切り替える", () => {
    const ports = makePorts();
    openSettingsModal(ports);

    const input = document.querySelector<HTMLInputElement>('[data-setting="markdown-heading-underlines"]')!;
    expect(input.type).toBe("checkbox");
    expect(input.checked).toBe(false);
    input.click();

    expect(ports.setSetting).toHaveBeenCalledWith("markdownHeadingUnderlines", true);
    expect(ports.applyMarkdownHeadingUnderlines).toHaveBeenCalledWith(true);
  });

  // Feature: 登録コマンドの設定画面
  // Scenario: 登録コマンドの同じ種類の順序をD&Dで変更する
  // Given: ファイル用2件と文字列用1件の登録コマンドがある
  // When: ファイル用の2件目を1件目へドロップする
  // Then: 種類別の順序を設定ストアへ即時保存する
  it("Scenario: 登録コマンドを設定画面で並べ替える", () => {
    const ports = makePorts({
      registeredCommands: [
        { label: "Editor", prefix: "", command: "code {file}" },
        { label: "Browser", prefix: "", command: "open {string}", valueKind: "string" },
        { label: "Notepad", prefix: "", command: "notepad {file}" },
      ],
    });
    openSettingsModal(ports);

    const section = document.querySelector<HTMLElement>("[data-settings-section='登録コマンド（ファイル）']")!;
    const first = section.querySelector<HTMLElement>('[data-command-index="0"]')!;
    const second = section.querySelector<HTMLElement>('[data-command-index="2"]')!;
    second.dispatchEvent(new Event("dragstart", { bubbles: true }));
    first.dispatchEvent(new Event("drop", { bubbles: true }));

    expect(ports.getSetting("registeredCommands")).toEqual([
      { label: "Notepad", prefix: "", command: "notepad {file}" },
      { label: "Browser", prefix: "", command: "open {string}", valueKind: "string" },
      { label: "Editor", prefix: "", command: "code {file}" },
    ]);
  });

  // Feature: 登録コマンドの設定画面
  // Scenario: 登録コマンドを上下矢印で移動する
  // Given: 同じ種類の登録コマンドが2件ある
  // When: 2件目の上矢印を押す
  // Then: 同じ種類の登録順だけを入れ替えて保存する
  it("Scenario: 登録コマンドを上下矢印で並べ替える", () => {
    const ports = makePorts({
      registeredCommands: [
        { label: "Editor", prefix: "", command: "code {file}" },
        { label: "Notepad", prefix: "", command: "notepad {file}" },
      ],
    });
    openSettingsModal(ports);

    document.querySelector<HTMLButtonElement>(
      '[data-action="move-registered-command-up"][data-command-index="1"]',
    )!.click();

    expect(ports.getSetting("registeredCommands")).toEqual([
      { label: "Notepad", prefix: "", command: "notepad {file}" },
      { label: "Editor", prefix: "", command: "code {file}" },
    ]);
  });

  // Given: ファイル用1件、文字列用2件、ファイル用1件の登録コマンドがある
  // When: ファイル用の先頭を削除してから、文字列用の2件目を上へ移動し、1件目を削除する
  // Then: 別種別の削除で配列位置が変わっても対象コマンドを正しく操作する
  it("Scenario: 種類の異なるコマンド削除後も別一覧の操作対象を維持する", () => {
    const ports = makePorts({
      registeredCommands: [
        { label: "Editor", prefix: "", command: "code {file}" },
        { label: "Browser", prefix: "", command: "open {string}", valueKind: "string" },
        { label: "Terminal", prefix: "", command: "wt {string}", valueKind: "string" },
        { label: "Notepad", prefix: "", command: "notepad {file}" },
      ],
    });
    openSettingsModal(ports);

    const fileCommands = document.querySelector<HTMLElement>('[data-setting-group="registered-commands-file"]')!;
    const stringCommands = document.querySelector<HTMLElement>('[data-setting-group="registered-commands-string"]')!;
    fileCommands.querySelector<HTMLButtonElement>('[data-action="delete-registered-command"][data-command-index="0"]')!.click();
    stringCommands.querySelector<HTMLButtonElement>('[data-action="move-registered-command-up"][data-command-index="2"]')!.click();
    stringCommands.querySelector<HTMLButtonElement>('[data-action="delete-registered-command"][data-command-index="1"]')!.click();

    expect(ports.getSetting("registeredCommands")).toEqual([
      { label: "Terminal", prefix: "", command: "wt {string}", valueKind: "string" },
      { label: "Notepad", prefix: "", command: "notepad {file}" },
    ]);
  });

  // Feature: 外部プレビューキャッシュ保存場所の設定画面
  // Scenario: プレビュー設定に現在のキャッシュ保存場所を表示する
  // Given: プレビューキャッシュ保存場所が `D:\\WasabiPad\\preview-cache` に設定されている
  // When: 設定モーダルのプレビューカテゴリを開く
  // Then: 現在の保存場所を確認できる
  it("Scenario: プレビューキャッシュ保存場所を表示する", () => {
    openSettingsModal(makePorts({ previewCacheDirectory: "D:\\WasabiPad\\preview-cache" }));

    const previewSection = document.querySelector<HTMLElement>("[data-settings-section=プレビュー]")!;
    expect(previewSection.querySelector('[data-setting="preview-cache-directory"]')?.textContent)
      .toBe("D:\\WasabiPad\\preview-cache");
  });

  // Given: プレビューキャッシュ保存場所の設定を表示している
  // When: 設定画面の「?」をクリックする
  // Then: キャッシュを使う場面と対象外の場面を説明モーダルで表示する
  it("Scenario: プレビューキャッシュ保存場所の説明を表示する", () => {
    openSettingsModal(makePorts());

    const previewSection = document.querySelector<HTMLElement>("[data-settings-section=プレビュー]")!;
    const help = previewSection.querySelector<HTMLButtonElement>('[data-action="show-preview-cache-help"]')!;

    help.click();

    const message = document.querySelector<HTMLElement>(".pf-message")!;
    expect(message.textContent).toContain("画像プレビュー");
    expect(message.textContent).toContain("アーカイブ内画像");
    expect(message.textContent).toContain("Markdown本文内のローカル画像");
    expect(message.textContent).toContain("PDF");
    expect(message.textContent).toContain("パスワード付き7z");
    expect(message.textContent).toContain("サイズや更新日時");
    message.parentElement!.querySelector<HTMLButtonElement>(".pf-ok")!.click();
    expect(document.querySelector(".pf-message")).toBeNull();
  });

  // Feature: 外部プレビューキャッシュ保存場所の設定画面
  // Scenario: 未設定時にもバックエンドが使う実際の場所と使用量を確認する
  // Given: 設定は未指定で、バックエンドが既定キャッシュ情報を返す
  // When: 設定モーダルのプレビューカテゴリを開く
  // Then: 実際の保存先と使用量を表示する
  it("Scenario: 既定のプレビューキャッシュ場所と使用量を表示する", async () => {
    const getPreviewCacheInfo = vi.fn(async () => ({
      directory: "C:\\Users\\test\\AppData\\Local\\WasabiPad\\.wasabipad-preview-cache",
      bytes: 1024 * 1024,
    }));
    const ports = Object.assign(makePorts(), { getPreviewCacheInfo });
    openSettingsModal(ports as SettingsPanelPorts);

    await vi.waitFor(() => {
      const previewSection = document.querySelector<HTMLElement>("[data-settings-section=プレビュー]")!;
      expect(previewSection.querySelector('[data-setting="preview-cache-directory"]')?.textContent)
        .toBe("C:\\Users\\test\\AppData\\Local\\WasabiPad\\.wasabipad-preview-cache");
      expect(previewSection.querySelector('[data-setting="preview-cache-size"]')?.textContent)
        .toBe("使用量: 1.0 MB");
    });
  });

  // Given: 保存場所は未指定で、バックエンドが実際の既定場所を返す
  // When: 既定場所の取得中に「保存場所を変更」ボタンを押す
  // Then: 表示中の既定場所からフォルダ選択ダイアログを開く
  it("Scenario: 未設定のプレビューキャッシュ選択を表示中の既定場所から開く", async () => {
    const defaultDirectory = "C:\\Users\\test\\AppData\\Local\\WasabiPad\\.wasabipad-preview-cache";
    const getPreviewCacheInfo = vi.fn(async () => ({ directory: defaultDirectory, bytes: 0 }));
    const pickPreviewCacheDirectory = vi.fn(() => null);
    const ports = Object.assign(makePorts(), { getPreviewCacheInfo, pickPreviewCacheDirectory });
    openSettingsModal(ports as SettingsPanelPorts);

    const previewSection = document.querySelector<HTMLElement>("[data-settings-section=プレビュー]")!;
    previewSection.querySelector<HTMLButtonElement>('[data-action="pick-preview-cache-directory"]')!.click();

    await vi.waitFor(() => expect(pickPreviewCacheDirectory).toHaveBeenCalledWith(defaultDirectory));
  });

  // Given: 保存場所の既定値の取得に失敗している
  // When: 「保存場所を変更」ボタンを押す
  // Then: 既定値なしでフォルダ選択ダイアログを開く
  it("Scenario: プレビューキャッシュ場所の確認に失敗しても選択を続ける", async () => {
    const getPreviewCacheInfo = vi.fn(async () => {
      throw new Error("info unavailable");
    });
    const pickPreviewCacheDirectory = vi.fn(() => null);
    const ports = Object.assign(makePorts(), { getPreviewCacheInfo, pickPreviewCacheDirectory });
    openSettingsModal(ports as SettingsPanelPorts);

    document.querySelector<HTMLButtonElement>('[data-action="pick-preview-cache-directory"]')!.click();

    await vi.waitFor(() => expect(pickPreviewCacheDirectory).toHaveBeenCalledWith(undefined));
  });

  // Given: 保存場所の既定値を取得中である
  // When: 「保存場所を変更」ボタンを連続して押す
  // Then: フォルダ選択ダイアログを一度だけ開く
  it("Scenario: プレビューキャッシュ場所の選択を連続実行しない", async () => {
    const defaultDirectory = "C:\\Users\\test\\AppData\\Local\\WasabiPad\\.wasabipad-preview-cache";
    let resolveInfo: ((info: { directory: string; bytes: number }) => void) | undefined;
    const getPreviewCacheInfo = vi.fn(() => new Promise<{ directory: string; bytes: number }>((resolve) => {
      resolveInfo = resolve;
    }));
    const pickPreviewCacheDirectory = vi.fn(() => null);
    const ports = Object.assign(makePorts(), { getPreviewCacheInfo, pickPreviewCacheDirectory });
    openSettingsModal(ports as SettingsPanelPorts);

    const pick = document.querySelector<HTMLButtonElement>('[data-action="pick-preview-cache-directory"]')!;
    pick.click();
    pick.click();
    resolveInfo!({ directory: defaultDirectory, bytes: 0 });

    await vi.waitFor(() => expect(pickPreviewCacheDirectory).toHaveBeenCalledOnce());
  });

  // Given: 設定済みの保存場所を作成中である
  // When: 「保存場所を変更」ボタンを押す
  // Then: 保存場所の準備完了後に現在のフォルダから選択を始める
  it("Scenario: 設定済みプレビューキャッシュ場所の準備完了を待つ", async () => {
    const currentDirectory = "D:\\WasabiPad\\preview-cache";
    let resolveInfo: ((info: { directory: string; bytes: number }) => void) | undefined;
    const getPreviewCacheInfo = vi.fn(() => new Promise<{ directory: string; bytes: number }>((resolve) => {
      resolveInfo = resolve;
    }));
    const pickPreviewCacheDirectory = vi.fn(() => null);
    const ports = Object.assign(makePorts({ previewCacheDirectory: currentDirectory }), {
      getPreviewCacheInfo,
      pickPreviewCacheDirectory,
    });
    openSettingsModal(ports as SettingsPanelPorts);

    document.querySelector<HTMLButtonElement>('[data-action="pick-preview-cache-directory"]')!.click();
    expect(pickPreviewCacheDirectory).not.toHaveBeenCalled();
    resolveInfo!({ directory: `${currentDirectory}\\.wasabipad-preview-cache`, bytes: 0 });

    await vi.waitFor(() => expect(pickPreviewCacheDirectory).toHaveBeenCalledWith(currentDirectory));
  });

  // Feature: 外部プレビューキャッシュ保存場所の設定画面
  // Scenario: 選択した保存場所だけをSettingsへ保存する
  // Given: フォルダ選択portが `D:\\WasabiPad\\preview-cache` を返す
  // When: 保存場所の選択ボタンを押す
  // Then: 選択した場所を`previewCacheDirectory`として保存する
  it("Scenario: プレビューキャッシュ保存場所を選択して保存する", async () => {
    const selectedDirectory = "D:\\WasabiPad\\preview-cache";
    const pickPreviewCacheDirectory = vi.fn(() => selectedDirectory);
    const ports = Object.assign(makePorts({ previewCacheDirectory: null }), { pickPreviewCacheDirectory });
    openSettingsModal(ports as SettingsPanelPorts);

    const previewSection = document.querySelector<HTMLElement>("[data-settings-section=プレビュー]")!;
    previewSection.querySelector<HTMLButtonElement>('[data-action="pick-preview-cache-directory"]')!.click();

    await vi.waitFor(() => expect(ports.setSetting).toHaveBeenCalledWith(
      "previewCacheDirectory",
      selectedDirectory,
    ));
    expect(previewSection.querySelector('[data-setting="preview-cache-directory"]')?.textContent)
      .toBe(selectedDirectory);
  });

  // Given: プレビューキャッシュ保存場所が `D:\\WasabiPad\\preview-cache` に設定されている
  // When: 「保存場所を変更」ボタンを押す
  // Then: フォルダ選択ダイアログを現在の保存場所から開く
  it("Scenario: プレビューキャッシュ保存場所の選択を現在のフォルダから開く", () => {
    const currentDirectory = "D:\\WasabiPad\\preview-cache";
    const pickPreviewCacheDirectory = vi.fn(() => null);
    const ports = Object.assign(makePorts({ previewCacheDirectory: currentDirectory }), {
      pickPreviewCacheDirectory,
    });
    openSettingsModal(ports as SettingsPanelPorts);

    document.querySelector<HTMLButtonElement>('[data-action="pick-preview-cache-directory"]')!.click();

    expect(pickPreviewCacheDirectory).toHaveBeenCalledWith(currentDirectory);
  });

  // Feature: 外部プレビューキャッシュ保存場所の設定画面
  // Scenario: キャッシュ全削除を注入したportへ委譲する
  // Given: キャッシュ全削除portが利用できる
  // When: プレビュー設定のキャッシュ全削除ボタンを押す
  // Then: キャッシュ全削除portを呼び出す
  it("Scenario: プレビューキャッシュを全削除する", () => {
    const clearPreviewCache = vi.fn();
    const ports = Object.assign(makePorts(), { clearPreviewCache });
    openSettingsModal(ports as SettingsPanelPorts);

    const previewSection = document.querySelector<HTMLElement>("[data-settings-section=プレビュー]")!;
    previewSection.querySelector<HTMLButtonElement>('[data-action="clear-preview-cache"]')!.click();

    expect(clearPreviewCache).toHaveBeenCalledOnce();
  });

  // Given: 設定モーダルを開いている
  // When: 検索設定の編集ボタンを押す
  // Then: 既存の検索設定ダイアログのportへ委譲する
  it("Scenario: 検索設定を既存ダイアログで編集する", () => {
    const ports = makePorts();
    openSettingsModal(ports);

    document.querySelector<HTMLButtonElement>('[data-action="edit-search-settings"]')!.click();

    expect(ports.openSearchSettings).toHaveBeenCalledOnce();
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
      registeredCommands: [{ label: "Editor", prefix: "", command: "code {file}" }],
    });
    openSettingsModal(ports);

    const strings = document.querySelector<HTMLElement>('[data-setting-group="registered-strings"]')!;
    const commands = document.querySelector<HTMLElement>('[data-setting-group="registered-commands-file"]')!;
    strings.querySelector<HTMLButtonElement>('[title="登録文字列を削除"]')!.click();
    strings.querySelector<HTMLButtonElement>('[title="登録文字列を削除"]')!.click();
    commands.querySelector<HTMLButtonElement>('[title="このコマンドの登録を解除"]')!.click();

    expect(ports.setSetting).toHaveBeenCalledWith("registeredStrings", ["two"]);
    expect(ports.setSetting).toHaveBeenCalledWith("registeredStrings", []);
    expect(ports.setSetting).toHaveBeenCalledWith("registeredCommands", []);
  });
});
