// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import { scheduleMarkdownImageLoads } from "./viewer-markdown-images";

function image(name: string): HTMLImageElement {
  const element = document.createElement("img");
  element.dataset.name = name;
  return element;
}

describe("Feature: Markdown画像の限定並列取得", () => {
  // Given: 5枚のMarkdown画像と、同時実行数を観測できる読込処理
  // When: Markdown画像の取得スケジューラを開始する
  // Then: 同時実行数は3件を超えず、1枚の失敗後も後続画像を取得する
  it("Scenario: 画像取得を3件に制限し、失敗した画像を越えて継続する", async () => {
    const images = ["one", "two", "three", "four", "five"].map(image);
    const pending: Array<() => void> = [];
    let active = 0;
    let maximum = 0;
    const loaded: string[] = [];

    const loading = scheduleMarkdownImageLoads(images, async (target) => {
      active += 1;
      maximum = Math.max(maximum, active);
      await new Promise<void>((resolve) => pending.push(resolve));
      active -= 1;
      const name = target.dataset.name!;
      if (name === "two") throw new Error("broken image");
      loaded.push(name);
    });

    await vi.waitFor(() => expect(pending).toHaveLength(3));
    expect(maximum).toBe(3);
    expect(loaded).toEqual([]);

    for (let released = 0; released < images.length; released += 1) {
      await vi.waitFor(() => expect(pending.length).toBeGreaterThan(0));
      pending.shift()!();
    }
    await loading;

    expect(maximum).toBe(3);
    expect(loaded).toEqual(["one", "three", "four", "five"]);
  });
});
