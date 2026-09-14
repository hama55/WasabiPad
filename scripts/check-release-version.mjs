import { execFileSync } from "node:child_process";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { assertSynchronizedVersions, isReleaseTag, releaseTag, root } from "./version.mjs";

function exactHeadTag() {
  try {
    return execFileSync("git", ["describe", "--tags", "--exact-match", "HEAD"], {
      cwd: root,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim() || null;
  } catch {
    return null;
  }
}

function githubReleaseTag() {
  const refName = process.env.GITHUB_REF_NAME;
  if (!refName) return null;
  if (process.env.GITHUB_REF_TYPE === "tag") return refName;
  if (process.env.GITHUB_REF_TYPE) return null;
  if (isReleaseTag(refName)) return refName;
  return null;
}

export function checkReleaseVersion(options = {}) {
  const {
    actual = process.argv[2] ?? githubReleaseTag(),
    githubRefType = process.env.GITHUB_REF_TYPE,
    versions,
  } = options;
  const headTag = Object.hasOwn(options, "headTag")
    ? (Object.hasOwn(options, "githubRefType") && githubRefType ? null : options.headTag)
    : githubRefType ? null : exactHeadTag();
  const synchronizedVersions = assertSynchronizedVersions(versions);
  const tag = actual ?? headTag;
  if (!tag) return { checked: false, tag: null };
  if (actual === null && !isReleaseTag(tag)) return { checked: false, tag };

  const expected = releaseTag(synchronizedVersions.cargo);
  if (tag !== expected) {
    throw new Error(`Release tag mismatch: expected ${expected}, received ${tag}`);
  }
  return { checked: true, tag };
}

if (resolve(process.argv[1] ?? "") === fileURLToPath(import.meta.url)) {
  const result = checkReleaseVersion();
  if (result.checked) {
    console.log(`Release tag OK: ${result.tag}.`);
  } else if (result.tag) {
    console.log(`Non-release tag ${result.tag}; version check skipped.`);
  } else {
    console.log("No release tag found; version check skipped for development build.");
  }
}
