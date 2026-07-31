import { describe, expect, it, vi } from "vitest";
import * as api from "./api";
import type { DocInfo } from "./api";
import { DocumentController, fileNameOf, type DocumentView } from "./document-controller";
import { formatTitleBar } from "./format";
import { confirmSaveDiscard } from "./prompt";
import * as saveFormat from "./save-format";
import { showError } from "./dialogs";

vi.mock("./prompt", async (importOriginal) => ({
  ...await importOriginal<typeof import("./prompt")>(),
  confirmSaveDiscard: vi.fn(),
}));
vi.mock("./dialogs", () => ({ showError: vi.fn(async () => {}) }));

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

// DocumentView は実装ではなく必要な操作だけを要求するため、素のオブジェクトで足りる
function fakeView() {
  const view = {
    editor: { open: vi.fn(), focus: vi.fn() },
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
  };
  return { view, controller: new DocumentController(view as unknown as DocumentView) };
}

describe("DocumentController", () => {
  it("reflects an opened document into every view it owns", () => {
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

  it("marks the title dirty only on the first edit", () => {
    const { view, controller } = fakeView();
    controller.applyDocInfo(info());
    view.setTitle.mockClear();

    controller.onEdit(43);
    controller.onEdit(44);

    expect(controller.current.lineCount).toBe(44);
    expect(view.setTitle).toHaveBeenCalledTimes(1);
    expect(view.setTitle).toHaveBeenCalledWith(formatTitleBar("● memo.txt"));
  });

  it("keeps a read-only document unsavable", async () => {
    const { view, controller } = fakeView();
    controller.applyDocInfo(info({ view_only: true }));

    expect(await controller.save()).toBe(false);
    expect(view.pickSavePath).not.toHaveBeenCalled();
  });

  it("continues after the file was saved even if a later view update failed", async () => {
    const { controller } = fakeView();
    controller.applyDocInfo(info());
    controller.onEdit(42);
    vi.mocked(confirmSaveDiscard).mockResolvedValueOnce("save");
    vi.spyOn(controller, "save").mockImplementation(async () => {
      controller.current.dirty = false;
      throw new Error("post-save view failure");
    });
    const proceed = vi.fn();

    expect(await controller.confirmDiscard(proceed)).toBe(true);
    expect(proceed).toHaveBeenCalledOnce();
  });

  it("上書き保存中に全面ローディングを表示しない", async () => {
    const { view, controller } = fakeView();
    controller.applyDocInfo(info());
    controller.onEdit(42);
    vi.spyOn(api, "saveFile").mockResolvedValueOnce({ kind: "saved" });
    view.setLoading.mockClear();

    expect(await controller.save()).toBe(true);
    expect(view.setLoading).not.toHaveBeenCalled();
  });

  it("別名保存失敗後に選択した文字コードを元文書へ持ち越さない", async () => {
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

  it("エントリ選択失敗時は既存の選択状態を保つ", async () => {
    const { view, controller } = fakeView();
    controller.current.selectedRelPath = "before.txt";
    vi.spyOn(api, "selectEntry").mockRejectedValueOnce(new Error("missing"));

    expect(await controller.selectEntry("missing.txt")).toBe(false);
    expect(controller.current.selectedRelPath).toBe("before.txt");
    expect(showError).toHaveBeenCalledWith("開けませんでした", expect.any(Error));
    expect(view.setLoading).toHaveBeenLastCalledWith(false);
  });
});

describe("fileNameOf", () => {
  it("omits the dot when no extension was chosen", () => {
    expect(fileNameOf({ stem: "memo", extension: "txt" })).toBe("memo.txt");
    expect(fileNameOf({ stem: "memo", extension: "" })).toBe("memo");
  });
});
