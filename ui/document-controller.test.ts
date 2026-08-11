import { describe, expect, it, vi } from "vitest";
import * as api from "./api";
import type { DocInfo } from "./api";
import {
  DocumentController,
  type DocumentControllerServices,
  type DocumentView,
} from "./document-controller";
import { fileNameOf } from "./memo-name";
import { formatTitleBar } from "./format";
import { isPasswordCancelled, withArchivePassword } from "./archive-password";
import { confirmSaveDiscard, promptFields } from "./prompt";
import * as saveFormat from "./save-format";
import { showError } from "./dialogs";

vi.mock("./prompt", async (importOriginal) => ({
  ...await importOriginal<typeof import("./prompt")>(),
  confirmSaveDiscard: vi.fn(),
}));
vi.mock("./dialogs", () => ({ showError: vi.fn(async () => {}) }));

function services(): DocumentControllerServices {
  return {
    api,
    showError,
    confirmSaveDiscard,
    promptFields,
    promptSaveFormat: (current) => saveFormat.promptSaveFormat(current),
    saveFormatFields: saveFormat.saveFormatFields,
    saveFormatFromValues: saveFormat.saveFormatFromValues,
    isPasswordCancelled,
    withArchivePassword,
  };
}

const info = (overrides: Partial<DocInfo> = {}): DocInfo => ({
  kind: "text",
  line_count: 42,
  enc: "sjis",
  eol: "lf",
  path: "C:\\work\\memo.txt",
  entries: null,
  folder_entries: null,
  folder_root: null,
  view_only: false,
  is_binary: false,
  byte_len: 1234,
  is_huge: false,
  modified_at: 1720000000000,
  ...overrides,
});

function fakeView() {
  const view = {
    editor: {
      open: vi.fn(),
      setExternalFilePath: vi.fn(),
      focus: vi.fn(),
      goTo: vi.fn(),
      captureViewState: vi.fn(() => ({
        anchor: { line: 0, col: 0 },
        caret: { line: 0, col: 0 },
        topLine: 0,
        wrapIntraLinePx: 0,
        scrollLeft: 0,
      })),
      restoreViewState: vi.fn(async () => {}),
    },
  statusbar: { setFormat: vi.fn(), setByteSize: vi.fn(), setModifiedAt: vi.fn(), setLineCount: vi.fn() },
    addressbar: { render: vi.fn() },
    sidebar: {
      setWorkspaceSearch: vi.fn(),
      setArchiveEntries: vi.fn(),
      setArchiveRoot: vi.fn(),
      setEntries: vi.fn(),
      selectByRelPath: vi.fn(),
    },
    setSidebar: vi.fn(),
    setLoading: vi.fn(),
    setTitle: vi.fn(),
    onDocumentChange: vi.fn(),
    onSessionChange: vi.fn(),
    hideExternalBanner: vi.fn(),
    pickSavePath: vi.fn(async (): Promise<string | null> => null),
  } satisfies DocumentView;
  return { view, controller: new DocumentController(view, services()) };
}

