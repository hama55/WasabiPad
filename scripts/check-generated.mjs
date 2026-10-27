import { execFileSync, spawnSync } from "node:child_process";

const paths = ["ui/generated", "core/src/protocol.rs"];
const diff = spawnSync("git", ["diff", "--exit-code", "--", ...paths], { stdio: "inherit" });
if (diff.error) throw diff.error;
if (diff.status !== 0) process.exit(diff.status ?? 1);

const untracked = execFileSync("git", ["ls-files", "--others", "-z", "--", ...paths], { encoding: "utf8" });
if (untracked) {
  console.error(`Untracked generated files:\n${untracked.replaceAll("\0", "\n")}`);
  process.exitCode = 1;
}
