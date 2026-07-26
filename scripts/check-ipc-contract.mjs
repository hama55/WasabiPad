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
const folder = read("core/src/folder.rs");
const workspaceSearch = read("core/src/workspace_search.rs");
const coreFilename = read("core/src/filename.rs");
const uiFilename = read("ui/filename.ts");
const capabilities = JSON.parse(read("src-tauri/capabilities/default.json"));
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
// 保存側の選択肢は ui/save-format.ts が Record<Encoding|Eol, string> で持つため tsc が検証する

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

// serde は Rust のフィールド名をそのまま線に載せるため、項目名の増減は TS 側と一致する必要がある
// (型注釈だけでは検出できず、undefined が実行時に初めて現れるため)
function rustFields(source, structName) {
  return names(/^\s*pub (\w+):/gm, blockAfter(source, `pub struct ${structName}`));
}
function tsFields(interfaceName) {
  return names(/^\s*(\w+)\??:/gm, blockAfter(frontend, `export interface ${interfaceName}`));
}
const wireStructs = [
  [coreDoc, "PosC", "Pos"],
  [coreDoc, "DocInfo", "DocInfo"],
  [coreDoc, "EditResult", "EditResult"],
  [coreDoc, "EditManyItem", "EditManyItem"],
  [coreDoc, "EditManyResult", "EditManyResult"],
  [coreDoc, "FindResult", "FindResult"],
  [coreDoc, "FindCursor", "FindCursor"],
  [coreDoc, "ReplaceChunkResult", "ReplaceChunkResult"],
  [coreDoc, "WorkspaceSearchResult", "WorkspaceSearchResult"],
  [folder, "FolderEntry", "FolderEntry"],
  [workspaceSearch, "SearchOptions", "WorkspaceSearchOptions"],
];
for (const [source, structName, interfaceName] of wireStructs) {
  assertSameSet(`${structName} wire fields`, rustFields(source, structName), tsFields(interfaceName));
}
// backend 側の struct は pub を付けないため別扱い
for (const structName of ["ViewerPayload", "ViewerSelection"]) {
  const fields = names(/^\s*(\w+):/gm, blockAfter(backend, `struct ${structName}`));
  assertSameSet(`${structName} wire fields`, fields, tsFields(structName));
}

// ビューのウィンドウは動的生成のため、ラベル接頭辞が capability の許可パターンと外れると
// 権限を失ったまま静かに開いてしまう
const viewerLabelPrefix = backend.match(/format!\("([\w-]+)-\{\}"/)?.[1];
if (!viewerLabelPrefix) fail("cannot find viewer window label prefix");
if (!capabilities.windows.includes(`${viewerLabelPrefix}-*`)) {
  fail(`viewer window capability; label prefix=${viewerLabelPrefix}-, windows=[${capabilities.windows.join(", ")}]`);
}

// ファイル名規則は入力画面 (ui) と保存処理 (core) の二重検証。規則そのものは一致していなければならない
function expandReserved(alternatives) {
  return alternatives.flatMap((name) =>
    name.includes("[1-9]")
      ? Array.from({ length: 9 }, (_, index) => name.replace("[1-9]", String(index + 1)))
      : [name]
  ).map((name) => name.toUpperCase());
}
const reservedStart = coreFilename.indexOf("let reserved = matches!");
if (reservedStart < 0) fail("cannot find reserved device name list");
const coreReserved = names(
  /"([A-Z0-9]+)"/g,
  coreFilename.slice(reservedStart, coreFilename.indexOf(");", reservedStart))
);
const uiReserved = expandReserved(
  (uiFilename.match(/WINDOWS_RESERVED_NAME = \/\^\(([^)]+)\)/)?.[1] ?? "").split("|").filter(Boolean)
);
assertSameSet("Windows reserved device names", coreReserved, uiReserved);

const coreInvalidChars = coreFilename.match(/r#"(.*?)"#\.contains/)?.[1];
const uiInvalidChars = uiFilename.match(/\[\\u0000-\\u001f([^\]]*)\]/)?.[1]?.replace(/\\\\/g, "\\");
if (coreInvalidChars === undefined || uiInvalidChars === undefined) {
  fail("cannot find Windows invalid character set");
}
assertSameSet("Windows invalid characters", [...coreInvalidChars], [...uiInvalidChars]);

console.log(`IPC contract OK: ${commands.length} commands, wire enums, structs, and shared constants match.`);
