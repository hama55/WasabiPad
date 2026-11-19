// @vitest-environment jsdom
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import viewerHtml from "../viewer.html?raw";
import { INLINE_PREVIEW_MESSAGES as messages } from "./inline-preview-protocol";
import { installDomStubs } from "./test-doubles";
import { encodeCsvDelimiters } from "./viewer-delimiter";

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(async () => "{}"),
  convertFileSrc: (path: string) => path,
}));
installDomStubs();

function send(data: Record<string, unknown>) {
  window.dispatchEvent(new MessageEvent("message", {
    source: window.parent, origin: window.location.origin, data,
  }));
}

describe("Feature: CSVプレビューのセル操作", () => {
  const text = "name,value\nA," + "long".repeat(60);

  beforeAll(async () => {
    document.documentElement.innerHTML = viewerHtml.replace(/<!doctype html>/i, "");
    window.history.replaceState(null, "", "/viewer.html?inline=1");
    await import("./viewer");
    send({
      type: messages.PAYLOAD_MESSAGE, csv_edit_token: 7,
      payload: {
        format: "csv", text, selection: null, source_path: "C:\\work\\data.csv",
        effective_extension: null, archive_path: null, archive_entry: null,
      },
    });
    send({ type: messages.CSV_EDIT_STATE_MESSAGE, editable: true });
  });
  afterAll(() => window.dispatchEvent(new Event("beforeunload")));

  it("Scenario: 長いセルを含む表の列幅をプレビュー幅に合わせる", () => {
    // Given: 320pxのプレビューに長いセルがある
    const content = document.querySelector<HTMLElement>("#viewer-content")!;
    Object.defineProperty(content, "clientWidth", { value: 320, configurable: true });
    const button = document.querySelector<HTMLButtonElement>('[data-viewer-action="auto-width"]')!;
    // When: 幅を自動調整する
    expect(button.hidden).toBe(false);
    button.click();
    // Then: 全列が収まり、長いセルの元の値は残る
    const table = content.querySelector("table")!;
    expect(table.style.width).toBe("320px");
    expect(table.rows[1].cells[2].textContent).toBe("long".repeat(60));
  });

  it("Scenario: 選んだセルの全文を表示し、EscとEnterを使える", () => {
    // Given: 長いセルを選択する
    document.querySelector<HTMLTableCellElement>("tbody tr:nth-child(2) td:last-child")!.click();
    const field = document.querySelector<HTMLTextAreaElement>("#viewer-csv-cell-editor")!;
    expect(field.value).toBe("long".repeat(60));
    expect(field.readOnly).toBe(false);
    const post = vi.spyOn(window.parent, "postMessage");
    const key = (key: string) => field.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true }));
    // When: 値を入力しても、Escなら取り消せる
    field.value = "discard";
    key("Escape");
    expect(field.value).toBe("long".repeat(60));
    expect(post).not.toHaveBeenCalled();
    // Then: Enterなら区切り文字を含む値を引用して確定する
    field.value = "new,value";
    key("Enter");
    expect(post).toHaveBeenCalledWith(expect.objectContaining({
      type: messages.CSV_EDIT_MESSAGE, token: 7, line: 1, start: 2, end: 242, text: '"new,value"',
    }), window.location.origin);
    post.mockRestore();
  });

  it("Scenario: 区切り変更後も確定したセルの値を保持する", async () => {
    // Given: エディタに確定した値にカンマが含まれる
    send({
      type: messages.PAYLOAD_MESSAGE, csv_edit_token: 8,
      payload: {
        format: "csv", text: 'name,value\nA,"new,value"', selection: null,
        source_path: "C:\\work\\data.csv", effective_extension: null, archive_path: null, archive_entry: null,
      },
    });
    await Promise.resolve();
    // When: カンマとタブを有効にする
    send({ type: messages.DELIMITER_MESSAGE, delimiter: encodeCsvDelimiters([",", "\\t"]) });
    // Then: 確定した値はひとつのセルに表示される
    await vi.waitFor(() => {
      const cell = document.querySelector("tbody tr:nth-child(2) td:last-child");
      expect(cell?.textContent).toBe("new,value");
    });
  });
});
