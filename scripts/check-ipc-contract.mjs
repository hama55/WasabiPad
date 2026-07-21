import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const read = (path) => readFileSync(resolve(root, path), "utf8");
const backend = read("src-tauri/src/main.rs");
const coreDoc = read("core/src/doc.rs");
const fileio = read("core/src/fileio.rs");
const frontend = read("ui/api.ts");

function fail(message) {
  throw new Error(`IPC contract mismatch: ${message}`);
}

function names(pattern, source) {
  return [...source.matchAll(pattern)].map((match) => match[1]);
}

function assertSameSet(label, expected, actual) {
  const expectedSet = new Set(expected);
  const actualSet = new Set(actual);
  const missing = [...expectedSet].filter((name) => !actualSet.has(name));
  const extra = [...actualSet].filter((name) => !expectedSet.has(name));
  if (missing.length || extra.length) {
    fail(`${label}; missing=[${missing.join(", ")}], extra=[${extra.join(", ")}]`);
  }
}

function blockAfter(source, marker) {
  const start = source.indexOf(marker);
  if (start < 0) fail(`cannot find ${marker}`);
  const open = source.indexOf("{", start);
  let depth = 0;
  for (let i = open; i < source.length; i += 1) {
    if (source[i] === "{") depth += 1;
    if (source[i] === "}") depth -= 1;
    if (depth === 0) return source.slice(open + 1, i);
  }
  fail(`unterminated block after ${marker}`);
}

function tsUnion(typeName) {
  const match = frontend.match(new RegExp(`export type ${typeName} = ([^;]+);`));
  if (!match) fail(`cannot find TypeScript union ${typeName}`);
  return names(/"([^"]+)"/g, match[1]);
}

const commands = names(/#\[tauri::command\]\s*\r?\nfn\s+(\w+)/g, backend);
const handlerBlock = backend.match(/tauri::generate_handler!\[([\s\S]*?)\]\)/)?.[1];
if (!handlerBlock) fail("cannot find tauri command handler registration");
const handler = handlerBlock
  .split(",")
  .map((name) => name.trim())
  .filter(Boolean);
const invokes = names(/invoke(?:<[^;()]+>)?\(\s*"([^"]+)"/g, frontend);
assertSameSet("Tauri command registration", commands, handler);
assertSameSet("TypeScript invoke commands", commands, invokes);

const encodingBlock = blockAfter(fileio, "pub enum EncodingId");
const encodingValues = names(/#\[serde\(rename = "([^"]+)"\)\]/g, encodingBlock);
assertSameSet("Encoding wire values", encodingValues, tsUnion("Encoding"));

const eolVariants = names(/^\s*(\w+),\s*$/gm, blockAfter(fileio, "pub enum Eol"))
  .map((name) => name.toLowerCase());
assertSameSet("EOL wire values", eolVariants, tsUnion("Eol"));

const docKinds = names(/^\s*(\w+),\s*$/gm, blockAfter(coreDoc, "pub enum DocKind"))
  .map((name) => name.toLowerCase());
const docInfoKind = frontend.match(/kind:\s*([^;]+);/)?.[1] ?? "";
assertSameSet("document kind wire values", docKinds, names(/"([^"]+)"/g, docInfoKind));

console.log(`IPC contract OK: ${commands.length} commands and wire enums match.`);
