import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");

function read(path) {
  return readFileSync(resolve(root, path), "utf8");
}

function writeIfChanged(path, contents) {
  const target = resolve(root, path);
  if (readFileSync(target, "utf8") !== contents) writeFileSync(target, contents);
}

function replaceOnce(source, pattern, replacement, label) {
  if (!pattern.test(source)) throw new Error(`設定の同期対象が見つからない: ${label}`);
  return source.replace(pattern, replacement);
}

const config = JSON.parse(read("app-config.json"));
if (!Number.isInteger(config.devPort) || config.devPort < 1 || config.devPort > 65535) {
  throw new Error(`不正な開発ポート: ${config.devPort}`);
}

const devOrigin = `http://localhost:${config.devPort}`;
const devWebSocketOrigin = `ws://localhost:${config.devPort}`;

let tauri = read("src-tauri/tauri.conf.json");
tauri = replaceOnce(tauri, /("productName"\s*:\s*")[^"]+(")/, `$1${config.name}$2`, "Tauri productName");
tauri = replaceOnce(tauri, /("devUrl"\s*:\s*")http:\/\/localhost:\d+(")/, `$1${devOrigin}$2`, "Tauri devUrl");
tauri = replaceOnce(
  tauri,
  /("windows"\s*:\s*\[\s*\{\s*"title"\s*:\s*")[^"]+(")/s,
  `$1${config.name}$2`,
  "Tauri window title",
);
tauri = replaceOnce(
  tauri,
  /("devCsp"\s*:\s*\{[\s\S]*?"default-src"\s*:\s*")[^"]*(")/,
  `$1'self' ${devOrigin}$2`,
  "Tauri devCsp default-src",
);
tauri = replaceOnce(
  tauri,
  /("devCsp"\s*:\s*\{[\s\S]*?"connect-src"\s*:\s*")[^"]*(")/,
  `$1ipc: http://ipc.localhost ${devOrigin} ${devWebSocketOrigin}$2`,
  "Tauri devCsp connect-src",
);
writeIfChanged("src-tauri/tauri.conf.json", tauri);

let index = read("index.html");
index = replaceOnce(index, /(<title>)[^<]*(<\/title>)/, `$1${config.name}$2`, "index title");
writeIfChanged("index.html", index);

let viewer = read("viewer.html");
viewer = replaceOnce(
  viewer,
  /(<title>)[^<]*(<\/title>)/,
  `$1${config.name} ${config.viewerTitleSuffix}$2`,
  "viewer title",
);
writeIfChanged("viewer.html", viewer);

let settings = read("core/src/settings.rs");
settings = replaceOnce(
  settings,
  /(PathBuf::from\(local\)\.join\(")[^"]+("\)\.join\(file\))/,
  `$1${config.name}$2`,
  "settings directory",
);
writeIfChanged("core/src/settings.rs", settings);

console.log(`App config synced: ${config.name}, development port ${config.devPort}.`);
