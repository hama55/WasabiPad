// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import { createGitPreviewController } from "./viewer-git";
import type { GitHistory } from "./api";

const commitA = "a".repeat(40);
const commitB = "b".repeat(40);
function history(ids = [commitA], branch: string | null = "main"): GitHistory {
  return { head: ids[0] ?? null, branch, commits: ids.map(oid => ({ oid, author: "Author", date: "2026-10-04T12:00:00+09:00", message: oid === commitA ? "first" : "second" })), hasMore: false };
}
function mount(overrides: Partial<Parameters<typeof createGitPreviewController>[3]> = {}, restored?: Parameters<typeof createGitPreviewController>[4]) {
  const host = document.createElement("div");
  const ports = {
    history: vi.fn(async () => history()),
    files: vi.fn(async () => [{ path: "one.txt", oldPath: null, status: "M" }, { path: "two.txt", oldPath: null, status: "A" }]),
    diff: vi.fn(async (_path: string, _commit: string, file: string) => ({ text: `+${file}\n`, binary: false, truncated: false })),
    getRatio: () => 0.4, saveRatio: vi.fn(), onState: vi.fn(), ...overrides,
  };
  const controller = createGitPreviewController(host, document.createElement("span"), "C:/repo/.git", ports, restored);
  return { host, ports, controller };
}
const fileButton = (host: HTMLElement, file: string) => host.querySelector<HTMLButtonElement>(`button[data-file="${file}"]`)!;

