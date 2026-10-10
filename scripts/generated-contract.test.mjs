import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
const roots = [];
const checker = fileURLToPath(new URL("./check-generated.mjs", import.meta.url));

function git(root, ...args) {
  const result = spawnSync("git", args, { cwd: root, encoding: "utf8" });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(result.stderr);
}

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "wasabipad-generated-check-"));
  roots.push(root);
  mkdirSync(join(root, "ui/generated"), { recursive: true });
  mkdirSync(join(root, "core/src"), { recursive: true });
  writeFileSync(join(root, "ui/generated/Current.ts"), "export type Current = string;\n");
  writeFileSync(join(root, "core/src/protocol.rs"), "// generated protocol\n");
  git(root, "init", "--quiet");
  git(root, "add", "--", "ui/generated", "core/src/protocol.rs");
  return root;
}

function check(root) {
  const result = spawnSync(process.execPath, [checker], { cwd: root, encoding: "utf8" });
  if (result.error) throw result.error;
  return result;
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("Feature: generated contract verification", () => {
  // Given: 同期で新しいIPC型が生成され、まだ追跡されていない
  // When: 生成物の検査コマンドを実行する
  // Then: コミットされていない生成物を検出して失敗する
  it("Scenario: rejects newly generated untracked contracts", () => {
    const root = fixture();
    writeFileSync(join(root, "ui/generated/NewType.ts"), "export type NewType = string;\n");
    const result = check(root);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("ui/generated/NewType.ts");
  });

  // Given: 新しいIPC型が生成され、無視設定により追跡されていない
  // When: 生成物の検査コマンドを実行する
  // Then: 無視設定にかかわらず生成物のコミット漏れを検出する
  it("Scenario: rejects untracked generated contracts even when ignored", () => {
    const root = fixture();
    writeFileSync(join(root, ".gitignore"), "ui/generated/NewType.ts\n");
    writeFileSync(join(root, "ui/generated/NewType.ts"), "export type NewType = string;\n");
    expect(check(root).status).toBe(1);
  });

  // Given: 生成物がステージ済みの内容と一致する
  // When: 生成物の検査コマンドを実行する
  // Then: HEADやコミットの有無によらず成功する
  it("Scenario: accepts generated contracts matching the index", () => {
    expect(check(fixture()).status).toBe(0);
  });

  // Given: 追跡済みの生成物に未ステージの変更または削除がある
  // When: 生成物の検査コマンドを実行する
  // Then: UIとRustのどちらの生成物でも失敗する
  it.each([
    ["ui/generated/Current.ts", "change"],
    ["ui/generated/Current.ts", "delete"],
    ["core/src/protocol.rs", "change"],
    ["core/src/protocol.rs", "delete"],
  ])("Scenario: rejects %s after %s", (path, action) => {
    const root = fixture();
    if (action === "delete") rmSync(join(root, path));
    else writeFileSync(join(root, path), "changed generated contract\n");
    expect(check(root).status).toBe(1);
  });

  // Given: 変更した生成物をすでにステージしている
  // When: コミット前の生成物検査を実行する
  // Then: ステージ済み差分を不一致とみなさず成功する
  it("Scenario: accepts staged generated changes", () => {
    const root = fixture();
    writeFileSync(join(root, "ui/generated/Current.ts"), "export type Current = number;\n");
    git(root, "add", "--", "ui/generated/Current.ts");
    expect(check(root).status).toBe(0);
  });

  // Given: 生成物以外に未追跡ファイルと未ステージ差分がある
  // When: 生成物の検査コマンドを実行する
  // Then: 無関係な作業状態を検査せず成功する
  it("Scenario: ignores unrelated worktree changes", () => {
    const root = fixture();
    writeFileSync(join(root, "notes.txt"), "original notes\n");
    git(root, "add", "--", "notes.txt");
    writeFileSync(join(root, "notes.txt"), "changed notes\n");
    writeFileSync(join(root, "draft.txt"), "new draft\n");
    expect(check(root).status).toBe(0);
  });

  // Given: 通常ビルド、CI、リリースの各入口がある
  // When: 生成コードの同期・検証手順を確認する
  // Then: 通常ビルドは同期し、CIとリリースは差分検証してからビルドする
  it("Scenario: every shipping path rejects stale generated contracts", () => {
    const { scripts } = JSON.parse(read("package.json"));
    expect(scripts.build).toContain("npm run sync:protocol");
    expect(scripts["check:generated"]).toContain("node scripts/check-generated.mjs");

    for (const workflow of [read(".github/workflows/verify.yml"), read(".github/workflows/release.yml")]) {
      expect(workflow.indexOf("npm run check:generated")).toBeGreaterThan(-1);
      expect(workflow.indexOf("npm run check:generated")).toBeLessThan(workflow.indexOf("npm run build"));
    }

    const release = read("scripts/release.mjs");
    expect(release.indexOf('run(npm, ["run", "check:generated"])')).toBeGreaterThan(-1);
    expect(release.indexOf('run(npm, ["run", "check:generated"])')).toBeLessThan(release.indexOf("setWorkspaceVersion();"));
  });
});
