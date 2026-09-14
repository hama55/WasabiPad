// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import { FONT_FAMILIES, MAX_FONT_SIZE, MIN_FONT_SIZE } from "./font-controls";
import { initialSession } from "./session";
import { EditingStatusBar, FileStatusBar, type StatusBarPorts } from "./statusbar";

function mount(overrides: Partial<StatusBarPorts> = {}) {
  const host = document.createElement("div");
  host.innerHTML = `
    <div id="file-statusbar"><span id="st-size"></span><span id="st-modified"></span></div>
    <div id="editing-statusbar">
      <span id="st-mode"></span>
      <span id="st-binary" hidden></span>
      <label id="st-delimiter" hidden>区切り <input id="st-delimiter-input" value="," /></label>
      <button id="st-pos"></button><button id="st-lines"></button>
      <select id="st-font"></select><select id="st-font-size"></select>
      <select id="st-indent"></select><button id="st-wrap"></button>
      <select id="st-source-enc"></select><span id="st-eol"></span>
    </div>
  `;
  document.body.replaceChildren(host);
  const ports: StatusBarPorts = {
    onGoTo: vi.fn(),
    onFontFamily: vi.fn(),
    onFontSize: vi.fn(),
    onWrap: vi.fn(),
    onIndent: vi.fn(),
    onPreviewDelimiter: vi.fn(),
    onReadEncoding: vi.fn(async () => true),
    onError: vi.fn(async () => {}),
    ...overrides,
  };
  return {
    host,
    ports,
    statusbar: new EditingStatusBar(host.querySelector("#editing-statusbar")!, ports),
    fileStatusbar: new FileStatusBar(host.querySelector("#file-statusbar")!),
  };
}

