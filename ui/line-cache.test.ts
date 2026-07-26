import { describe, expect, it } from "vitest";
import { fakeDocument } from "./test-doubles";
import { CHUNK, LineCache } from "./line-cache";

const document20 = () => fakeDocument(Array.from({ length: 20 }, (_, i) => `line${i}`).join("\n"));

describe("LineCache", () => {
  it("同じチャンクは一度だけ取りに行く", async () => {
    const doc = document20();
    const cache = new LineCache(doc.client);
    expect(await cache.line(0)).toBe("line0");
    expect(await cache.line(5)).toBe("line5");
    expect(doc.calls.filter((call) => call.startsWith("lines("))).toEqual([`lines(0,${CHUNK})`]);
  });

  it("取得前は peek が undefined、取得後は同期で返る", async () => {
    const doc = document20();
    const cache = new LineCache(doc.client);
    expect(cache.peek(3)).toBeUndefined();
    await cache.fetch(0);
    expect(cache.peek(3)).toBe("line3");
    cache.clear();
    expect(cache.peek(3)).toBeUndefined();
  });

  it("編集位置以降のチャンクだけを捨てる", async () => {
    const doc = fakeDocument(Array.from({ length: CHUNK * 3 }, (_, i) => `l${i}`).join("\n"));
    const cache = new LineCache(doc.client);
    await cache.fetch(0);
    await cache.fetch(2);
    cache.invalidateFrom(CHUNK * 2 + 1);
    expect(cache.has(0)).toBe(true);
    expect(cache.has(2)).toBe(false);
  });

  it("未取得行の長さは backend へ問い合わせる", async () => {
    const doc = document20();
    const cache = new LineCache(doc.client);
    expect(await cache.lineLength(1)).toBe(5);
    await cache.fetch(0);
    expect(await cache.lineLength(1)).toBe(5);
  });

  it("範囲テキストは行境界をまたいで連結する", async () => {
    const doc = fakeDocument("abcd\nefgh\nijkl");
    const cache = new LineCache(doc.client);
    expect(await cache.textInRange({ line: 0, col: 2 }, { line: 2, col: 2 })).toBe("cd\nefgh\nij");
    expect(await cache.textInRange({ line: 1, col: 1 }, { line: 1, col: 3 })).toBe("fg");
  });

  it("文書切替前の遅い取得結果を新しいキャッシュへ混入させない", async () => {
    const doc = fakeDocument();
    let resolveOld!: (lines: string[]) => void;
    const oldLines = new Promise<string[]>((resolve) => { resolveOld = resolve; });
    let call = 0;
    doc.client.lines = async () => call++ === 0 ? oldLines : ["new"];
    const cache = new LineCache(doc.client);

    const oldFetch = cache.fetch(0);
    cache.clear();
    await cache.fetch(0);
    resolveOld(["old"]);
    await oldFetch;

    expect(cache.peek(0)).toBe("new");
  });
});
