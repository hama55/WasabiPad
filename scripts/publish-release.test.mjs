import { describe, expect, it, vi } from "vitest";
import { publishRelease } from "./publish-release.mjs";

describe("Feature: GitHubリリース公開の再試行", () => {
  // Scenario: 既存リリースへのasset uploadが一時的に503になる
  // Given: リリースは既に存在し、最初のuploadだけが503で失敗する
  // When: 同じタグとassetで公開処理を実行する
  // Then: リリースを作り直さず、uploadを待機後に再試行して成功する
  it("Scenario: 一時的なupload失敗を既存リリースへ再試行する", async () => {
    const calls = [];
    let uploadAttempts = 0;
    const run = vi.fn((args) => {
      calls.push(args);
      if (args[1] === "upload" && uploadAttempts++ === 0) {
        throw new Error("503 Service Unavailable");
      }
    });
    const sleep = vi.fn(async () => {});

    await publishRelease("v1.5.2", ["wasabipad.exe", "setup.exe"], { run, sleep });

    expect(calls.filter((args) => args[1] === "create")).toHaveLength(0);
    expect(calls.filter((args) => args[1] === "upload")).toHaveLength(2);
    expect(calls.filter((args) => args[1] === "edit")).toHaveLength(1);
    expect(sleep).toHaveBeenCalledOnce();
  });

  // Scenario: タグのリリースがまだ存在しない
  // Given: release viewだけがnot foundで失敗する
  // When: 公開処理を実行する
  // Then: リリースを1回作成してからassetをuploadする
  it("Scenario: 未作成のリリースを作成してassetを公開する", async () => {
    const calls = [];
    const run = vi.fn((args) => {
      calls.push(args);
      if (args[1] === "view") throw new Error("release not found");
    });

    await publishRelease("v1.5.2", ["wasabipad.exe", "setup.exe"], {
      run,
      sleep: async () => {},
    });

    expect(calls.map((args) => args[1])).toEqual(["view", "create", "upload", "edit"]);
  });

  // Scenario: asset uploadが再試行しても成功しない
  // Given: uploadが毎回失敗するdraftリリース
  // When: 設定回数まで公開処理を再試行する
  // Then: エラーを返し、不完全なリリースを公開しない
  it("Scenario: assetを揃えられないリリースはdraftのまま残す", async () => {
    const run = vi.fn((args) => {
      if (args[1] === "upload") throw new Error("503 Service Unavailable");
    });

    await expect(publishRelease("v1.5.2", ["wasabipad.exe", "setup.exe"], {
      run,
      sleep: async () => {},
      attempts: 2,
    })).rejects.toThrow("503 Service Unavailable");

    expect(run.mock.calls.filter(([args]) => args[1] === "upload")).toHaveLength(2);
    expect(run.mock.calls.filter(([args]) => args[1] === "edit")).toHaveLength(0);
  });
});