describe("Feature: statusbar preview controls", () => {
  // Feature: ステータスバーのフォント選択
  // Scenario: フォントと文字サイズのプルダウンを開く
  // Given: ステータスバーが初期化されている
  // When: フォントと文字サイズの選択肢を確認する
  // Then: フォントはFONT_FAMILIES、文字サイズはMIN_FONT_SIZEからMAX_FONT_SIZEまで表示される
  it("Scenario: shows the configured font and size choices", () => {
    const { host } = mount();
    const family = host.querySelector<HTMLSelectElement>("#st-font")!;
    const size = host.querySelector<HTMLSelectElement>("#st-font-size")!;

    expect([...family.options].map((option) => option.value)).toEqual(FONT_FAMILIES);
    expect([...size.options].map((option) => Number(option.value))).toEqual(
      Array.from({ length: MAX_FONT_SIZE - MIN_FONT_SIZE + 1 }, (_, index) => MIN_FONT_SIZE + index),
    );
  });

  // Feature: ステータスバーのフォント選択
  // Scenario: 現在のフォントと文字サイズを表示する
  // Given: フォントと文字サイズが設定されたステータスバーがある
  // When: 選択状態を更新する
  // Then: 各プルダウンに現在値と表示名が反映される
  it("Scenario: displays the current font and size selection", () => {
    const { host, statusbar } = mount();
    const family = host.querySelector<HTMLSelectElement>("#st-font")!;
    const size = host.querySelector<HTMLSelectElement>("#st-font-size")!;

    statusbar.setFont(FONT_FAMILIES[1], 18);

    expect(family.value).toBe(FONT_FAMILIES[1]);
    expect(family.selectedOptions[0]?.textContent).toBe("Cascadia Mono");
    expect(size.value).toBe("18");
    expect(size.selectedOptions[0]?.textContent).toBe("18px");
  });

  // Feature: ステータスバーのフォント設定
  // Scenario: プルダウンでフォントと文字サイズを確定する
  // Given: フォントと文字サイズのプルダウンがある
  // When: 各プルダウンの選択変更を確定する
  // Then: 既存のonFontFamily/onFontSizeポートへ選択値を渡す
  it("Scenario: forwards committed font changes to the existing ports", () => {
    const { host, ports } = mount();
    const family = host.querySelector<HTMLSelectElement>("#st-font")!;
    const size = host.querySelector<HTMLSelectElement>("#st-font-size")!;

    family.value = FONT_FAMILIES[2];
    family.dispatchEvent(new Event("change"));
    size.value = String(MAX_FONT_SIZE);
    size.dispatchEvent(new Event("change"));

    expect(ports.onFontFamily).toHaveBeenCalledWith(FONT_FAMILIES[2]);
    expect(ports.onFontSize).toHaveBeenCalledWith(MAX_FONT_SIZE);
  });

  // Feature: ステータスバーのフォント候補プレビュー
  // Scenario: 候補を移動している間だけエディタのフォントをプレビューする
  // Given: 直前の確定値を表示しているフォントと文字サイズのプルダウンがある
  // When: 候補移動のinputイベントを発生させる
  // Then: プレビュー用ポートだけが呼ばれ、確定用ポートとsetSettingは呼ばれない
  it("Scenario: previews font candidates without committing them", () => {
    const onPreviewFontFamily = vi.fn();
    const onPreviewFontSize = vi.fn();
    const setSetting = vi.fn();
    const { host, ports, statusbar } = mount({
      onPreviewFontFamily,
      onPreviewFontSize,
      onFontFamily: vi.fn(() => setSetting()),
      onFontSize: vi.fn(() => setSetting()),
    });
    const family = host.querySelector<HTMLSelectElement>("#st-font")!;
    const size = host.querySelector<HTMLSelectElement>("#st-font-size")!;

    statusbar.setFont(FONT_FAMILIES[0], 14);
    vi.clearAllMocks();

    family.value = FONT_FAMILIES[1];
    family.dispatchEvent(new Event("input", { bubbles: true }));
    size.value = "18";
    size.dispatchEvent(new Event("input", { bubbles: true }));

    expect(onPreviewFontFamily).toHaveBeenCalledWith(FONT_FAMILIES[1]);
    expect(onPreviewFontSize).toHaveBeenCalledWith(18);
    expect(ports.onFontFamily).not.toHaveBeenCalled();
    expect(ports.onFontSize).not.toHaveBeenCalled();
    expect(setSetting).not.toHaveBeenCalled();
  });

  // Feature: ステータスバーのフォント候補プレビュー
  // Scenario: フォント候補へカーソルを当てる
  // Given: フォント候補とプレビュー用ポートがある
  // When: Cascadia Mono候補へpointeroverを発生させる
  // Then: changeを待たずプレビュー用ポートだけを呼び出す
  it("Scenario: フォント候補へカーソルを当てた時点でプレビューする", () => {
    const onPreviewFontFamily = vi.fn();
    const { host, ports, statusbar } = mount({ onPreviewFontFamily });
    const family = host.querySelector<HTMLSelectElement>("#st-font")!;
    const option = [...family.options].find((item) => item.value === FONT_FAMILIES[1])!;

    statusbar.setFont(FONT_FAMILIES[0], 14);
    option.dispatchEvent(new MouseEvent("pointerover", { bubbles: true }));

    expect(onPreviewFontFamily).toHaveBeenCalledWith(FONT_FAMILIES[1]);
    expect(ports.onFontFamily).not.toHaveBeenCalled();
  });

  // Feature: ステータスバーのフォント候補プレビュー
  // Scenario: 候補をchangeで確定する
  // Given: フォント候補をプレビュー中である
  // When: changeイベントを発生させる
  // Then: 既存の確定用ポートへ一度だけ選択値を渡す
  it("Scenario: commits a previewed font candidate on change", () => {
    const onPreviewFontFamily = vi.fn();
    const { host, ports, statusbar } = mount({ onPreviewFontFamily });
    const family = host.querySelector<HTMLSelectElement>("#st-font")!;

    statusbar.setFont(FONT_FAMILIES[0], 14);
    family.value = FONT_FAMILIES[1];
    family.dispatchEvent(new Event("input", { bubbles: true }));
    family.dispatchEvent(new Event("change", { bubbles: true }));
    family.dispatchEvent(new Event("blur", { bubbles: true }));

    expect(onPreviewFontFamily).toHaveBeenCalledWith(FONT_FAMILIES[1]);
    expect(ports.onFontFamily).toHaveBeenCalledTimes(1);
    expect(ports.onFontFamily).toHaveBeenCalledWith(FONT_FAMILIES[1]);
    expect(family.value).toBe(FONT_FAMILIES[1]);
  });

  // Feature: ステータスバーのフォント候補プレビュー
  // Scenario: Escapeで候補を取り消す
  // Given: フォント候補をプレビュー中である
  // When: Escapeキーを押す
  // Then: プルダウンとエディタのプレビューを直前の確定値へ戻し、確定用ポートは呼ばない
  it("Scenario: restores the last committed font on Escape", () => {
    const onPreviewFontFamily = vi.fn();
    const { host, ports, statusbar } = mount({ onPreviewFontFamily });
    const family = host.querySelector<HTMLSelectElement>("#st-font")!;

    statusbar.setFont(FONT_FAMILIES[0], 14);
    family.value = FONT_FAMILIES[1];
    family.dispatchEvent(new Event("input", { bubbles: true }));
    family.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));

    expect(family.value).toBe(FONT_FAMILIES[0]);
    expect(onPreviewFontFamily).toHaveBeenLastCalledWith(FONT_FAMILIES[0]);
    expect(ports.onFontFamily).not.toHaveBeenCalled();
  });

  // Feature: ステータスバーのフォント候補プレビュー
  // Scenario: 候補を確定せずフォーカスを外す
  // Given: 文字サイズ候補をプレビュー中である
  // When: changeを発生させずblurする
  // Then: プルダウンとエディタのプレビューを直前の確定値へ戻す
  it("Scenario: restores the last committed font size when the candidate is abandoned", () => {
    const onPreviewFontSize = vi.fn();
    const { host, ports, statusbar } = mount({ onPreviewFontSize });
    const size = host.querySelector<HTMLSelectElement>("#st-font-size")!;

    statusbar.setFont(FONT_FAMILIES[0], 14);
    size.value = "18";
    size.dispatchEvent(new Event("input", { bubbles: true }));
    size.dispatchEvent(new Event("blur", { bubbles: true }));

    expect(size.value).toBe("14");
    expect(onPreviewFontSize).toHaveBeenLastCalledWith(14);
    expect(ports.onFontSize).not.toHaveBeenCalled();
  });

  // Feature: バイナリ文書の状態表示
  // Scenario: バイナリ文書を開く
  // Given: 編集不可のバイナリ文書と通常文書がある
  // When: ステータスバーへ順に反映する
  // Then: バイナリ時だけ閲覧専用である理由を表示する
  it("Scenario: shows binary read-only status only for binary documents", () => {
    const { host, statusbar } = mount();
    const binary = host.querySelector<HTMLElement>("#st-binary")!;

    statusbar.setFormat({ ...initialSession(), readOnly: true, isBinary: true });
    expect(binary.hidden).toBe(false);
    expect(binary.textContent).toBe("閲覧専用（バイナリ）");

    statusbar.setFormat(initialSession());
    expect(binary.hidden).toBe(true);
    expect(binary.textContent).toBe("");
  });

  // Given: CSV区切り文字入力を持つステータスバー
  // When: CSV形式/Markdown形式を順に表示し、CSV区切り文字を入力する
  // Then: CSV時だけ入力欄を表示し、入力値をプレビュー更新ポートへ渡す
  it("Scenario: shows and forwards the CSV delimiter only for CSV preview", () => {
    const { host, ports, statusbar } = mount();
    const delimiter = host.querySelector<HTMLElement>("#st-delimiter")!;
    const input = host.querySelector<HTMLInputElement>("#st-delimiter-input")!;

    statusbar.setPreviewFormat("csv");
    expect(delimiter.hidden).toBe(false);
    input.value = "\\t";
    input.dispatchEvent(new Event("input"));
    expect(ports.onPreviewDelimiter).toHaveBeenCalledWith("\\t");

    statusbar.setPreviewFormat("markdown");
    expect(delimiter.hidden).toBe(true);
  });

  // Given: CSV区切り文字変更ポートが失敗する
  // When: 区切り文字を入力する
  // Then: DOMイベントからエラーを漏らさずエラーポートへ通知する
  it("Scenario: reports delimiter update failures through the error boundary", async () => {
    const { host, ports } = mount();
    ports.onPreviewDelimiter = vi.fn(async () => { throw new Error("preview failed"); });
    const input = host.querySelector<HTMLInputElement>("#st-delimiter-input")!;

    input.value = ";";
    input.dispatchEvent(new Event("input"));

    await vi.waitFor(() => expect(ports.onError).toHaveBeenCalledWith(
      "CSV区切り文字を変更できませんでした",
      expect.any(Error),
    ));
  });

  // Given: ファイル側ステータスバー
  // When: 日時を設定してから未保存状態へ戻す
  // Then: 保存日時を表示し、nullでは空表示にする
  it("Scenario: ファイル保存日時を表示する", () => {
    const { host, fileStatusbar } = mount();
    const modified = host.querySelector<HTMLElement>("#st-modified")!;

    fileStatusbar.setModifiedAt(1720000000000);
    expect(modified.textContent).toContain("保存:");
    fileStatusbar.setModifiedAt(null);
    expect(modified.textContent).toBe("");
  });

  // Feature: ステータスバーの保存日時
  // Scenario: 時間経過に合わせて保存日時を更新する
  // Given: 保存直後の日時をステータスバーへ設定する
  // When: 1分経過させて表示を更新する
  // Then: 「たった今」から「1分前」へ変わる
  it("Scenario: 経過時間に合わせて保存日時を更新する", () => {
    vi.useFakeTimers();
    try {
      const now = Date.UTC(2026, 0, 1, 0, 0, 0);
      vi.setSystemTime(now);
      const { host, fileStatusbar } = mount();
      const modified = host.querySelector<HTMLElement>("#st-modified")!;

      fileStatusbar.setModifiedAt(now);
      expect(modified.textContent).toBe("保存: たった今");

      vi.setSystemTime(now + 60 * 1000);
      fileStatusbar.refreshModifiedAt();
      expect(modified.textContent).toBe("保存: 1分前");
    } finally {
      vi.useRealTimers();
    }
  });
});
