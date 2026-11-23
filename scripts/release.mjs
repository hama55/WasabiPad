import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { read, releaseTag, root, VERSION_PATTERN, workspaceVersion as defaultWorkspaceVersion } from "./version.mjs";

const npm = process.platform === "win32" ? "npm.cmd" : "npm";

function defaultRun(command, args) {
  // Windowsの.cmdだけshellが必要。gitまでshellへ渡すと、空白を含むcommit/tag messageが分割される。
  execFileSync(command, args, { cwd: root, stdio: "inherit", shell: command === npm });
}

function defaultOutput(command, args) {
  return execFileSync(command, args, { cwd: root, encoding: "utf8" }).trim();
}

function writeWorkspaceVersion(version) {
  const cargo = read("Cargo.toml");
  const updated = cargo.replace(
    /(\[workspace\.package\][\s\S]*?^version\s*=\s*")[^"]+("\s*$)/m,
    (_match, prefix, suffix) => `${prefix}${version}${suffix}`
  );
  if (updated === cargo) throw new Error("Cargo.toml [workspace.package].version を更新できませんでした。");
  writeFileSync(resolve(root, "Cargo.toml"), updated);
}

export function runRelease(version, deps = {}) {
  if (!VERSION_PATTERN.test(version ?? "")) {
    throw new Error("Usage: npm run release -- <major.minor.patch>");
  }

  const tag = releaseTag(version);
  const run = deps.run ?? defaultRun;
  const output = deps.output ?? defaultOutput;
  const workspaceVersion = deps.workspaceVersion ?? defaultWorkspaceVersion;
  const setWorkspaceVersion = deps.setWorkspaceVersion ?? (() => writeWorkspaceVersion(version));

  if (output("git", ["status", "--porcelain"])) {
    throw new Error("作業ツリーが変更されています。リリース前にコミットまたは退避してください。");
  }
  const branch = output("git", ["branch", "--show-current"]);
  if (!branch) throw new Error("detached HEAD ではリリースできません。");
  if (workspaceVersion() === version) throw new Error(`${tag} はすでにプロジェクト内バージョンです。`);
  if (output("git", ["tag", "--list", tag])) throw new Error(`${tag} はすでに存在します。`);
  if (output("git", ["ls-remote", "--tags", "origin", `refs/tags/${tag}`])) {
    throw new Error(`${tag} はすでにリモート origin に存在します。`);
  }
  run(npm, ["run", "check:generated"]);

  setWorkspaceVersion();
  run(npm, ["run", "sync:version"]);
  run("node", ["scripts/check-release-version.mjs", tag]);
  run(npm, ["run", "build"]);
  run("git", ["diff", "--check"]);
  run("git", ["add", "Cargo.toml", "Cargo.lock", "package.json", "package-lock.json", "src-tauri/tauri.conf.json"]);
  run("git", ["commit", "-m", `chore: release ${tag}`]);
  run("git", ["tag", "-a", tag, "-m", `Release ${tag}`]);

  run("git", ["push", "origin", branch]);
  run("git", ["push", "origin", tag]);
}

if (resolve(process.argv[1] ?? "") === fileURLToPath(import.meta.url)) {
  runRelease(process.argv[2]);
}
