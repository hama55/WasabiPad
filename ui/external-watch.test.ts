// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import * as api from "./api";
import {
  canPollExternalDocument,
  ExternalWatch,
  type ExternalMergePreviewSubscription,
  type ExternalWatchPorts,
} from "./external-watch";
import { initialSession } from "./session";

let active: ExternalWatch | undefined;

function fixture() {
  const banner = document.createElement("div");
  banner.hidden = false;
  for (const id of ["external-reload", "external-ignore", "external-review"]) {
    const button = document.createElement("button");
    button.id = id;
    banner.appendChild(button);
  }
  const ports: ExternalWatchPorts = {
    canPoll: () => false,
    isDirty: () => true,
    onReload: vi.fn(),
    onNotice: vi.fn(),
    onError: vi.fn(async () => {}),
    onIgnore: vi.fn(),
    onConflict: undefined,
  };
  const watch = new ExternalWatch(banner, ports, api);
  active = watch;
  return { banner, ports, watch };
}

describe("Feature: ExternalWatch", () => {
  afterEach(() => {
    active?.dispose();
    active = undefined;
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  // Given: 保存先を持たない直接開きのPNG/PDFとアーカイブ内PDF
  // When: 外部更新をポーリングできるか判定する
  // Then: 直接開きの資産だけを監視し、アーカイブ内エントリは監視しない
  it("Scenario: polls read-only asset files for external updates", () => {
    expect(canPollExternalDocument({
      ...initialSession(),
      displayPath: "C:\\work\\picture.png",
    })).toBe(true);
    expect(canPollExternalDocument({
      ...initialSession(),
      displayPath: "C:\\work\\manual.pdf",
    })).toBe(true);
    expect(canPollExternalDocument({
      ...initialSession(),
      displayPath: "C:\\work\\archive.zip",
      selectedRelPath: "manual.pdf",
      archivePath: "C:\\work\\archive.zip",
    })).toBe(false);
  });

  // Given: bannerが表示中、reload/ignoreボタン、isDirty=true、reloadFromDiskが`Error("locked")`でreject
  // When: reloadボタンをクリック
  // Then: `onError`が1回呼ばれ、bannerは表示状態のまま
  it("Scenario: 再読込失敗時は未解決の競合バナーを戻す", async () => {
    const { banner, ports } = fixture();
    vi.spyOn(api, "reloadFromDisk").mockRejectedValueOnce(new Error("locked"));

    banner.querySelector<HTMLButtonElement>("#external-reload")!.click();
    await vi.waitFor(() => expect(ports.onError).toHaveBeenCalledOnce());

    expect(banner.hidden).toBe(false);
  });

  // Given: bannerが表示中、ackExternalが最新DocInfoを返す
  // When: 「無視」ボタンをクリックする
  // Then: 最新DocInfoを反映ポートへ渡し、bannerを閉じる
  it("Scenario: 外部変更を無視すると最新のファイル情報を渡す", async () => {
    const { banner, ports } = fixture();
    const acknowledged = {
      kind: "text" as const,
      line_count: 1,
      enc: "utf8" as const,
      eol: "lf" as const,
      path: "C:\\work\\memo.txt",
      entries: null,
      folder_entries: null,
      folder_root: null,
      view_only: false,
      is_binary: false,
      byte_len: 99,
      is_huge: false,
      modified_at: 1730000000000,
      effective_extension: null,
    } satisfies api.DocInfo;
    vi.spyOn(api, "ackExternal").mockResolvedValueOnce(acknowledged);

    banner.querySelector<HTMLButtonElement>("#external-ignore")!.click();
    await vi.waitFor(() => expect(ports.onIgnore).toHaveBeenCalledOnce());

    expect(ports.onIgnore).toHaveBeenCalledWith(acknowledged);
    expect(banner.hidden).toBe(true);
  });

  // Given: 外部変更監視が作成され、定期ポーリングのintervalが登録されている
  // When: dispose()してから1周期分の時間を進める
  // Then: ポーリングもボタンのイベント処理も残らない
  it("Scenario: dispose時に外部監視の後始末をする", async () => {
    vi.useFakeTimers();
    const { banner, watch } = fixture();
    const poll = vi.spyOn(api, "pollExternal");

    watch.dispose();
    await vi.advanceTimersByTimeAsync(3000);
    banner.querySelector<HTMLButtonElement>("#external-reload")!.click();

    expect(poll).not.toHaveBeenCalled();
  });

  // Given: dirtyな文書で外部変更が検知され、差分プレビューAPIが値を返す
  // When: 外部変更のポーリング周期を進める
  // Then: バナーではなくマージ確認ポートへプレビューを渡す
  it("Scenario: 競合時にマージ確認を開く", async () => {
    vi.useFakeTimers();
    const { banner, ports } = fixture();
    banner.hidden = true;
    ports.canPoll = () => true;
    ports.onConflict = vi.fn(async () => true);
    vi.spyOn(api, "pollExternal").mockResolvedValueOnce({ kind: "conflict" });
    vi.spyOn(api, "externalMergePreview").mockResolvedValueOnce({
      changes: [],
      conflict_count: 0,
    });

    await vi.advanceTimersByTimeAsync(3000);

    expect(ports.onConflict).toHaveBeenCalledWith({
      changes: [],
      conflict_count: 0,
    }, expect.any(Function));
    expect(banner.hidden).toBe(true);
  });

  // Given: F5相当の明示更新を行える外部監視と、外部変更による再読込結果
  // When: refresh()を呼ぶ
  // Then: バナー表示中でも外部ファイルを確認し、再読込結果を反映する
  it("Scenario: 明示更新で外部ファイルを確認する", async () => {
    const { banner, ports, watch } = fixture();
    banner.hidden = false;
    ports.canPoll = () => true;
    const info = { kind: "text" as const } as api.DocInfo;
    vi.spyOn(api, "pollExternal").mockResolvedValueOnce({ kind: "reloaded", info });

    await watch.refresh();

    expect(api.pollExternal).toHaveBeenCalledWith(true);
    expect(ports.onReload).toHaveBeenCalledWith(info);
  });

  // Given: 競合確認中に外部ファイルが再変更され、onConflictがretryを返す
  // When: 外部変更のポーリング周期を進める
  // Then: 最新プレビューを取り直してから確認画面を続ける
  it("Scenario: マージ中の外部再変更で最新プレビューを再表示する", async () => {
    vi.useFakeTimers();
    const { banner, ports, watch } = fixture();
    banner.hidden = true;
    ports.canPoll = () => true;
    ports.onConflict = vi.fn()
      .mockResolvedValueOnce("retry" as const)
      .mockResolvedValueOnce(true);
    const first = { changes: [], conflict_count: 0 };
    const second = {
      changes: [{
        start_line: 4,
        mine_start_line: 4,
        theirs_start_line: 4,
        before: [],
        mine: ["mine"],
        theirs: ["new"],
        after: [],
        conflict: true,
      }],
      conflict_count: 1,
    };
    vi.spyOn(api, "pollExternal").mockResolvedValueOnce({ kind: "conflict" });
    vi.spyOn(api, "externalMergePreview")
      .mockResolvedValueOnce(first)
      .mockResolvedValueOnce(second);

    await vi.advanceTimersByTimeAsync(3000);

    expect(ports.onConflict).toHaveBeenNthCalledWith(1, first, expect.any(Function));
    expect(ports.onConflict).toHaveBeenNthCalledWith(2, second, expect.any(Function));
    expect(banner.hidden).toBe(true);
    watch.dispose();
  });

  // Given: dirtyな文書で外部変更が検知され、差分プレビューAPIが失敗する
  // When: 外部変更のポーリング周期を進める
  // Then: エラーを通知し、未解決のバナーを表示する
  it("Scenario: 差分プレビュー失敗時は競合バナーを戻す", async () => {
    vi.useFakeTimers();
    const { banner, ports } = fixture();
    banner.hidden = true;
    ports.canPoll = () => true;
    ports.onConflict = vi.fn(async () => false);
    vi.spyOn(api, "pollExternal").mockResolvedValueOnce({ kind: "conflict" });
    vi.spyOn(api, "externalMergePreview").mockRejectedValueOnce(new Error("read failed"));

    await vi.advanceTimersByTimeAsync(3000);

    expect(ports.onError).toHaveBeenCalledWith(
      "外部変更を確認できませんでした",
      expect.any(Error),
    );
    expect(banner.hidden).toBe(false);
  });

  // Given: 競合バナーが表示中で、差分プレビューとマージ確認ポートが利用できる
  // When: 「差分を確認」をクリックして確認画面をキャンセルする
  // Then: 最新プレビューを確認画面へ渡し、再び3つの選択肢を持つバナーを表示する
  it("Scenario: バナーから差分確認を開きキャンセルすると戻る", async () => {
    const { banner, ports } = fixture();
    banner.hidden = false;
    ports.canPoll = () => true;
    const preview = { changes: [], conflict_count: 0 };
    ports.onConflict = vi.fn(async () => false);
    vi.spyOn(api, "externalMergePreview").mockResolvedValueOnce(preview);

    banner.querySelector<HTMLButtonElement>("#external-review")!.click();
    await vi.waitFor(() => expect(ports.onConflict).toHaveBeenCalledOnce());

    expect(ports.onConflict).toHaveBeenCalledWith(preview, expect.any(Function));
    expect(banner.hidden).toBe(false);
    expect(banner.querySelector("#external-review")).not.toBeNull();
  });

  // Given: 差分確認画面が開いており、最新プレビューを受け取る購読が登録されている
  // When: 確認画面の表示中に外部変更のポーリング周期を進める
  // Then: 新しいプレビューを取得し、同じ確認画面の更新リスナーへ渡す
  it("Scenario: マージ画面を開いたまま外部変更を検知して更新する", async () => {
    vi.useFakeTimers();
    const { banner, ports } = fixture();
    banner.hidden = true;
    ports.canPoll = () => true;
    let observed: api.ExternalMergePreview | undefined;
    let finish!: () => void;
    const initial = { changes: [], conflict_count: 0 };
    const latest = { changes: [], conflict_count: 1 };
    ports.onConflict = vi.fn(async (_preview, subscribe: ExternalMergePreviewSubscription) => {
      subscribe((preview) => { observed = preview; });
      return new Promise<boolean>((resolve) => { finish = () => resolve(true); });
    });
    vi.spyOn(api, "pollExternal")
      .mockResolvedValueOnce({ kind: "conflict" })
      .mockResolvedValueOnce({ kind: "conflict" });
    vi.spyOn(api, "externalMergePreview")
      .mockResolvedValueOnce(initial)
      .mockResolvedValueOnce(latest);

    await vi.advanceTimersByTimeAsync(3000);
    await vi.advanceTimersByTimeAsync(3000);

    expect(api.pollExternal).toHaveBeenCalledTimes(2);
    expect(api.externalMergePreview).toHaveBeenCalledTimes(2);
    expect(observed).toBe(latest);
    finish();
    await vi.waitFor(() => expect(banner.hidden).toBe(true));
  });

  // Given: マージ画面の表示中に外部監視タイマーが動作している
  // When: 文書切替相当のhide()を呼んでから時間を進める
  // Then: 表示中のマージ監視も停止し、古い文書へのポーリングを続けない
  it("Scenario: 文書切替時にマージ中の外部監視を停止する", async () => {
    vi.useFakeTimers();
    const { banner, ports, watch } = fixture();
    banner.hidden = true;
    ports.canPoll = () => true;
    let finish!: () => void;
    ports.onConflict = vi.fn(async (_preview, _subscribe: ExternalMergePreviewSubscription) => {
      return new Promise<boolean>((resolve) => { finish = () => resolve(true); });
    });
    const poll = vi.spyOn(api, "pollExternal").mockResolvedValueOnce({ kind: "conflict" });
    vi.spyOn(api, "externalMergePreview").mockResolvedValueOnce({ changes: [], conflict_count: 0 });

    await vi.advanceTimersByTimeAsync(3000);
    watch.hide();
    await vi.advanceTimersByTimeAsync(6000);

    expect(poll).toHaveBeenCalledOnce();
    finish();
  });

  // Given: 外部ポーリングAPIが応答待ちのまま文書切替が発生する
  // When: 古い文書のポーリングがエラーで終了する
  // Then: 現在の文書へ古いエラーを通知しない
  it("Scenario: 文書切替後の旧ポーリングエラーを通知しない", async () => {
    vi.useFakeTimers();
    const { banner, ports, watch } = fixture();
    banner.hidden = true;
    ports.canPoll = () => true;
    let rejectPoll!: (error: Error) => void;
    vi.spyOn(api, "pollExternal").mockImplementationOnce(() => new Promise((_resolve, reject) => {
      rejectPoll = reject;
    }));

    await vi.advanceTimersByTimeAsync(3000);
    watch.hide();
    rejectPoll(new Error("old document"));
    await Promise.resolve();

    expect(ports.onError).not.toHaveBeenCalled();
  });
});
