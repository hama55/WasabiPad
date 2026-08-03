import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { workspaceVersion } from "./version.mjs";

const root = resolve(import.meta.dirname, "..");
const read = (path) => readFileSync(resolve(root, path), "utf8");
const packageJson = JSON.parse(read("package.json"));
const packageLock = JSON.parse(read("package-lock.json"));
const tauri = JSON.parse(read("src-tauri/tauri.conf.json"));
const appConfig = JSON.parse(read("app-config.json"));
const vite = read("vite.config.ts");
const uiAppConfig = read("ui/app-config.ts");

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
const vitePort = vite.includes("port: DEV_PORT") && uiAppConfig.includes('from "../app-config.json"')
  ? appConfig.devPort
  : 0;
if (!devPort || devPort !== appConfig.devPort || devPort !== vitePort) {
  throw new Error(`Development port mismatch: source=${appConfig.devPort}, tauri=${devPort}, vite=${vitePort}`);
}

const devOrigin = new URL(tauri.build.devUrl).origin;
const devWebSocketOrigin = devOrigin.replace(/^http/, "ws");
const devCsp = Object.values(tauri.app.security.devCsp ?? {}).join(" ");
for (const origin of [devOrigin, devWebSocketOrigin]) {
  if (!devCsp.includes(origin)) {
    throw new Error(`Development CSP is missing ${origin}.`);
  }
}

// アプリ名と開発ポートは app-config.json が正。各実行環境の設定ファイルは同期生成する。
const appName = appConfig.name;
const copies = {
  "tauri.conf productName": tauri.productName,
  "tauri.conf window title": tauri.app.windows[0].title,
  "ui/app-config source": uiAppConfig.includes('from "../app-config.json"') ? appName : undefined,
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
const expectedViewerTitle = `${appName} ${appConfig.viewerTitleSuffix}`;
if (viewerTitle !== expectedViewerTitle) {
  throw new Error(`Viewer title mismatch: expected ${expectedViewerTitle}, received ${viewerTitle ?? "<not found>"}`);
}

console.log(`Config OK: ${appName} version ${packageJson.version}, development port ${devPort}.`);
