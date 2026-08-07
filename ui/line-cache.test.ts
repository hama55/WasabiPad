import { describe, expect, it } from "vitest";
import { fakeDocument } from "./test-doubles";
import { CHUNK, LineCache } from "./line-cache";

const document20 = () => fakeDocument(Array.from({ length: 20 }, (_, i) => `line${i}`).join("\n"));

describe("Feature: LineCache", () => {
  // Given: `fakeDocument`がline0〜line19を持つ
  // When: `cache.line(0)`→`cache.line(5)`
  // Then: `"line0"`、`"line5"`、backendの`lines(0,512)`は1回だけ
  it("Scenario: 同じチャンクは一度だけ取りに行く", async () => {
    const doc = document20();
    const cache = new LineCache(doc.client);
    expect(await cache.line(0)).toBe("line0");
    expect(await cache.line(5)).toBe("line5");
    expect(doc.calls.filter((call) => call.startsWith("lines("))).toEqual([`lines(0,${CHUNK})`]);
  });

  // Given: 未取得のcacheでpeek(3)後、chunk0をfetch
  // When: peek→fetch→peek→clear→peek
  // Then: undefined→`"line3"`→undefined
  it("Scenario: 取得前は peek が undefined、取得後は同期で返る", async () => {
    const doc = document20();
    const cache = new LineCache(doc.client);
    expect(cache.peek(3)).toBeUndefined();
    await cache.fetch(0);
    expect(cache.peek(3)).toBe("line3");
    cache.clear();
    expect(cache.peek(3)).toBeUndefined();
  });

  // Given: chunk0の初回取得が未完了で、同じchunkの後続取得が始まっている
  // When: 後続のline(1)が解決するまで待つ
  // Then: 初回取得の完了後に行を返し、未取得の空文字を返さない
  it("Scenario: 取得中の同じチャンクを後続の行取得も待つ", async () => {
    const doc = document20();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const originalLines = doc.client.lines;
    doc.client.lines = async (...args) => {
      await gate;
      return originalLines(...args);
    };
    const cache = new LineCache(doc.client);

    const first = cache.fetch(0);
    const second = cache.line(1);
    await Promise.resolve();
    expect(cache.peek(1)).toBeUndefined();

    release();
    await first;
    await expect(second).resolves.toBe("line1");
  });

  // Given: 3×CHUNK行の文書でchunk0/chunk2をfetch
  // When: `invalidateFrom(CHUNK*2+1)`
  // Then: chunk0は残り、chunk2は破棄
  it("Scenario: 編集位置以降のチャンクだけを捨てる", async () => {
    const doc = fakeDocument(Array.from({ length: CHUNK * 3 }, (_, i) => `l${i}`).join("\n"));
    const cache = new LineCache(doc.client);
    await cache.fetch(0);
    await cache.fetch(2);
    cache.invalidateFrom(CHUNK * 2 + 1);
    expect(cache.has(0)).toBe(true);
    expect(cache.has(2)).toBe(false);
  });

  // Given: `"abcd"`をchunk0へfetch済み
  // When: `{0,1}`〜`{0,3}`を`"漢字"`で編集
  // Then: trueを返し、peek(0)は`"a漢字d"`
  it("Scenario: 改行なし編集は取得済み行へ局所反映する", async () => {
    const cache = new LineCache(fakeDocument("abcd").client);
    await cache.fetch(0);

    expect(cache.applySingleLineEdit(
      { line: 0, col: 1 },
      { line: 0, col: 3 },
      "漢字",
    )).toBe(true);
    expect(cache.peek(0)).toBe("a漢字d");
  });

  // Given: line0〜line19の文書でline1が未取得
  // When: fetch前後に`lineLength(1)`
  // Then: どちらも5
  it("Scenario: 未取得行の長さは backend へ問い合わせる", async () => {
    const doc = document20();
    const cache = new LineCache(doc.client);
    expect(await cache.lineLength(1)).toBe(5);
    await cache.fetch(0);
    expect(await cache.lineLength(1)).toBe(5);
  });

  // Given: 文書が`abcd\nefgh\nijkl`
  // When: range `{0,2}`→`{2,2}`と`{1,1}`→`{1,3}`を取得
  // Then: `"cd\nefgh\nij"`、`"fg"`
  it("Scenario: 範囲テキストは行境界をまたいで連結する", async () => {
    const doc = fakeDocument("abcd\nefgh\nijkl");
    const cache = new LineCache(doc.client);
    expect(await cache.textInRange({ line: 0, col: 2 }, { line: 2, col: 2 })).toBe("cd\nefgh\nij");
    expect(await cache.textInRange({ line: 1, col: 1 }, { line: 1, col: 3 })).toBe("fg");
  });

  // Given: 初回lines取得がpendingの`oldLines`、clear後の取得が`["new"]`
  // When: old fetch開始→clear→new fetch→old解決
  // Then: cache.peek(0)は`"new"`のまま
  it("Scenario: 文書切替前の遅い取得結果を新しいキャッシュへ混入させない", async () => {
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

  // Feature: 編集中の行キャッシュ無効化
  // Scenario: 編集対象チャンクの取得中に再取得を開始する
  // Given: 古いlines取得が未解決
  // When: invalidateFrom後に同じチャンクをfetchする
  // Then: 古い取得結果で新しいキャッシュを上書きしない
  it("Scenario: 無効化中のチャンク取得結果を新しい取得へ混入させない", async () => {
    const doc = fakeDocument();
    let resolveOld!: (lines: string[]) => void;
    const oldLines = new Promise<string[]>((resolve) => { resolveOld = resolve; });
    let call = 0;
    doc.client.lines = async () => call++ === 0 ? oldLines : ["new"];
    const cache = new LineCache(doc.client);

    const oldFetch = cache.fetch(0);
    cache.invalidateFrom(0);
    await cache.fetch(0);
    resolveOld(["old"]);
    await oldFetch;

    expect(cache.peek(0)).toBe("new");
  });
});
