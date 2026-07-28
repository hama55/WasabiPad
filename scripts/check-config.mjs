import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { workspaceVersion } from "./version.mjs";

const root = resolve(import.meta.dirname, "..");
const read = (path) => readFileSync(resolve(root, path), "utf8");
const packageJson = JSON.parse(read("package.json"));
const packageLock = JSON.parse(read("package-lock.json"));
const tauri = JSON.parse(read("src-tauri/tauri.conf.json"));
const vite = read("vite.config.ts");

const cargoVersion = workspaceVersion();
// package-lock も sync:version が書き換える対象なので、同期漏れをここで検出する
const versions = new Set([
  packageJson.version,
  packageLock.version,
  packageLock.packages[""].version,
  tauri.version,
  cargoVersion,
]);
if (versions.size !== 1) {
  throw new Error(
    `Version mismatch: package=${packageJson.version}, lock=${packageLock.version}/${packageLock.packages[""].version}, tauri=${tauri.version}, cargo=${cargoVersion}`
  );
}

const devPort = Number(new URL(tauri.build.devUrl).port);
const vitePort = Number(vite.match(/port:\s*(\d+)/)?.[1]);
if (!devPort || devPort !== vitePort) {
  throw new Error(`Development port mismatch: tauri=${devPort}, vite=${vitePort}`);
}

const devOrigin = new URL(tauri.build.devUrl).origin;
const devWebSocketOrigin = devOrigin.replace(/^http/, "ws");
const devCsp = Object.values(tauri.app.security.devCsp ?? {}).join(" ");
for (const origin of [devOrigin, devWebSocketOrigin]) {
  if (!devCsp.includes(origin)) {
    throw new Error(`Development CSP is missing ${origin}.`);
  }
}

// アプリ名は tauri.conf の productName が正 (バックエンドは package_info().name しか見ない)。
// 表示側とユーザデータの保存先が別々に名前を持つと、改名時に設定だけ旧フォルダに残る
const appName = tauri.productName;
const copies = {
  "tauri.conf window title": tauri.app.windows[0].title,
  "ui/format.ts APP_NAME": read("ui/format.ts").match(/APP_NAME = "([^"]+)"/)?.[1],
  "core/src/settings.rs config directory": read("core/src/settings.rs").match(/\.join\("([^"]+)"\)\.join\(file\)/)?.[1],
  "index.html <title>": read("index.html").match(/<title>([^<]+)<\/title>/)?.[1],
};
const drifted = Object.entries(copies).filter(([, value]) => value !== appName);
if (drifted.length) {
  throw new Error(
    `Application name mismatch (productName=${appName}): ${drifted.map(([label, value]) => `${label}=${value ?? "<not found>"}`).join(", ")}`
  );
}

const viewerTitle = read("viewer.html").match(/<title>([^<]+)<\/title>/)?.[1];
if (viewerTitle !== `${appName} ビュー`) {
  throw new Error(`Viewer title mismatch: expected ${appName} ビュー, received ${viewerTitle ?? "<not found>"}`);
}

console.log(`Config OK: ${appName} version ${packageJson.version}, development port ${devPort}.`);
