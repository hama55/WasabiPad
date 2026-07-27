import { describe, expect, it } from "vitest";
import { resolveAssetPath } from "./viewer-assets";

const SOURCE = "C:\\work\\docs\\readme.md";

describe("resolveAssetPath", () => {
  it("相対パスは元ファイルの位置から解決する", () => {
    expect(resolveAssetPath(SOURCE, "assets/shot.png")).toBe("C:\\work\\docs\\assets\\shot.png");
    expect(resolveAssetPath(SOURCE, "../img/shot.png")).toBe("C:\\work\\img\\shot.png");
    expect(resolveAssetPath(SOURCE, "./shot.png")).toBe("C:\\work\\docs\\shot.png");
  });

  it("パーセントエンコードを実パスへ戻す", () => {
    expect(resolveAssetPath(SOURCE, "assets/%E5%9B%B3%201.png")).toBe("C:\\work\\docs\\assets\\図 1.png");
  });

  it("URL・絶対パス・元ファイル不明は触らない", () => {
    expect(resolveAssetPath(SOURCE, "https://example.com/a.png")).toBeNull();
    expect(resolveAssetPath(SOURCE, "data:image/png;base64,AAAA")).toBeNull();
    expect(resolveAssetPath(null, "assets/shot.png")).toBeNull();
    expect(resolveAssetPath(null, "D:/pic/shot.png")).toBe("D:\\pic\\shot.png");
  });
});
