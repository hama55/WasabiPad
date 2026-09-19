import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");

describe("Feature: generated contract verification", () => {
  // Given: 通常ビルド、CI、リリースの各入口がある
  // When: 生成コードの同期・検証手順を確認する
  // Then: 通常ビルドは同期し、CIとリリースは差分検証してからビルドする
  it("Scenario: every shipping path rejects stale generated contracts", () => {
    const { scripts } = JSON.parse(read("package.json"));
    expect(scripts.build).toContain("npm run sync:protocol");

    for (const workflow of [read(".github/workflows/verify.yml"), read(".github/workflows/release.yml")]) {
      expect(workflow.indexOf("npm run check:generated")).toBeGreaterThan(-1);
      expect(workflow.indexOf("npm run check:generated")).toBeLessThan(workflow.indexOf("npm run build"));
    }

    const release = read("scripts/release.mjs");
    expect(release.indexOf('run(npm, ["run", "check:generated"])')).toBeGreaterThan(-1);
    expect(release.indexOf('run(npm, ["run", "check:generated"])')).toBeLessThan(release.indexOf("setWorkspaceVersion();"));
  });
});
