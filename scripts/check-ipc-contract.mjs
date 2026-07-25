import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const read = (path) => readFileSync(resolve(root, path), "utf8");
const backend = read("src-tauri/src/main.rs");
const coreDoc = read("core/src/doc.rs");
const fileio = read("core/src/fileio.rs");
const frontend = read("ui/api.ts");
const mainTs = read("ui/main.ts");
const sidebarTs = read("ui/sidebar.ts");
const indexHtml = read("index.html");

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

const commands = names(/#\[tauri::command\]\s*\r?\n(?:async\s+)?fn\s+(\w+)/g, backend);
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

const viewerFormats = names(/#\[serde\(rename = "([^"]+)"\)\]/g, blockAfter(backend, "enum ViewerFormat"));
assertSameSet("viewer format wire values", viewerFormats, tsUnion("ViewerFormat"));

// <select> の option は Encoding/Eol の第2の定義になりやすいため、型と一致することを検証する
function optionValues(id) {
  const start = indexHtml.indexOf(`id="${id}"`);
  if (start < 0) fail(`cannot find <select id="${id}">`);
  const end = indexHtml.indexOf("</select>", start);
  if (end < 0) fail(`unterminated <select id="${id}">`);
  return names(/value="([^"]+)"/g, indexHtml.slice(start, end));
}
assertSameSet("read encoding options", tsUnion("ReadEncoding"), optionValues("st-source-enc"));
assertSameSet("save encoding options", tsUnion("Encoding"), optionValues("st-enc"));
assertSameSet("EOL options", tsUnion("Eol"), optionValues("st-eol"));

// 乗算だけで書かれた閾値定数を数値化する (100 * 1024 * 1024 のような形式のみ)
function product(label, expression) {
  if (expression === undefined) fail(`cannot find ${label}`);
  const factors = expression.replace(/_/g, "").split("*").map((part) => Number(part.trim()));
  if (factors.some(Number.isNaN)) fail(`cannot evaluate ${label}: ${expression}`);
  return factors.reduce((total, factor) => total * factor, 1);
}
const mmapThreshold = product("MMAP_THRESHOLD", fileio.match(/MMAP_THRESHOLD: u64 = ([^;]+);/)?.[1]);
const hugeThreshold = product("HUGE_FILE_THRESHOLD", mainTs.match(/HUGE_FILE_THRESHOLD = ([^;]+);/)?.[1]);
if (mmapThreshold !== hugeThreshold) {
  fail(`huge file threshold; core=${mmapThreshold}, ui=${hugeThreshold}`);
}

// サイドバーの展開ボタン表示と core の遅延アーカイブ判定は同じ拡張子集合でなければならない
const lazyArchiveFn = coreDoc.slice(coreDoc.indexOf("fn is_lazy_archive_ext"));
const coreArchiveExts = names(/Some\("([^"]+)"\)/g, lazyArchiveFn.slice(0, lazyArchiveFn.indexOf("\n    }")));
const uiArchiveExts = (sidebarTs.match(/ARCHIVE_EXT = \/\\\.\(([^)]+)\)/)?.[1] ?? "").split("|").filter(Boolean);
assertSameSet("lazy archive extensions", coreArchiveExts, uiArchiveExts);

console.log(`IPC contract OK: ${commands.length} commands, wire enums, and shared constants match.`);
