// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import * as api from "./api";
import { ExternalWatch, type ExternalWatchPorts } from "./external-watch";

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
  new ExternalWatch(banner, ports, api);
  return { banner, ports };
}

describe("ExternalWatch", () => {
  it("再読込失敗時は未解決の競合バナーを戻す", async () => {
    const { banner, ports } = fixture();
    vi.spyOn(api, "reloadFromDisk").mockRejectedValueOnce(new Error("locked"));

    banner.querySelector<HTMLButtonElement>("#external-reload")!.click();
    await vi.waitFor(() => expect(ports.onError).toHaveBeenCalledOnce());

    expect(banner.hidden).toBe(false);
  });
});
