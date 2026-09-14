import { assertSynchronizedVersions, read } from "./version.mjs";

const versions = assertSynchronizedVersions();
const tauri = JSON.parse(read("src-tauri/tauri.conf.json"));
const appConfig = JSON.parse(read("app-config.json"));
const vite = read("vite.config.ts");
const uiAppConfig = read("ui/app-config.ts");

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

console.log(`Config OK: ${appName} version ${versions.package}, development port ${devPort}.`);
