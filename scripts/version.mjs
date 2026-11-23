import { readFileSync } from "node:fs";
import { resolve } from "node:path";
export { isReleaseTag, RELEASE_TAG_PREFIX, releaseTag, VERSION_PATTERN } from "../version-policy.mjs";

export const root = resolve(import.meta.dirname, "..");
export const read = (path) => readFileSync(resolve(root, path), "utf8");
export const WORKSPACE_PACKAGES = ["wasabipad", "wasabipad-core"];

export function readCargoLockVersions(lockText = read("Cargo.lock"), packages = WORKSPACE_PACKAGES) {
  const found = {};
  for (const block of lockText.split(/^\[\[package\]\]\s*$/m).slice(1)) {
    const name = block.match(/^name\s*=\s*"([^"]+)"/m)?.[1];
    if (!name || !packages.includes(name)) continue;
    const version = block.match(/^version\s*=\s*"([^"]+)"/m)?.[1];
    if (!version) throw new Error(`Cargo.lock package "${name}" is missing version`);
    found[name] = version;
  }
  for (const name of packages) {
    if (!found[name]) throw new Error(`Cargo.lock is missing workspace package "${name}"`);
  }
  return found;
}

export function readVersionCopies() {
  const packageJson = JSON.parse(read("package.json"));
  const packageLock = JSON.parse(read("package-lock.json"));
  const tauri = JSON.parse(read("src-tauri/tauri.conf.json"));
  const cargoLock = readCargoLockVersions();
  return {
    package: packageJson.version,
    lock: packageLock.version,
    lockRoot: packageLock.packages[""].version,
    tauri: tauri.version,
    cargo: workspaceVersion(),
    ...Object.fromEntries(WORKSPACE_PACKAGES.map((name) => [`cargoLock:${name}`, cargoLock[name]])),
  };
}

export function assertSynchronizedVersions(copies = readVersionCopies()) {
  if (new Set(Object.values(copies)).size !== 1) {
    const cargoLock = WORKSPACE_PACKAGES.map((name) => copies[`cargoLock:${name}`]).join("/");
    throw new Error(
      `Version mismatch: package=${copies.package}, lock=${copies.lock}/${copies.lockRoot}, tauri=${copies.tauri}, cargo=${copies.cargo}, cargoLock=${cargoLock}`
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
