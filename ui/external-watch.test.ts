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
  const ports = {
    canPoll: () => false,
    isDirty: () => true,
    onReload: vi.fn(),
    onNotice: vi.fn(),
    onError: vi.fn(async () => {}),
    onIgnore: vi.fn(),
  } satisfies ExternalWatchPorts;
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
});
