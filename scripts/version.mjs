import { readFileSync } from "node:fs";
import { resolve } from "node:path";
export { isReleaseTag, RELEASE_TAG_PREFIX, releaseTag, VERSION_PATTERN } from "../version-policy.mjs";

export const root = resolve(import.meta.dirname, "..");
export const read = (path) => readFileSync(resolve(root, path), "utf8");

export function readVersionCopies() {
  const packageJson = JSON.parse(read("package.json"));
  const packageLock = JSON.parse(read("package-lock.json"));
  const tauri = JSON.parse(read("src-tauri/tauri.conf.json"));
  return {
    package: packageJson.version,
    lock: packageLock.version,
    lockRoot: packageLock.packages[""].version,
    tauri: tauri.version,
    cargo: workspaceVersion(),
  };
}

export function assertSynchronizedVersions(copies = readVersionCopies()) {
  if (new Set(Object.values(copies)).size !== 1) {
    throw new Error(
      `Version mismatch: package=${copies.package}, lock=${copies.lock}/${copies.lockRoot}, tauri=${copies.tauri}, cargo=${copies.cargo}`
    );
  }
  return copies;
}

export function workspaceVersion() {
  const cargo = read("Cargo.toml");
  const section = cargo.match(/\[workspace\.package\]([\s\S]*?)(?:\r?\n\[|$)/)?.[1] ?? "";
  const version = section.match(/^version\s*=\s*"([^"]+)"/m)?.[1];
  if (!version) throw new Error("Cargo.toml [workspace.package].version is missing");
  return version;
}
