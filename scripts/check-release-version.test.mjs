import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import * as sharedVersion from "../version-policy.mjs";
import { checkReleaseVersion } from "./check-release-version.mjs";
import * as scriptVersion from "./version.mjs";
import { root } from "./version.mjs";

function versionCopies(version) {
  return {
    package: version,
    lock: version,
    lockRoot: version,
    tauri: version,
    cargo: version,
  };
}

describe("Feature: リリースタグとアプリバージョンの一致検査", () => {
  // Scenario: リリースタグがworkspace versionから生成されるタグ名と一致する
  // Given: workspace versionが1.5.8である
  // When: v1.5.8をリリースタグとして検査する
  // Then: 検査は成功する
  it("Scenario: 一致するリリースタグを受け入れる", () => {
    expect(checkReleaseVersion({ actual: "v1.5.8", headTag: null, versions: versionCopies("1.5.8") }))
      .toEqual({ checked: true, tag: "v1.5.8" });
  });

  // Scenario: HEADにリリースタグが付いている
  // Given: workspace versionが1.5.8でHEADのタグがv1.5.8である
  // When: タグを指定せずにビルド向けのバージョン検査を実行する
  // Then: HEADのタグもworkspace versionとの一致を検査する
  it("Scenario: HEADのリリースタグをworkspace versionと照合する", () => {
    expect(checkReleaseVersion({ actual: null, headTag: "v1.5.8", versions: versionCopies("1.5.8") }))
      .toEqual({ checked: true, tag: "v1.5.8" });
  });

  // Scenario: リリースタグとworkspace versionが一致しない
  // Given: workspace versionが1.5.8である
  // When: v1.5.7をリリースタグとして検査する
  // Then: 不一致の理由を含むエラーになる
  it("Scenario: 不一致のリリースタグを明確に拒否する", () => {
    expect(() => checkReleaseVersion({ actual: "v1.5.7", headTag: null, versions: versionCopies("1.5.8") }))
      .toThrow("Release tag mismatch: expected v1.5.8, received v1.5.7");
  });

  // Scenario: package.jsonだけがworkspace versionからずれている
  // Given: package.jsonが1.5.7で、lock・Tauri・Cargoが1.5.8である
  // When: v1.5.8をリリースタグとして単体検査する
  // Then: タグ検査の前に版番号コピーの不一致を明確に拒否する
  it("Scenario: packageだけ異なる版番号コピーを拒否する", () => {
    const versions = versionCopies("1.5.8");
    versions.package = "1.5.7";

    expect(() => checkReleaseVersion({ actual: "v1.5.8", headTag: null, versions }))
      .toThrow("Version mismatch: package=1.5.7, lock=1.5.8/1.5.8, tauri=1.5.8, cargo=1.5.8");
  });

  // Scenario: 開発中のHEADにリリースタグがない
  // Given: 明示的なタグもHEADの完全一致タグも存在しない
  // When: 開発ビルド向けのバージョン検査を実行する
  // Then: 検査をスキップして開発ビルドを継続できる
  it("Scenario: 未タグの開発ビルドを許可する", () => {
    expect(checkReleaseVersion({ actual: null, headTag: null, versions: versionCopies("1.5.8") }))
      .toEqual({ checked: false, tag: null });
  });

  // Scenario: GitHubの通常ブランチビルドでGITHUB_REF_NAMEだけが設定されている
  // Given: GITHUB_REF_TYPEがbranchでGITHUB_REF_NAMEがv1.5.7、HEADがリリースタグでもある
  // When: CLIのバージョン検査を実行する
  // Then: branch名をリリースタグと誤認せず、開発ビルドとして継続する
  it("Scenario: 通常のブランチビルドをリリース検査で止めない", () => {
    const output = execFileSync(process.execPath, ["scripts/check-release-version.mjs"], {
      cwd: root,
      encoding: "utf8",
      env: { ...process.env, GITHUB_REF_NAME: "v1.5.7", GITHUB_REF_TYPE: "branch" },
    });

    expect(output).toContain("version check skipped for development build");
  });

  // Scenario: ブランチビルドのHEADが過去のリリースタグでもある
  // Given: HEADタグがv1.5.8、GitHubのref種別がbranchである
  // When: タグを指定せずにバージョン検査を実行する
  // Then: HEADタグをリリース実行と解釈せず検査をスキップする
  it("Scenario: ブランチビルドではHEADのリリースタグを無視する", () => {
    expect(checkReleaseVersion({
      actual: null,
      headTag: "v1.5.8",
      githubRefType: "branch",
      versions: versionCopies("1.5.8"),
    })).toEqual({ checked: false, tag: null });
  });
});

describe("Feature: タグ生成規約の共有", () => {
  // Scenario: Nodeスクリプトがタグ生成規約を利用する
  // Given: version-policy.jsonを読む共有モジュールがタグ生成関数と判定関数を公開している
  // When: scripts/version.mjsから同じ関数と定数を参照する
  // Then: Node側はタグ生成規約を再実装せず、共有モジュールの公開値をそのまま使う
  it("Scenario: Node側のタグ生成規約を共有モジュールへ委譲する", () => {
    expect(scriptVersion.releaseTag).toBe(sharedVersion.releaseTag);
    expect(scriptVersion.isReleaseTag).toBe(sharedVersion.isReleaseTag);
    expect(scriptVersion.VERSION_PATTERN).toBe(sharedVersion.VERSION_PATTERN);
    expect(scriptVersion.RELEASE_TAG_PREFIX).toBe(sharedVersion.RELEASE_TAG_PREFIX);
  });
});

describe("Feature: 通常ビルドのGit非依存", () => {
  // Scenario: 通常ビルドのコマンド列を確認する
  // Given: package.jsonのbuild scriptとリリースタグ検査scriptが定義されている
  // When: 通常ビルドの実行経路を調べる
  // Then: buildはGitタグ検査を呼ばず、リリース専用の検査入口は残る
  it("Scenario: 通常ビルドからリリースタグ検査を分離する", () => {
    const packageJson = JSON.parse(readFileSync(`${root}/package.json`, "utf8"));

    expect(packageJson.scripts.build).not.toContain("check:release-version");
    expect(packageJson.scripts["check:release-version"])
      .toBe("node scripts/check-release-version.mjs");
  });
});
