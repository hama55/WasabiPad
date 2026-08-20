import { execFileSync } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { root, VERSION_PATTERN } from "./version.mjs";

const DEFAULT_ATTEMPTS = 5;

function runGh(args) {
  execFileSync("gh", args, { cwd: root, env: process.env, stdio: "inherit" });
}

const wait = (milliseconds) => new Promise((resolveWait) => setTimeout(resolveWait, milliseconds));
const retryDelay = (failedAttempt) => 2_000 * (2 ** failedAttempt);

function tryRun(operation) {
  try {
    operation();
    return null;
  } catch (error) {
    return error;
  }
}

async function waitForRetry(sleep, failedAttempt, action) {
  const delay = retryDelay(failedAttempt);
  console.warn(`${action}に失敗。${delay / 1_000}秒後に再試行します。`);
  await sleep(delay);
}

async function retry(action, operation, sleep, attempts) {
  let lastError;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      return operation();
    } catch (error) {
      lastError = error;
      if (attempt + 1 < attempts) await waitForRetry(sleep, attempt, action);
    }
  }
  throw lastError;
}

export async function publishRelease(
  tag,
  assets,
  { run = runGh, sleep = wait, attempts = DEFAULT_ATTEMPTS } = {},
) {
  await retry("GitHub Releaseの確認・作成", () => {
    const viewError = tryRun(() => run(["release", "view", tag]));
    if (!viewError) return;
    const createError = tryRun(() => run([
      "release", "create", tag,
      "--title", tag,
      "--generate-notes",
      "--verify-tag",
      "--draft",
    ]));
    if (createError) throw createError;
  }, sleep, attempts);
  await retry(
    "リリースassetのupload",
    () => run(["release", "upload", tag, ...assets, "--clobber"]),
    sleep,
    attempts,
  );
  await retry(
    "GitHub Releaseの公開",
    () => run(["release", "edit", tag, "--draft=false"]),
    sleep,
    attempts,
  );
}

function releaseAssets() {
  const releaseDir = resolve(root, "release");
  const installers = readdirSync(releaseDir)
    .filter((name) => name.endsWith("-setup.exe"));
  if (installers.length !== 1) {
    throw new Error(`setup.exeは1個必要です。検出数: ${installers.length}`);
  }
  const assets = [
    resolve(releaseDir, "wasabipad.exe"),
    resolve(releaseDir, installers[0]),
  ];
  if (assets.some((path) => !existsSync(path))) throw new Error("リリースassetが見つかりません。");
  return assets;
}

if (resolve(process.argv[1] ?? "") === fileURLToPath(import.meta.url)) {
  const tag = process.argv[2];
  if (!tag?.startsWith("v") || !VERSION_PATTERN.test(tag.slice(1))) {
    throw new Error("Usage: node scripts/publish-release.mjs <vmajor.minor.patch>");
  }
  await publishRelease(tag, releaseAssets());
}
