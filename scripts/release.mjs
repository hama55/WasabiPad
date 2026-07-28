import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { read, root, workspaceVersion } from "./version.mjs";

const version = process.argv[2];
if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(version ?? "")) {
  throw new Error("Usage: npm run release -- <major.minor.patch>");
}

const tag = `v${version}`;
const npm = process.platform === "win32" ? "npm.cmd" : "npm";

function run(command, args) {
  execFileSync(command, args, { cwd: root, stdio: "inherit" });
}

function output(command, args) {
  return execFileSync(command, args, { cwd: root, encoding: "utf8" }).trim();
}

function ensureClean() {
  if (output("git", ["status", "--porcelain"])) {
    throw new Error("作業ツリーが変更されています。リリース前にコミットまたは退避してください。");
  }
}

function setWorkspaceVersion() {
  const cargo = read("Cargo.toml");
  const updated = cargo.replace(
    /(\[workspace\.package\][\s\S]*?^version\s*=\s*")[^"]+("\s*$)/m,
    (_match, prefix, suffix) => `${prefix}${version}${suffix}`
  );
  if (updated === cargo) throw new Error("Cargo.toml [workspace.package].version を更新できませんでした。");
  writeFileSync(resolve(root, "Cargo.toml"), updated);
}

ensureClean();
if (workspaceVersion() === version) throw new Error(`${tag} はすでにプロジェクト内バージョンです。`);
if (output("git", ["tag", "--list", tag])) throw new Error(`${tag} はすでに存在します。`);

setWorkspaceVersion();
run(npm, ["run", "sync:version"]);
run("node", ["scripts/check-release-version.mjs", tag]);
run(npm, ["run", "build"]);
run("git", ["diff", "--check"]);
run("git", ["add", "Cargo.toml", "package.json", "package-lock.json", "src-tauri/tauri.conf.json"]);
run("git", ["commit", "-m", `chore: release ${tag}`]);
run("git", ["tag", "-a", tag, "-m", `Release ${tag}`]);

const branch = output("git", ["branch", "--show-current"]);
if (!branch) throw new Error("detached HEAD ではリリースできません。");
run("git", ["push", "origin", branch]);
run("git", ["push", "origin", tag]);
