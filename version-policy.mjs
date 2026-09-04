import policy from "./version-policy.json" with { type: "json" };

export const VERSION_PATTERN = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;
export const RELEASE_TAG_PREFIX = policy.releaseTagPrefix;

export function releaseTag(version) {
  if (!VERSION_PATTERN.test(version)) throw new Error(`Invalid version: ${version}`);
  return `${RELEASE_TAG_PREFIX}${version}`;
}

export function isReleaseTag(tag) {
  return typeof tag === "string"
    && tag.startsWith(RELEASE_TAG_PREFIX)
    && VERSION_PATTERN.test(tag.slice(RELEASE_TAG_PREFIX.length));
}
