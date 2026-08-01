import { describe, expect, it, vi, beforeEach } from "vitest";
import { promptFields } from "./prompt";
import * as api from "./api";
import {
  archiveRelOf,
  isPasswordCancelled,
  withArchivePassword,
} from "./archive-password";

vi.mock("./prompt", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./prompt")>()),
  promptFields: vi.fn(),
}));
vi.mock("./api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./api")>()),
  setArchivePassword: vi.fn(async () => {}),
}));

const prompt = vi.mocked(promptFields);
const setPassword = vi.mocked(api.setArchivePassword);

beforeEach(() => {
  prompt.mockReset();
  setPassword.mockClear();
});

describe("withArchivePassword", () => {
  it("パスワード無関係の成功と失敗はそのまま素通しする", async () => {
    await expect(withArchivePassword("", async () => 42)).resolves.toBe(42);
    await expect(
      withArchivePassword("", async () => {
        throw new Error("no entries");
      })
    ).rejects.toThrow("no entries");
    expect(prompt).not.toHaveBeenCalled();
  });

  it("パスワード要求 → 入力 → 記憶 → 再試行で成功する", async () => {
    prompt.mockResolvedValueOnce(["secret"]);
    let attempt = 0;
    const result = await withArchivePassword("sub/data.7z", async () => {
      attempt += 1;
      if (attempt === 1) throw new Error("7z-password:required");
      return "ok";
    });
    expect(result).toBe("ok");
    expect(setPassword).toHaveBeenCalledWith("sub/data.7z", "secret");
    expect(prompt.mock.calls[0][0]).toBe("パスワード付きアーカイブです");
    expect(prompt.mock.calls[0][1][0].type).toBe("password");
  });

  it("誤ったパスワードは文言を変えて合うまで聞き直す", async () => {
    prompt.mockResolvedValueOnce(["bad"]).mockResolvedValueOnce(["good"]);
    let attempt = 0;
    await withArchivePassword("", async () => {
      attempt += 1;
      if (attempt === 1) throw new Error("7z-password:required");
      if (attempt === 2) throw new Error("7z-password:wrong");
      return "ok";
    });
    expect(prompt).toHaveBeenCalledTimes(2);
    expect(prompt.mock.calls[1][0]).toBe("パスワードが違います");
  });

  it("キャンセルは PasswordCancelled で静かに中断する", async () => {
    prompt.mockResolvedValueOnce(null);
    const error = await withArchivePassword("", async () => {
      throw new Error("7z-password:required");
    }).catch((e) => e);
    expect(isPasswordCancelled(error)).toBe(true);
    expect(setPassword).not.toHaveBeenCalled();
  });
});

describe("archiveRelOf", () => {
  it("エントリ表記から書庫の相対パスを取り出す", () => {
    expect(archiveRelOf("sub/data.7z::dir/a.txt")).toBe("sub/data.7z");
    expect(archiveRelOf("a.txt")).toBe("");
    expect(archiveRelOf("")).toBe("");
  });
});
