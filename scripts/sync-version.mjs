import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { read, root, WORKSPACE_PACKAGES, workspaceVersion } from "./version.mjs";

export function syncVersions({
  version = workspaceVersion(),
  readFile = read,
  writeFile = (path, content) => writeFileSync(resolve(root, path), content),
  runCargo = (args) => execFileSync("cargo", args, { cwd: root, stdio: "inherit" }),
} = {}) {
  function updateJson(path, update) {
    const value = JSON.parse(readFile(path));
    update(value);
    writeFile(path, `${JSON.stringify(value, null, 2)}\n`);
  }

  updateJson("package.json", (value) => { value.version = version; });
  updateJson("package-lock.json", (value) => {
    value.version = version;
    value.packages[""].version = version;
  });
  updateJson("src-tauri/tauri.conf.json", (value) => { value.version = version; });

  const packageArgs = WORKSPACE_PACKAGES.flatMap((name) => ["-p", name]);
  runCargo(["update", ...packageArgs, "--offline"]);
  return version;
}

if (resolve(process.argv[1] ?? "") === fileURLToPath(import.meta.url)) {
  const version = syncVersions();
  console.log(`Synchronized generated version fields and Cargo.lock to ${version}.`);
}
