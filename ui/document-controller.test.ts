import { describe, expect, it, vi } from "vitest";
import * as api from "./api";
import type { DocInfo } from "./api";
import {
  DocumentController,
  fileNameOf,
  type DocumentControllerServices,
  type DocumentView,
} from "./document-controller";
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
  byte_len: 1234,
  is_huge: false,
  ...overrides,
});

function fakeView() {
  const view = {
    editor: {
      open: vi.fn(),
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
    statusbar: { setFormat: vi.fn(), setByteSize: vi.fn(), setLineCount: vi.fn() },
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
    notify: vi.fn(),
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
  // Scenario: 新規メモの名前と拡張子を入力する
  // Given: promptFieldsが名前と拡張子を返す
  // When: promptMemoSpecを呼ぶ
  // Then: 名前をtrimしてMemoSpecへ変換し、拡張子候補を共有する
  it("Scenario: 新規メモの入力項目を共通定義から組み立てる", async () => {
    const { view } = fakeView();
    const promptFieldsMock = vi.fn(async () => [" memo ", "md"]);
    const controller = new DocumentController(view, { ...services(), promptFields: promptFieldsMock });

    await expect(controller.promptMemoSpec()).resolves.toEqual({ stem: "memo", extension: "md" });
    expect(promptFieldsMock).toHaveBeenCalledWith("新規メモ作成", expect.arrayContaining([
      expect.objectContaining({ label: "ファイル名", value: "memo" }),
      expect.objectContaining({ label: "拡張子", value: "txt" }),
    ]));
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
    expect(view.editor.open).toHaveBeenCalledWith(42, false, false);
    expect(view.setTitle).toHaveBeenLastCalledWith(formatTitleBar("memo.txt"));
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
    vi.spyOn(api, "saveFile").mockResolvedValueOnce({ kind: "saved" });
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
    vi.spyOn(api, "saveFile").mockResolvedValueOnce({ kind: "saved" });
    view.setLoading.mockClear();

    expect(await controller.save()).toBe(true);
    expect(view.setLoading).not.toHaveBeenCalled();
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