describe("Feature: Git履歴プレビュー画面", () => {
  // Given: 履歴更新が完了していない
  // When: 旧一覧のファイルを選ぼうとする
  // Then: 更新中は一覧を操作不可にし、完了後に再開する
  it("Scenario: 更新中の旧一覧の操作を抑止する", async () => {
    let resolve!: (value: GitHistory) => void;
    const { host, ports, controller } = mount();
    await controller.load();
    vi.mocked(ports.history).mockImplementationOnce(() => new Promise(done => { resolve = done; }));
    const updating = controller.refresh();
    expect(host.querySelector(".git-commits")!.hasAttribute("inert")).toBe(true);
    fileButton(host, "two.txt").click();
    expect(ports.diff).toHaveBeenCalledTimes(1);
    resolve(history());
    await updating;
    expect(host.querySelector(".git-commits")!.hasAttribute("inert")).toBe(false);
    controller.dispose();
  });
  // Given: 100件目を選択していて同じブランチへ新しいコミットが追加された
  // When: 更新で選択コミットが101件目へ移る
  // Then: 次ページも読み込み選択を保持する
  it("Scenario: 更新で次ページへ移った選択コミットを保持する", async () => {
    const ids = Array.from({ length: 100 }, (_, index) => (index + 1).toString(16).padStart(40, "0"));
    const selected = ids[99];
    const read = vi.fn(async (_path: string, _head: string | null, offset: number) => ({ ...history(offset ? [selected] : [commitA, ...ids.slice(0, 99)]), head: commitA, hasMore: offset === 0 }));
    const { host, controller } = mount({ history: read }, { head: ids[0], branch: "main", count: 100, expanded: [selected], commit: selected, file: "two.txt", historyScroll: 0, diffScroll: 0 });
    await controller.refresh();
    expect(read).toHaveBeenLastCalledWith("C:/repo/.git", commitA, 100);
    expect(host.querySelector<HTMLButtonElement>('button[aria-pressed="true"]')!.dataset.commit).toBe(selected);
    controller.dispose();
  });
  // Given: 100件を超える履歴
  // When: 追加読込後に101件目を選び、タブを復帰する
  // Then: 固定HEADで続きを読み、101件目の展開と選択を復元する
  it("Scenario: 追加読込と101件目のタブ復帰を扱う", async () => {
    const ids = Array.from({ length: 101 }, (_, index) => (index + 1).toString(16).padStart(40, "0"));
    const read = vi.fn(async (_path: string, _head: string | null, offset: number) => ({ ...history(ids.slice(offset, offset + 100)), head: ids[0], hasMore: offset === 0 }));
    const first = mount({ history: read });
    await first.controller.load();
    first.host.querySelector<HTMLButtonElement>('[data-action="git-more"]')!.click();
    await vi.waitFor(() => expect(first.host.querySelectorAll("details[data-commit]")).toHaveLength(101));
    expect(read).toHaveBeenLastCalledWith("C:/repo/.git", ids[0], 100);
    const details = first.host.querySelector<HTMLDetailsElement>(`details[data-commit="${ids[100]}"]`)!;
    details.open = true;
    details.dispatchEvent(new Event("toggle"));
    await vi.waitFor(() => expect(details.querySelector("button[data-file]")).not.toBeNull());
    details.querySelector<HTMLButtonElement>('button[data-file="two.txt"]')!.click();
    await vi.waitFor(() => expect(first.host.querySelector(".git-diff")?.textContent).toContain("+two.txt"));
    first.controller.dispose();
    const state = vi.mocked(first.ports.onState).mock.calls.at(-1)![0];
    const restored = mount({ history: read }, state);
    await restored.controller.load();
    const selected = restored.host.querySelector<HTMLButtonElement>('button[aria-pressed="true"]')!;
    expect(selected.dataset.commit).toBe(ids[100]);
    expect(selected.dataset.file).toBe("two.txt");
    expect(restored.host.querySelectorAll("details[data-commit]")).toHaveLength(101);
    restored.controller.dispose();
  });
  // Given: ファイル差分を読取中のプレビュー
  // When: 閉じてから読取が完了し、再び開く
  // Then: 閉じた後の結果を反映せず、再表示で選択ファイルを読み直す
  it("Scenario: 閉じると読取を失効し再表示で閲覧を再開する", async () => {
    let resolve!: (value: { text: string; binary: boolean; truncated: boolean }) => void;
    let pending = false;
    const { host, controller } = mount({ diff: async () => pending ? new Promise(done => { resolve = done; }) : { text: "+current", binary: false, truncated: false } });
    await controller.load();
    pending = true;
    fileButton(host, "two.txt").click();
    controller.setVisible(false);
    resolve({ text: "+late result", binary: false, truncated: false });
    await Promise.resolve();
    expect(host.querySelector(".git-diff")!.textContent).not.toContain("+late result");
    pending = false;
    controller.setVisible(true);
    await vi.waitFor(() => expect(host.querySelector(".git-diff")!.textContent).toContain("+current"));
    expect(fileButton(host, "two.txt").getAttribute("aria-pressed")).toBe("true");
    controller.dispose();
  });
  // Given: 複数コミットと選択済み差分
  // When: 別コミットを展開・折りたたみする
  // Then: 複数を展開でき下段の差分はファイル選択まで変わらない
  it("Scenario: コミット展開だけでは差分を切り替えない", async () => {
    const { host, controller } = mount({ history: async () => history([commitA, commitB]) });
    await controller.load();
    const previous = host.querySelector(".git-diff")!.textContent;
    const details = host.querySelector<HTMLDetailsElement>(`details[data-commit="${commitB}"]`)!;
    details.open = true;
    details.dispatchEvent(new Event("toggle"));
    await vi.waitFor(() => expect(details.querySelector("button[data-file]")).not.toBeNull());
    expect(host.querySelector<HTMLDetailsElement>(`details[data-commit="${commitA}"]`)!.open).toBe(true);
    details.open = false;
    details.dispatchEvent(new Event("toggle"));
    expect(host.querySelector(".git-diff")!.textContent).toBe(previous);
    controller.dispose();
  });

  // Given: 二番目の変更ファイルを選択しスクロールした画面
  // When: 更新し、さらに保存された状態でタブを復帰する
  // Then: 同一ブランチでは選択・展開・スクロールを保持する
  it("Scenario: 更新とタブ復帰で閲覧状態を保持する", async () => {
    const { host, ports, controller } = mount();
    await controller.load();
    fileButton(host, "two.txt").click();
    await vi.waitFor(() => expect(host.querySelector(".git-diff")!.textContent).toContain("+two.txt"));
    const upper = host.querySelector<HTMLElement>(".git-history")!;
    const lower = host.querySelector<HTMLElement>(".git-diff")!;
    upper.scrollTop = 75;
    lower.scrollTop = 120;
    upper.dispatchEvent(new Event("scroll"));
    lower.dispatchEvent(new Event("scroll"));
    await controller.refresh();
    expect(fileButton(host, "two.txt").getAttribute("aria-pressed")).toBe("true");
    expect(upper.scrollTop).toBe(75);
    expect(lower.scrollTop).toBe(120);
    controller.dispose();
    const saved = vi.mocked(ports.onState).mock.calls.at(-1)![0];
    const restored = mount({}, saved);
    await restored.controller.load();
    expect(fileButton(restored.host, "two.txt").getAttribute("aria-pressed")).toBe("true");
    expect(restored.host.querySelector<HTMLElement>(".git-diff")!.scrollTop).toBe(120);
    restored.controller.dispose();
  });

  // Given: 履歴を表示したあと別ブランチへ切り替わる
  // When: 更新する
  // Then: 新ブランチの先頭コミットと最初のファイルへ切り替える
  it("Scenario: ブランチ変更は先頭の選択へ戻す", async () => {
    let current = history();
    const { host, controller } = mount({ history: async () => current });
    await controller.load();
    fileButton(host, "two.txt").click();
    await vi.waitFor(() => expect(fileButton(host, "two.txt").getAttribute("aria-pressed")).toBe("true"));
    current = history([commitB], "other");
    await controller.refresh();
    expect(host.querySelector(".git-history")!.textContent).toContain("other");
    expect(fileButton(host, "one.txt").dataset.commit).toBe(commitB);
    expect(fileButton(host, "one.txt").getAttribute("aria-pressed")).toBe("true");
    controller.dispose();
  });

  // Given: 別ファイルの差分読取が遅れている
  // When: ファイルを再選択して古い読取が最後に完了する
  // Then: 最後に選んだファイルの差分が維持される
  it("Scenario: 連続選択で古い差分を反映しない", async () => {
    let resolveOld!: (value: { text: string; binary: boolean; truncated: boolean }) => void;
    let delay = false;
    const { host, controller } = mount({ diff: async (_path, _commit, file) => delay && file === "one.txt"
      ? new Promise(resolve => { resolveOld = resolve; }) : { text: `+${file}`, binary: false, truncated: false } });
    await controller.load();
    delay = true;
    fileButton(host, "one.txt").click();
    fileButton(host, "two.txt").click();
    await vi.waitFor(() => expect(host.querySelector(".git-diff")!.textContent).toContain("+two.txt"));
    resolveOld({ text: "+old", binary: false, truncated: false });
    await Promise.resolve();
    expect(host.querySelector(".git-diff")!.textContent).not.toContain("+old");
    controller.dispose();
  });

  // Given: 閲覧中のバイナリ・大きな差分・空履歴・Git未導入
  // When: 表示を要求する
  // Then: 内容を推測せず理由または省略を明示する
  it("Scenario: バイナリ・省略・空・エラーを明示する", async () => {
    const binary = mount({ diff: async () => ({ text: "Binary files", binary: true, truncated: false }) });
    await binary.controller.load();
    expect(binary.host.textContent).toContain("バイナリファイルが変更");
    binary.controller.dispose();
    const large = mount({ diff: async () => ({ text: "+some", binary: false, truncated: true }) });
    await large.controller.load();
    expect(large.host.textContent).toContain("差分の一部を省略");
    large.controller.dispose();
    const empty = mount({ history: async () => history([]) });
    await empty.controller.load();
    expect(empty.host.textContent).toContain("コミットがありません");
    empty.controller.dispose();
    const missing = mount({ history: async () => { throw new Error("Git が見つかりません"); } });
    await missing.controller.load();
    expect(missing.host.querySelector("[role=alert]")!.textContent).toContain("Git が見つかりません");
    missing.controller.dispose();
  });

  // Given: 上40%の上下分割
  // When: 境界をキーボードで下へ移動する
  // Then: 比率を調整して保存する
  it("Scenario: 分割位置はキーボードでも調整して保存できる", () => {
    const { host, ports, controller } = mount();
    host.querySelector("[role=separator]")!.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true }));
    expect(ports.saveRatio).toHaveBeenCalledWith(0.45);
    expect(host.querySelector("[role=separator]")!.getAttribute("aria-valuenow")).toBe("45");
    controller.dispose();
  });
  // Given: mainの履歴と変更ファイルがある
  // When: Gitプレビューを開く
  // Then: 上段にブランチと最新コミットを展開し下段に最初の差分を表示する
  it("Scenario: 初回は最新コミットの最初の変更ファイルを上下分割で表示する", async () => {
    const host = document.createElement("div");
    const controller = createGitPreviewController(host, document.createElement("span"), "C:/repo/.git", {
      history: async () => ({ head: "a".repeat(40), branch: "main", commits: [{ oid: "a".repeat(40), author: "Author", date: "2026-10-04T12:00:00+09:00", message: "first" }], hasMore: false }),
      files: async () => [{ path: "note.txt", oldPath: null, status: "A" }],
      diff: async () => ({ text: "@@ -0,0 +1 @@\n+hello\n", binary: false, truncated: false }),
      getRatio: () => 0.4, saveRatio: vi.fn(), onState: vi.fn(),
    });
    await controller.load();
    expect(host.querySelector(".git-history")?.textContent).toContain("main");
    expect(host.querySelector<HTMLDetailsElement>("details[data-commit]")?.open).toBe(true);
    expect(host.querySelector(".git-diff")?.textContent).toContain("+hello");
    expect(host.querySelector(".git-diff .git-added")?.textContent).toBe("+hello\n");
    expect(host.querySelector("[role=separator]")).not.toBeNull();
    controller.dispose();
  });
});
