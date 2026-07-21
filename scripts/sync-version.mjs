import { writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { read, root, workspaceVersion } from "./version.mjs";

const version = workspaceVersion();

function updateJson(path, update) {
  const value = JSON.parse(read(path));
  update(value);
  writeFileSync(resolve(root, path), `${JSON.stringify(value, null, 2)}\n`);
}

updateJson("package.json", (value) => { value.version = version; });
updateJson("package-lock.json", (value) => {
  value.version = version;
  value.packages[""].version = version;
});
updateJson("src-tauri/tauri.conf.json", (value) => { value.version = version; });

console.log(`Synchronized generated version fields to ${version}.`);
