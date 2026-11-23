import { describe, expect, it, vi } from "vitest";
import { runRelease } from "./release.mjs";

describe("Feature: release preconditions", () => {
  // Given: 作業ツリーはクリーンだが detached HEAD の状態にある
  // When: リリーススクリプトを実行する
  // Then: ファイル変更・コミット・タグ作成の前にエラーで失敗する
  it("Scenario: rejects detached HEAD before mutating files or creating commits", () => {
    const setWorkspaceVersion = vi.fn();
    const run = vi.fn();
    const output = vi.fn((_cmd, args) => {
      if (args[0] === "status") return "";
      if (args[0] === "branch") return "";
      return "";
    });

    expect(() =>
      runRelease("1.9.4", {
        run,
        output,
        workspaceVersion: () => "1.9.3",
        setWorkspaceVersion,
      })
    ).toThrow("detached HEAD ではリリースできません。");

    expect(setWorkspaceVersion).not.toHaveBeenCalled();
    expect(run).not.toHaveBeenCalled();
  });

  // Given: ローカルにはタグが存在しないがリモート origin に同名タグが存在する
  // When: リリーススクリプトを実行する
  // Then: ファイル変更・コミット・タグ作成の前にエラーで失敗する
  it("Scenario: rejects existing remote tag before mutating files or creating commits", () => {
    const setWorkspaceVersion = vi.fn();
    const run = vi.fn();
    const output = vi.fn((_cmd, args) => {
      if (args[0] === "status") return "";
      if (args[0] === "branch") return "main";
      if (args[0] === "tag") return "";
      if (args[0] === "ls-remote") return "abc123\trefs/tags/v1.9.4";
      return "";
    });

    expect(() =>
      runRelease("1.9.4", {
        run,
        output,
        workspaceVersion: () => "1.9.3",
        setWorkspaceVersion,
      })
    ).toThrow("v1.9.4 はすでにリモート origin に存在します。");

    expect(setWorkspaceVersion).not.toHaveBeenCalled();
    expect(run).not.toHaveBeenCalled();
  });

  // Given: 作業ツリーがクリーンで有効なブランチにおりローカル・リモート共にタグが存在しない
  // When: リリーススクリプトを実行する
  // Then: 事前検証後にバージョン更新・ビルド・コミット・タグ作成・push を順に実行する
  it("Scenario: runs preconditions before mutation and pushes branch and tag", () => {
    const steps = [];
    const output = vi.fn((_cmd, args) => {
      steps.push(`output:${args.join(" ")}`);
      if (args[0] === "branch") return "main";
      return "";
    });
    const run = vi.fn((_cmd, args) => {
      steps.push(`run:${args.join(" ")}`);
    });
    const setWorkspaceVersion = vi.fn(() => {
      steps.push("setWorkspaceVersion");
    });

    runRelease("1.9.4", {
      run,
      output,
      workspaceVersion: () => "1.9.3",
      setWorkspaceVersion,
    });

    expect(steps.slice(0, 6)).toEqual([
      "output:status --porcelain",
      "output:branch --show-current",
      "output:tag --list v1.9.4",
      "output:ls-remote --tags origin refs/tags/v1.9.4",
      "run:run check:generated",
      "setWorkspaceVersion",
    ]);
    expect(steps.slice(-2)).toEqual([
      "run:push origin main",
      "run:push origin v1.9.4",
    ]);
  });
});
