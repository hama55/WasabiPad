import { readFileSync } from "node:fs";
import { resolve } from "node:path";

export const root = resolve(import.meta.dirname, "..");
export const read = (path) => readFileSync(resolve(root, path), "utf8");

export function workspaceVersion() {
  const cargo = read("Cargo.toml");
  const section = cargo.match(/\[workspace\.package\]([\s\S]*?)(?:\r?\n\[|$)/)?.[1] ?? "";
  const version = section.match(/^version\s*=\s*"([^"]+)"/m)?.[1];
  if (!version) throw new Error("Cargo.toml [workspace.package].version is missing");
  return version;
}
