import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { workspaceVersion } from "./version.mjs";

const root = resolve(import.meta.dirname, "..");
const read = (path) => readFileSync(resolve(root, path), "utf8");
const packageJson = JSON.parse(read("package.json"));
const tauri = JSON.parse(read("src-tauri/tauri.conf.json"));
const vite = read("vite.config.ts");

const cargoVersion = workspaceVersion();
const versions = new Set([packageJson.version, tauri.version, cargoVersion]);
if (versions.size !== 1) {
  throw new Error(`Version mismatch: package=${packageJson.version}, tauri=${tauri.version}, cargo=${cargoVersion}`);
}

const devPort = Number(new URL(tauri.build.devUrl).port);
const vitePort = Number(vite.match(/port:\s*(\d+)/)?.[1]);
if (!devPort || devPort !== vitePort) {
  throw new Error(`Development port mismatch: tauri=${devPort}, vite=${vitePort}`);
}

console.log(`Config OK: version ${packageJson.version}, development port ${devPort}.`);