describe("Feature: DocumentController", () => {
  // Given: `openPath` mockが`info()`を返すDocumentController
  // When: `controller.openPath("C:\\work\\memo.txt")`
  // Then: trueを返し、mockが同じpathで呼ばれる
  it("Scenario: uses the injected document API boundary", async () => {
    const { view } = fakeView();
    const openPath = vi.fn().mockResolvedValue(info());
    const controller = new DocumentController(view, {
      ...services(),
      api: { ...api, openPath },
    });

    expect(await controller.openPath("C:\\work\\memo.txt")).toBe(true);
    expect(openPath).toHaveBeenCalledWith("C:\\work\\memo.txt");
  });

  // Given: first.txtとsecond.txtのopen結果が未解決
  // When: 両方を開き、firstの結果を先に解決してからsecondを解決
  // Then: firstはfalse、secondはtrue、current.savePathは`C:\\work\\second.txt`
  it("Scenario: 捨てた古い読込結果で後から開いた文書を上書きしない", async () => {
    const { controller } = fakeView();
    let resolveFirst!: (value: DocInfo) => void;
    let resolveSecond!: (value: DocInfo) => void;
    vi.spyOn(api, "openPath").mockImplementation((path) => new Promise((resolve) => {
      if (path.endsWith("first.txt")) resolveFirst = resolve;
      else resolveSecond = resolve;
    }));

    const first = controller.openPath("C:\\work\\first.txt", false);
    const second = controller.openPath("C:\\work\\second.txt", false);
    resolveFirst(info({ path: "C:\\work\\first.txt" }));
    expect(await first).toBe(false);
    resolveSecond(info({ path: "C:\\work\\second.txt" }));

    expect(await second).toBe(true);
    expect(controller.current.savePath).toBe("C:\\work\\second.txt");
  });

  // Feature: 非同期文書操作の世代管理
  // Scenario: 新規文書作成中に別の文書を開く
  // Given: newDocとopenPathの結果が未解決
  // When: newFileを開始してからopenPathを完了する
  // Then: 古いnewFileの結果で現在の文書を上書きしない
  it("Scenario: 新規文書作成中に開いた文書を古い結果で上書きしない", async () => {
    let resolveNewDoc!: () => void;
    const newDoc = vi.fn(() => new Promise<void>((resolve) => { resolveNewDoc = resolve; }));
    const openPath = vi.fn().mockResolvedValue(info({ path: "C:\\work\\opened.txt" }));
    const { view } = fakeView();
    const raceController = new DocumentController(view, {
      ...services(),
      api: { ...api, newDoc, openPath },
    });

    const creating = raceController.newFile(false);
    const opening = raceController.openPath("C:\\work\\opened.txt", false);
    expect(await opening).toBe(true);
    resolveNewDoc();
    await creating;

    expect(raceController.current.savePath).toBe("C:\\work\\opened.txt");
  });

  // Feature: 新規メモ入力
  // Scenario: 新規メモの名前・拡張子・保存形式を入力する
  // Given: promptFieldsが名前と拡張子と保存形式を返す
  // When: promptMemoSpecを呼ぶ
  // Then: 名前をtrimしてMemoCreationSpecへ変換し、拡張子と保存形式の候補を共有する
  it("Scenario: 新規メモの入力項目を共通定義から組み立てる", async () => {
    const { view } = fakeView();
    const promptFieldsMock = vi.fn(async (..._args: Parameters<typeof promptFields>) => [" memo ", "md", "sjis", "lf"]);
    const controller = new DocumentController(view, { ...services(), promptFields: promptFieldsMock });

    await expect(controller.promptMemoSpec()).resolves.toEqual({
      memo: { stem: "memo", extension: "md" },
      format: { encoding: "sjis", eol: "lf" },
    });
    expect(promptFieldsMock).toHaveBeenCalledOnce();
    expect(promptFieldsMock.mock.calls[0][0]).toBe("新規メモ作成");
    expect(promptFieldsMock.mock.calls[0][1]).toEqual(expect.arrayContaining([
      expect.objectContaining({ label: "ファイル名", value: "memo" }),
      expect.objectContaining({ label: "拡張子", value: "txt" }),
      expect.objectContaining({ label: "文字コード", value: "utf8" }),
      expect.objectContaining({ label: "改行コード", value: "crlf" }),
    ]));
    expect(promptFieldsMock.mock.calls[0][2]).toEqual({});
  });

  // Feature: 新規メモ名の初期採番
  // Scenario: ダイアログ表示前に空き名を確定し、拡張子変更時に再計算する
  // Given: `memo.txt`が存在し、`nextMemoPath`が初期値`memo1.txt`と変更後`memo.md`を返す
  // When: フォルダを指定して`promptMemoSpec`を呼ぶ
  // Then: ダイアログ初期値は`memo1`、拡張子変更後は`memo`になる
  it("Scenario: ダイアログ表示時に採番し拡張子変更で再計算する", async () => {
    const { view } = fakeView();
    const nextMemoPath = vi.spyOn(api, "nextMemoPath")
      .mockResolvedValueOnce("C:\\work\\memo1.txt")
      .mockResolvedValueOnce("C:\\work\\memo.md");
    const promptFieldsMock = vi.fn(async (
      _title: string,
      fields: Parameters<typeof promptFields>[1],
    ) => {
      expect(fields[0].value).toBe("memo1");
      const setValue = (index: number, value: string) => { fields[index].value = value; };
      await fields[1].onChange?.("md", ["memo1", "md"], setValue);
      expect(fields[0].value).toBe("memo");
      return ["memo", "md", "utf8", "crlf"];
    });
    const controller = new DocumentController(view, { ...services(), promptFields: promptFieldsMock });

    await expect(controller.promptMemoSpec("C:\\work")).resolves.toEqual({
      memo: { stem: "memo", extension: "md" },
      format: { encoding: "utf8", eol: "crlf" },
    });
    expect(nextMemoPath).toHaveBeenNthCalledWith(1, "C:\\work", "memo", "txt");
    expect(nextMemoPath).toHaveBeenNthCalledWith(2, "C:\\work", "memo", "md");
  });

  // Feature: 無題メモの既定保存先
  // Scenario: 下書き保存先を保存ダイアログの既定ファイルへ反映する
  // Given: 新規文書の下書き保存先がデスクトップ
  // When: 無題文書を保存する
  // Then: memo.txtの既定パスがデスクトップ配下になる
  it("Scenario: 無題メモの既定保存先を保存ダイアログへ渡す", async () => {
    const { view } = fakeView();
    const newDoc = vi.fn(async () => {});
    const promptFieldsMock = vi.fn(async (..._args: Parameters<typeof promptFields>) => [
      "memo", "txt", "utf8", "crlf",
    ]);
    const saveFile = vi.spyOn(api, "saveFile").mockResolvedValueOnce({ kind: "saved", modified_at: null });
    const controller = new DocumentController(view, {
      ...services(),
      api: { ...api, newDoc, saveFile },
      promptFields: promptFieldsMock,
    });
    await controller.newFile(false, "C:\\Users\\sample\\Desktop");
    view.pickSavePath.mockResolvedValueOnce("C:\\Users\\sample\\Desktop\\memo.txt");

    expect(await controller.saveAs()).toBe(true);
    expect(view.pickSavePath).toHaveBeenCalledWith("C:\\Users\\sample\\Desktop\\memo.txt");
  });

  // Feature: 新規メモ保存後の形式継承
  // Scenario: 上書き保存でも新規作成時の文字コードと改行コードを使う
  // Given: 新規メモをShift-JIS/LFで保存済み
  // When: 本文を編集して上書き保存する
  // Then: 2回目の保存にもShift-JIS/LFを渡す
  it("Scenario: 新規メモ保存後の上書き保存は選択形式を継承する", async () => {
    const { view } = fakeView();
    const saveFile = vi.fn(async () => ({ kind: "saved" as const, modified_at: null }));
    const promptFieldsMock = vi.fn(async (..._args: Parameters<typeof promptFields>) => [
      "memo", "txt", "sjis", "lf",
    ]);
    const controller = new DocumentController(view, {
      ...services(),
      api: { ...api, saveFile },
      promptFields: promptFieldsMock,
    });
    view.pickSavePath.mockResolvedValueOnce("C:\\work\\memo.txt");

    expect(await controller.saveAs()).toBe(true);
    controller.onEdit(2);
    expect(await controller.save()).toBe(true);

    expect(saveFile).toHaveBeenNthCalledWith(2, "C:\\work\\memo.txt", "sjis", "lf");
  });

  // Feature: フォルダ内の無題メモ保存
  // Scenario: 保存ボタンで表示する名前ダイアログに採番済み初期値を出す
  // Given: フォルダルート`C:\\work`と既存の`memo.txt`、空き名`memo1.txt`
  // When: 無題文書で`saveAs()`を呼ぶ
  // Then: ダイアログ表示前に採番され、`memo1.txt`へ保存する
  it("Scenario: 保存ボタンより前に名前を採番してダイアログへ表示する", async () => {
    const { view } = fakeView();
    const nextMemoPath = vi.spyOn(api, "nextMemoPath").mockResolvedValueOnce("C:\\work\\memo1.txt");
    vi.spyOn(api, "saveFile").mockResolvedValueOnce({ kind: "saved", modified_at: null });
    vi.spyOn(api, "listFolderEntries").mockResolvedValueOnce([]);
    const promptFieldsMock = vi.fn(async (
      _title: string,
      fields: Parameters<typeof promptFields>[1],
    ) => {
      expect(fields[0].value).toBe("memo1");
      return ["memo1", "txt", "utf8", "crlf"];
    });
    const controller = new DocumentController(view, { ...services(), promptFields: promptFieldsMock });
    controller.applyDocInfo(info({ path: "C:\\work", folder_root: "C:\\work", folder_entries: [] }));
    nextMemoPath.mockClear();

    expect(await controller.saveAs()).toBe(true);
    expect(nextMemoPath).toHaveBeenCalledTimes(1);
    expect(api.saveFile).toHaveBeenCalledWith("C:\\work\\memo1.txt", "utf8", "crlf");
  });

  // Feature: 保存用新規メモの拡張子変更
  // Scenario: 保存ダイアログで拡張子を変更した候補名をそのまま保存する
  // Given: 初期候補`memo1.txt`と、変更後候補`memo.md`が返る
  // When: フォルダ内の無題文書で拡張子を`md`へ変更して保存する
  // Then: `memo.md`へ保存し、採番を2回だけ行う
  it("Scenario: 保存ダイアログの拡張子変更を保存先へ反映する", async () => {
    const { view } = fakeView();
    const nextMemoPath = vi.spyOn(api, "nextMemoPath")
      .mockResolvedValueOnce("C:\\work\\memo1.txt")
      .mockResolvedValueOnce("C:\\work\\memo.md");
    vi.spyOn(api, "saveFile").mockResolvedValueOnce({ kind: "saved", modified_at: null });
    vi.spyOn(api, "listFolderEntries").mockResolvedValueOnce([]);
    const promptFieldsMock = vi.fn(async (
      _title: string,
      fields: Parameters<typeof promptFields>[1],
    ) => {
      const setValue = (index: number, value: string) => { fields[index].value = value; };
      await fields[1].onChange?.("md", ["memo1", "md"], setValue);
      expect(fields[0].value).toBe("memo");
      return ["memo", "md", "utf8", "crlf"];
    });
    const controller = new DocumentController(view, { ...services(), promptFields: promptFieldsMock });
    controller.applyDocInfo(info({ path: "C:\\work", folder_root: "C:\\work", folder_entries: [] }));
    nextMemoPath.mockClear();

    expect(await controller.saveAs()).toBe(true);

    expect(nextMemoPath).toHaveBeenCalledTimes(2);
    expect(api.saveFile).toHaveBeenCalledWith("C:\\work\\memo.md", "utf8", "crlf");
  });

  // Given: `info()`がpath=`C:\\work\\memo.txt`、enc=`sjis`、line_count=42、byte_len=1234
  // When: `applyDocInfo(info())`
  // Then: currentとstatusbar/addressbar/editor/titleへ各値が反映され、外部変更bannerが隠れる
  it("Scenario: reflects an opened document into every view it owns", () => {
    const { view, controller } = fakeView();
    controller.applyDocInfo(info());

    expect(controller.current.savePath).toBe("C:\\work\\memo.txt");
    expect(controller.current.sourceEncoding).toBe("sjis");
    expect(view.hideExternalBanner).toHaveBeenCalled();
    expect(view.statusbar.setByteSize).toHaveBeenCalledWith(1234, false);
    expect(view.statusbar.setLineCount).toHaveBeenCalledWith(42);
    expect(view.addressbar.render).toHaveBeenCalledWith("C:\\work\\memo.txt");
    expect(view.editor.open).toHaveBeenCalledWith(42, false, false, "C:\\work\\memo.txt", false);
    expect(view.onDocumentChange).toHaveBeenCalledWith(expect.objectContaining({ savePath: "C:\\work\\memo.txt" }), false);
    expect(view.onSessionChange).not.toHaveBeenCalled();
    expect(view.setTitle).toHaveBeenLastCalledWith(formatTitleBar("memo.txt"));
  });

  // Given: `view_only=true`かつ`is_binary=true`のDocInfo
  // When: `applyDocInfo`で文書状態を反映する
  // Then: エディタを閲覧専用で開き、ステータスにもバイナリ状態を渡す
  it("Scenario: propagates a binary document lock to the editor and status bar", () => {
    const { view, controller } = fakeView();
    controller.applyDocInfo(info({ view_only: true, is_binary: true }));

    expect(view.editor.open).toHaveBeenCalledWith(42, true, false, "C:\\work\\memo.txt", false);
    expect(view.statusbar.setFormat).toHaveBeenCalledWith(expect.objectContaining({
      isBinary: true,
      readOnly: true,
    }));
  });

  // Given: 新規文書を作るDocumentController
  // When: `newFile(false)`で文書を入れ替える
  // Then: 文書置換通知だけを1回送り、通常の状態通知は重ねない
  it("Scenario: emits one replacement notification for a new document", async () => {
    const { view } = fakeView();
    const newDoc = vi.fn(async () => {});
    const controller = new DocumentController(view, {
      ...services(),
      api: { ...api, newDoc },
    });

    await controller.newFile(false);

    expect(view.onDocumentChange).toHaveBeenCalledOnce();
    expect(view.onSessionChange).not.toHaveBeenCalled();
  });

  // Given: 文書置換通知が例外を投げるビュー
  // When: `applyDocInfo`で文書を入れ替える
  // Then: 例外を外へ出さず、通常の状態通知へフォールバックする
  it("Scenario: falls back to the session notification when replacement notification fails", () => {
    const { view, controller } = fakeView();
    view.onDocumentChange.mockImplementationOnce(() => { throw new Error("preview failed"); });

    expect(() => controller.applyDocInfo(info())).not.toThrow();
    expect(view.onSessionChange).toHaveBeenCalledWith(expect.objectContaining({
      savePath: "C:\\work\\memo.txt",
    }));
  });

  // Feature: 外部変更マージ後の文書状態
  // Scenario: マージ結果を文書コントローラへ反映する
  // Given: 保存済み文書を表示中
  // When: マージ結果を適用する
  // Then: 本文表示を更新し、未保存状態を維持する
  it("Scenario: マージ結果の反映を一つの状態更新にまとめる", () => {
    const { controller } = fakeView();
    controller.applyDocInfo(info({ line_count: 42 }));

    controller.applyMergedDocInfo(info({ line_count: 43 }));

    expect(controller.current.lineCount).toBe(43);
    expect(controller.current.dirty).toBe(true);
  });

  // Given: フォルダのDocInfoがpath=\`C:\\work\`、folder_rootも\`C:\\work\`
  // When: \`applyDocInfo\`へフォルダのDocInfoを渡す
  // Then: Editorへフォルダをファイルとして渡さず、外部ファイルパスをnullにする
  it("Scenario: 空のフォルダ表示をExplorerのファイル対象にしない", () => {
    const { view, controller } = fakeView();
    controller.applyDocInfo(info({
      path: "C:\\work",
      folder_root: "C:\\work",
      line_count: 1,
      folder_entries: [],
    }));

    expect(controller.current.savePath).toBeNull();
    expect(view.editor.open).toHaveBeenCalledWith(1, false, false, null, false);
  });

  // Given: フォルダのDocInfoがfolder_root=C:\work、選択中path=C:\work\memo.txt
  // When: applyDocInfoへ選択ファイルのDocInfoを渡す
  // Then: Editorへ選択ファイルの実パスを渡す
  it("Scenario: フォルダ内で選択したファイルをEditorへ実パスで渡す", () => {
    const { view, controller } = fakeView();
    controller.applyDocInfo(info({
      path: "C:\\work\\memo.txt",
      folder_root: "C:\\work",
    }));

    expect(view.editor.open).toHaveBeenCalledWith(42, false, false, "C:\\work\\memo.txt", false);
  });

  // Given: info適用済みでtitle mockをclear
  // When: `onEdit(43)`→`onEdit(44)`
  // Then: lineCount=44、dirty title設定は1回だけで`● memo.txt`を含む
  it("Scenario: marks the title dirty only on the first edit", () => {
    const { view, controller } = fakeView();
    controller.applyDocInfo(info());
    view.setTitle.mockClear();

    controller.onEdit(43);
    controller.onEdit(44);

    expect(controller.current.lineCount).toBe(44);
    expect(view.setTitle).toHaveBeenCalledTimes(1);
    expect(view.setTitle).toHaveBeenCalledWith(formatTitleBar("● memo.txt"));
  });

  // Given: `view_only=true`の文書
  // When: `controller.save()`
  // Then: falseを返し、`pickSavePath`は未呼出し
  it("Scenario: keeps a read-only document unsavable", async () => {
    const { view, controller } = fakeView();
    controller.applyDocInfo(info({ view_only: true }));

    expect(await controller.save()).toBe(false);
    expect(view.pickSavePath).not.toHaveBeenCalled();
  });

  // Given: 編集済み、confirmが`save`、saveFileがsaved、保存後setTitleがErrorを投げる
  // When: `confirmDiscard(proceed)`
  // Then: trueを返し、`proceed`を1回呼ぶ
  it("Scenario: continues after the file was saved even if a later view update failed", async () => {
    const { view, controller } = fakeView();
    controller.applyDocInfo(info());
    controller.onEdit(42);
    vi.mocked(confirmSaveDiscard).mockResolvedValueOnce("save");
    vi.spyOn(api, "saveFile").mockResolvedValueOnce({ kind: "saved", modified_at: null });
    view.setTitle.mockImplementation(() => { throw new Error("post-save view failure"); });
    const proceed = vi.fn();

    expect(await controller.confirmDiscard(proceed)).toBe(true);
    expect(proceed).toHaveBeenCalledOnce();
  });

  // Given: 編集済みでsaveFileが`{kind:"saved"}`を返す
  // When: `controller.save()`
  // Then: trueを返し、`setLoading`は未呼出し
  it("Scenario: 上書き保存中に全面ローディングを表示しない", async () => {
    const { view, controller } = fakeView();
    controller.applyDocInfo(info());
    controller.onEdit(42);
    vi.spyOn(api, "saveFile").mockResolvedValueOnce({ kind: "saved", modified_at: null });
    view.setLoading.mockClear();

    expect(await controller.save()).toBe(true);
    expect(view.setLoading).not.toHaveBeenCalled();
  });

  // Feature: 保存日時の表示
  // Scenario: 保存結果がバックエンドの更新日時を持つ
  // Given: 編集済み文書と保存成功結果
  // When: `controller.save()`を呼ぶ
  // Then: 受け取った更新日時をステータスバーへ表示する
  it("Scenario: 保存結果の更新日時をステータスバーへ反映する", async () => {
    const { view, controller } = fakeView();
    controller.applyDocInfo(info());
    controller.onEdit(42);
    const savedAt = 1730000000000;
    vi.spyOn(api, "saveFile").mockResolvedValueOnce({ kind: "saved", modified_at: savedAt });

    expect(await controller.save()).toBe(true);
    expect(view.statusbar.setModifiedAt).toHaveBeenLastCalledWith(savedAt);
  });

  // Given: 保存結果が「保存済みだが再読込警告」を返す
  // When: `controller.save()`を呼ぶ
  // Then: dirtyを解除して保存成功とし、警告だけを通知する
  it("Scenario: 保存後の再読込失敗を保存失敗と混同しない", async () => {
    const { controller } = fakeView();
    controller.applyDocInfo(info());
    controller.onEdit(42);
    vi.mocked(showError).mockClear();
    vi.spyOn(api, "saveFile").mockResolvedValueOnce({
        kind: "savedwithwarning",
      warning: "再読込できませんでした",
      modified_at: null,
    });

    expect(await controller.save()).toBe(true);
    expect(controller.current.dirty).toBe(false);
    expect(showError).toHaveBeenCalledWith("保存後の再読込に失敗しました", "再読込できませんでした");
  });

  // Given: C:\work\memo.txtを表示中で、別名保存先がC:\new\memo.txt
  // When: 別名保存を成功させる
  // Then: EditorのExplorer対象も新しい保存先へ同期する
  it("Scenario: 別名保存後にEditorのExplorer対象を新パスへ同期する", async () => {
    const { view, controller } = fakeView();
    controller.applyDocInfo(info());
    view.pickSavePath.mockResolvedValueOnce("C:\\new\\memo.txt");
    vi.spyOn(saveFormat, "promptSaveFormat").mockResolvedValueOnce({ encoding: "utf8", eol: "lf" });
    vi.spyOn(api, "saveFile").mockResolvedValueOnce({ kind: "saved", modified_at: null });

    expect(await controller.saveAs()).toBe(true);
    expect(view.editor.setExternalFilePath).toHaveBeenLastCalledWith("C:\\new\\memo.txt", false);
  });

  // Given: アーカイブ内エントリを表示中で、別名保存先が通常ファイル
  // When: 別名保存を成功させる
  // Then: 新しい通常ファイルへ移った後はアーカイブ選択状態を残さない
  it("Scenario: アーカイブ内エントリの別名保存でプレビュー対象を通常ファイルへ切り替える", async () => {
    const { view, controller } = fakeView();
    controller.setSelectedRelPath("docs/readme.md");
    controller.applyDocInfo(info({ path: "C:\\work\\data.zip", folder_root: null, kind: "archive" }));
    view.pickSavePath.mockResolvedValueOnce("C:\\new\\readme.md");
    vi.spyOn(saveFormat, "promptSaveFormat").mockResolvedValueOnce({ encoding: "utf8", eol: "lf" });
    vi.spyOn(api, "saveFile").mockResolvedValueOnce({ kind: "saved", modified_at: null });

    expect(await controller.saveAs()).toBe(true);
    expect(controller.current.selectedRelPath).toBe("");
    expect(controller.current.archivePath).toBeNull();
    expect(controller.current.archiveEntry).toBeNull();
  });

  // Given: 編集可能なアーカイブ内エントリを表示している
  // When: 同じアーカイブへ上書き保存する
  // Then: アーカイブのプレビュー文脈を保持する
  it("Scenario: アーカイブ内エントリの上書き保存では文脈を保持する", async () => {
    const { view, controller } = fakeView();
    controller.setSelectedRelPath("docs/readme.md");
    controller.applyDocInfo(info({ path: "C:\\work\\data.zip", folder_root: null, kind: "archive" }));
    controller.onEdit(4);
    vi.spyOn(api, "saveFile").mockResolvedValueOnce({ kind: "saved", modified_at: null });

    expect(view.editor.open).toHaveBeenCalledWith(42, false, false, "C:\\work\\data.zip", true);
    expect(await controller.save()).toBe(true);
    expect(controller.current.archivePath).toBe("C:\\work\\data.zip");
    expect(controller.current.archiveEntry).toBe("docs/readme.md");
    expect(view.editor.setExternalFilePath).toHaveBeenCalledWith("C:\\work\\data.zip", true);
  });

  // Given: C:\work\memo.txtを表示中
  // When: 現在の文書がrenamed.txtへ改名される
  // Then: EditorのExplorer対象も改名後の実パスへ同期する
  it("Scenario: リネーム後にEditorのExplorer対象を新パスへ同期する", () => {
    const { view, controller } = fakeView();
    controller.applyDocInfo(info());
    view.editor.setExternalFilePath.mockClear();

    controller.applyRenamed(info({
      path: "C:\\work\\renamed.txt",
      folder_root: "C:\\work",
    }), "renamed.txt");

    expect(view.editor.setExternalFilePath).toHaveBeenCalledWith("C:\\work\\renamed.txt", false);
  });

  // Given: 元文書のencoding=`sjis`/eol=`lf`、別名path選択、保存形式がutf8/crlf、saveFileが失敗
  // When: `controller.saveAs()`
  // Then: falseを返し、current.encoding/eolは`s​​jis`/`lf`のまま
  it("Scenario: 別名保存失敗後に選択した文字コードを元文書へ持ち越さない", async () => {
    const { view, controller } = fakeView();
    controller.applyDocInfo(info({ enc: "sjis", eol: "lf" }));
    view.pickSavePath.mockResolvedValueOnce("C:\\readonly\\memo.txt");
    vi.spyOn(saveFormat, "promptSaveFormat").mockResolvedValueOnce({
      encoding: "utf8",
      eol: "crlf",
    });
    vi.spyOn(api, "saveFile").mockRejectedValueOnce(new Error("denied"));

    expect(await controller.saveAs()).toBe(false);
    expect(controller.current.encoding).toBe("sjis");
    expect(controller.current.eol).toBe("lf");
  });

  // Given: selectedRelPath=`before.txt`で、`selectEntry("missing.txt")`がErrorを投げる
  // When: `controller.selectEntry`を呼ぶ
  // Then: false、選択状態は`before.txt`、`showError("開けませんでした", Error)`、loading=false
  it("Scenario: エントリ選択失敗時は既存の選択状態を保つ", async () => {
    const { view, controller } = fakeView();
    controller.setSelectedRelPath("before.txt");
    vi.spyOn(api, "selectEntry").mockRejectedValueOnce(new Error("missing"));

    expect(await controller.selectEntry("missing.txt")).toBe(false);
    expect(controller.current.selectedRelPath).toBe("before.txt");
    expect(showError).toHaveBeenCalledWith("開けませんでした", expect.any(Error));
    expect(view.setLoading).toHaveBeenLastCalledWith(false);
  });
});

describe("Feature: fileNameOf", () => {
  // Given: stem=`memo`でextensionが`txt`または空文字
  // When: `fileNameOf`を呼ぶ
  // Then: `"memo.txt"`または`"memo"`
  it("Scenario: omits the dot when no extension was chosen", () => {
    expect(fileNameOf({ stem: "memo", extension: "txt" })).toBe("memo.txt");
    expect(fileNameOf({ stem: "memo", extension: "" })).toBe("memo");
  });
});
