import { describe, expect, it, vi } from "vitest";
import type { DocInfo } from "./api";
import { DocumentController, fileNameOf, type DocumentView } from "./document-controller";

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
    pickSavePath: vi.fn(async () => null),
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
    expect(view.statusbar.setByteSize).toHaveBeenCalledWith(1234);
    expect(view.statusbar.setLineCount).toHaveBeenCalledWith(42);
    expect(view.addressbar.render).toHaveBeenCalledWith("C:\\work\\memo.txt");
    expect(view.editor.open).toHaveBeenCalledWith(42, false, false);
    expect(view.setTitle).toHaveBeenLastCalledWith("memo.txt — WasabiPad");
  });

  it("marks the title dirty only on the first edit", () => {
    const { view, controller } = fakeView();
    controller.applyDocInfo(info());
    view.setTitle.mockClear();

    controller.onEdit(43);
    controller.onEdit(44);

    expect(controller.current.lineCount).toBe(44);
    expect(view.setTitle).toHaveBeenCalledTimes(1);
    expect(view.setTitle).toHaveBeenCalledWith("● memo.txt — WasabiPad");
  });

  it("keeps a read-only document unsavable", async () => {
    const { view, controller } = fakeView();
    controller.applyDocInfo(info({ view_only: true }));

    expect(await controller.save()).toBe(false);
    expect(view.pickSavePath).not.toHaveBeenCalled();
  });
});

describe("fileNameOf", () => {
  it("omits the dot when no extension was chosen", () => {
    expect(fileNameOf({ stem: "memo", extension: "txt" })).toBe("memo.txt");
    expect(fileNameOf({ stem: "memo", extension: "" })).toBe("memo");
  });
});
