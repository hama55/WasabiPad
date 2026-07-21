import { workspaceVersion } from "./version.mjs";

const actual = process.argv[2] ?? process.env.GITHUB_REF_NAME;
const expected = `v${workspaceVersion()}`;
if (actual !== expected) {
  throw new Error(`Release tag mismatch: expected ${expected}, received ${actual ?? "<none>"}`);
}
console.log(`Release tag OK: ${actual}.`);
