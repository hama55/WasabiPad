import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const root = resolve(import.meta.dirname, "..");

function generatedFiles(directory) {
  return readdirSync(directory, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith(".ts"))
    .map((entry) => join(entry.parentPath, entry.name));
}

export function syncGeneratedFiles(sourceDirectory, targetDirectory) {
  for (const source of generatedFiles(sourceDirectory)) {
    const target = join(targetDirectory, relative(sourceDirectory, source));
    if (existsSync(target) && readFileSync(source).equals(readFileSync(target))) continue;
    mkdirSync(dirname(target), { recursive: true });
    copyFileSync(source, target);
  }
}

function exportPackage(packageName, exportDirectory) {
  const result = spawnSync(
    "cargo",
    ["test", "-p", packageName, "export_bindings_", "--", "--test-threads=1"],
    {
      cwd: root,
      env: {
        ...process.env,
        TS_RS_EXPORT_DIR: exportDirectory,
        TS_RS_LARGE_INT: "number",
      },
      stdio: "inherit",
    },
  );
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${packageName}のIPC型生成に失敗しました`);
}

function main() {
  const exportDirectory = mkdtempSync(join(tmpdir(), "wasabipad-ipc-"));
  try {
    exportPackage("wasabipad-core", exportDirectory);
    exportPackage("wasabipad", exportDirectory);
    syncGeneratedFiles(exportDirectory, join(root, "ui", "generated"));
  } finally {
    rmSync(exportDirectory, { recursive: true, force: true });
  }
}

if (resolve(process.argv[1] ?? "") === fileURLToPath(import.meta.url)) main();
