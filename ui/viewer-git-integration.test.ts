// @vitest-environment jsdom
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import viewerHtml from "../viewer.html?raw";
import { INLINE_PREVIEW_MESSAGES as messages } from "./inline-preview-protocol";
import type { ViewerPayload } from "./api";
import { installDomStubs } from "./test-doubles";

const { invoke } = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke, convertFileSrc: (path: string) => path }));
installDomStubs();
const oid = "a".repeat(40);
function send(data: unknown) {
  window.dispatchEvent(new MessageEvent("message", { source: window.parent, origin: window.location.origin, data }));
}
const payload: ViewerPayload = {
  format: "git", text: JSON.stringify({ token: "git-owner", state: null }), selection: null,
  source_path: "C:/repo/.git", effective_extension: null, archive_path: null, archive_entry: null, external_output_path: null,
};
async function open() {
  send({ type: messages.PAYLOAD_MESSAGE, payload });
  await vi.waitFor(() => expect(document.querySelector(".git-diff")?.textContent).toContain("+hello"));
}

describe("Feature: Git標準プレビューの通知経路", () => {
  beforeAll(async () => {
    invoke.mockImplementation(async (command: string) => {
      switch (command) {
        case "read_git_branches":
        case "read_git_worktree_files": return [];
        case "read_git_history": return { head: oid, branch: "main", commits: [{ oid, author: "Author", date: "2026-10-04T12:00:00+09:00", message: "first" }], hasMore: false };
        case "read_git_files": return [{ path: "note.txt", oldPath: null, status: "A" }];
        case "read_git_diff": return { text: "+hello\n", binary: false, truncated: false };
        default: return "{}";
      }
    });
    document.documentElement.innerHTML = viewerHtml.replace(/<!doctype html>/i, "");
    window.history.replaceState(null, "", "/viewer.html?inline=1");
    await import("./viewer");
  });
  afterAll(() => { window.dispatchEvent(new Event("beforeunload")); vi.restoreAllMocks(); });

  // Given: コミット内の変更ファイルが表示されている
  // When: 右クリックして新規タブで開くを選ぶ
  // Then: 現在のファイルを開く要求が親へ届く
  it("Scenario: 変更ファイルの右クリックから新規タブ要求を送る", async () => {
    await open();
    const post = vi.spyOn(window.parent, "postMessage");
    document.querySelector('button[data-file="note.txt"]')!.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: 25, clientY: 25 }));
    const menu = document.querySelector<HTMLButtonElement>("#viewer-context-menu button")!;
    expect(menu.textContent).toContain("新規タブで開く");
    menu.click();
    expect(post).toHaveBeenCalledWith({ type: messages.GIT_OPEN_FILE_MESSAGE, token: "git-owner", path: "C:/repo/.git", commit: oid, file: "note.txt" }, window.location.origin);
  });

  // Given: 共通プレビューの標準表示と外部生成の処理状態
  // When: 標準を開き、外部の生成中・失敗・解除の通知を受ける
  // Then: タイトル左端の種別ラベルを方式に合わせて表示する
  it("Scenario: 標準と外部の種別をタイトルに表示する", async () => {
    await open();
    expect(document.querySelector("#viewer-preview-kind")?.textContent).toBe("標準プレビュー");
    send({ type: messages.EXTERNAL_STATUS_MESSAGE, status: { busy: true, message: "生成中" } });
    expect(document.querySelector("#viewer-preview-kind")?.textContent).toBe("外部プレビュー");
    send({ type: messages.EXTERNAL_STATUS_MESSAGE, status: { busy: false, message: "失敗" } });
    expect(document.querySelector("#viewer-preview-kind")?.textContent).toBe("外部プレビュー");
    send({ type: messages.EXTERNAL_STATUS_MESSAGE, status: null });
    expect(document.querySelector("#viewer-preview-kind")?.textContent).toBe("標準プレビュー");
  });

  // Given: 実際のviewerにGit用payloadが届く
  // When: 表示と全画面切替を行う
  // Then: 全画面でも同じDOMと選択を維持する
  it("Scenario: 全画面切替で現在の表示を維持する", async () => {
    await open();
    const root = document.querySelector(".git-preview");
    send({ type: messages.FULLSCREEN_STATE_MESSAGE, fullscreen: true });
    expect(document.querySelector(".git-preview")).toBe(root);
    expect(document.querySelector("button[data-file]")!.getAttribute("aria-pressed")).toBe("true");
  });

  // Given: Git履歴と共通の更新ボタン
  // When: 更新要求が親へ渡り、親から更新通知が届く
  // Then: Git履歴を再取得する
  it("Scenario: 共通更新操作はGit履歴を再取得する", async () => {
    await open();
    const post = vi.spyOn(window.parent, "postMessage");
    const refresh = document.querySelector<HTMLButtonElement>("#viewer-refresh")!;
    expect(refresh.hidden).toBe(false);
    expect(refresh.getAttribute("aria-label")).toBe("Git履歴を更新");
    refresh.click();
    expect(post).toHaveBeenCalledWith({ type: messages.REFRESH_MESSAGE }, window.location.origin);
    invoke.mockClear();
    send({ type: messages.REFRESH_MESSAGE });
    await vi.waitFor(() => expect(invoke).toHaveBeenCalledWith("read_git_history", { path: "C:/repo/.git", head: null, offset: 0 }));
    await vi.waitFor(() => expect(document.querySelector(".git-diff")?.textContent).toContain("+hello"));
  });

  // Given: Git履歴を表示している
  // When: 通常文書のpayloadを開き、消去通知を受ける
  // Then: Git画面を解除し、通常Markdownと共通消去へ戻る
  it("Scenario: 通常文書への復帰と消去でGit画面を解放する", async () => {
    await open();
    send({ type: messages.PAYLOAD_MESSAGE, payload: { ...payload, format: "markdown", text: "# regular", source_path: "C:/repo/note.md" } });
    await vi.waitFor(() => expect(document.querySelector("article")?.textContent).toContain("regular"));
    expect(document.querySelector(".git-preview")).toBeNull();
    await vi.waitFor(() => expect(document.querySelector<HTMLButtonElement>("#viewer-refresh")!.hidden).toBe(true));
    send({ type: messages.CLEAR_MESSAGE, render_id: "git-clear" });
    expect(document.querySelector("#viewer-content")!.childElementCount).toBe(0);
  });
});
