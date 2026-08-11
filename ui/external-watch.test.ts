// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import * as api from "./api";
import { ExternalWatch, type ExternalWatchPorts } from "./external-watch";

let active: ExternalWatch | undefined;

function fixture() {
  const banner = document.createElement("div");
  banner.hidden = false;
  for (const id of ["external-reload", "external-ignore"]) {
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
  const watch = (active = new ExternalWatch(banner, ports, api));
  return { banner, ports, watch };
}

describe("Feature: ExternalWatch", () => {
  afterEach(() => {
    active?.dispose();
    active = undefined;
    vi.restoreAllMocks();
    vi.useRealTimers();
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
      byte_len: 99,
      is_huge: false,
      modified_at: 1730000000000,
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
    });
    expect(banner.hidden).toBe(true);
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
});
