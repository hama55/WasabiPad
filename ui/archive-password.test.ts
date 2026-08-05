import { describe, expect, it, vi, beforeEach } from "vitest";
import { promptFields } from "./prompt";
import * as api from "./api";
import {
  isPasswordCancelled,
  PASSWORD_ERROR_MARKER,
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

describe("Feature: withArchivePassword", () => {
  // Given: archive pathが空で、処理が42を返す場合と`Error("no entries")`を投げる場合
  // When: 各処理を`withArchivePassword`へ渡す
  // Then: 成功値42・失敗Errorをそのまま返し、`promptFields`は未呼出し
  it("Scenario: パスワード無関係の成功と失敗はそのまま素通しする", async () => {
    await expect(withArchivePassword("", async () => 42)).resolves.toBe(42);
    await expect(
      withArchivePassword("", async () => {
        throw new Error("no entries");
      })
    ).rejects.toThrow("no entries");
    expect(prompt).not.toHaveBeenCalled();
  });

  // Given: `sub/data.7z`の初回処理が`PASSWORD_ERROR_MARKER:required`で失敗し、promptが`secret`を返す
  // When: `withArchivePassword`を実行
  // Then: 再試行結果が`ok`、`setArchivePassword("sub/data.7z","secret")`、初回prompt題名が`パスワード付きアーカイブです`でfield typeが`password`
  it("Scenario: パスワード要求 → 入力 → 記憶 → 再試行で成功する", async () => {
    prompt.mockResolvedValueOnce(["secret"]);
    let attempt = 0;
    const result = await withArchivePassword("sub/data.7z", async () => {
      attempt += 1;
      if (attempt === 1) throw new Error(`${PASSWORD_ERROR_MARKER}:required`);
      return "ok";
    });
    expect(result).toBe("ok");
    expect(setPassword).toHaveBeenCalledWith("sub/data.7z", "secret");
    expect(prompt.mock.calls[0][0]).toBe("パスワード付きアーカイブです");
    expect(prompt.mock.calls[0][1][0].type).toBe("password");
  });

  // Given: promptが順に`bad`、`good`を返し、処理がrequired→wrong→okとなる
  // When: `withArchivePassword`を実行
  // Then: promptは2回呼ばれ、2回目の題名が`パスワードが違います`
  it("Scenario: 誤ったパスワードは文言を変えて合うまで聞き直す", async () => {
    prompt.mockResolvedValueOnce(["bad"]).mockResolvedValueOnce(["good"]);
    let attempt = 0;
    await withArchivePassword("", async () => {
      attempt += 1;
      if (attempt === 1) throw new Error(`${PASSWORD_ERROR_MARKER}:required`);
      if (attempt === 2) throw new Error(`${PASSWORD_ERROR_MARKER}:wrong`);
      return "ok";
    });
    expect(prompt).toHaveBeenCalledTimes(2);
    expect(prompt.mock.calls[1][0]).toBe("パスワードが違います");
  });

  // Given: requiredエラー時のpromptがnullを返す
  // When: `withArchivePassword`の例外を捕捉
  // Then: `isPasswordCancelled(error)`がtrueで、`setArchivePassword`は未呼出し
  it("Scenario: キャンセルは PasswordCancelled で静かに中断する", async () => {
    prompt.mockResolvedValueOnce(null);
    const error = await withArchivePassword("", async () => {
      throw new Error(`${PASSWORD_ERROR_MARKER}:required`);
    }).catch((e) => e);
    expect(isPasswordCancelled(error)).toBe(true);
    expect(setPassword).not.toHaveBeenCalled();
  });
});
