import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const read = (path) => readFileSync(resolve(root, path), "utf8");
const backend = read("src-tauri/src/main.rs");
const documentTypes = read("core/src/document_types.rs");
const fileio = read("core/src/fileio.rs");
const protocol = JSON.parse(read("shared/protocol.json"));
const generatedProtocol = read("ui/generated/Protocol.ts");
const rustProtocol = read("core/src/protocol.rs");
const frontend = read("ui/api.ts");
const documentLoadProgress = read("ui/document-load-progress.ts");
const folder = read("core/src/folder.rs");
const workspaceSearch = read("core/src/workspace_search.rs");
const generatedSearchOptions = read("ui/generated/WorkspaceSearchOptions.ts");
const generatedSearchOutcome = read("ui/generated/WorkspaceSearchOutcome.ts");
const generatedSearchResult = read("ui/generated/WorkspaceSearchResult.ts");
const generatedFileNameMatchMode = read("ui/generated/FileNameMatchMode.ts");
const generatedEncoding = read("ui/generated/Encoding.ts");
const generatedEol = read("ui/generated/Eol.ts");
const generatedDocKind = read("ui/generated/DocKind.ts");
const generatedViewerFormat = read("ui/generated/ViewerFormat.ts");
const generatedIpcCommands = read("ui/generated/IpcCommands.ts");
const capabilities = JSON.parse(read("src-tauri/capabilities/default.json"));

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

function matchingDelimiter(source, open, opening, closing) {
  let depth = 0;
  let quote = null;
  let escaped = false;
  for (let i = open; i < source.length; i += 1) {
    const char = source[i];
    if (quote) {
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === quote) quote = null;
      continue;
    }
    if (char === '"') {
      quote = char;
      continue;
    }
    if (char === opening) depth += 1;
    if (char === closing) {
      depth -= 1;
      if (depth === 0) return i;
    }
  }
  fail(`unterminated ${opening}${closing} block`);
}

function splitTopLevel(source) {
  const parts = [];
  let start = 0;
  let angle = 0;
  let round = 0;
  let square = 0;
  let curly = 0;
  let quote = null;
  let escaped = false;
  for (let i = 0; i < source.length; i += 1) {
    const char = source[i];
    if (quote) {
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === quote) quote = null;
      continue;
    }
    if (char === '"') {
      quote = char;
      continue;
    }
    if (char === "<") angle += 1;
    else if (char === ">") angle = Math.max(0, angle - 1);
    else if (char === "(") round += 1;
    else if (char === ")") round -= 1;
    else if (char === "[") square += 1;
    else if (char === "]") square -= 1;
    else if (char === "{") curly += 1;
    else if (char === "}") curly -= 1;
    else if (char === "," && angle === 0 && round === 0 && square === 0 && curly === 0) {
      parts.push(source.slice(start, i));
      start = i + 1;
    }
  }
  parts.push(source.slice(start));
  return parts;
}

function rustCommandParameters(source, command) {
  const marker = source.match(new RegExp(`(?:async\\s+)?fn\\s+${command}\\s*\\(`));
  if (!marker) fail(`cannot find Rust command ${command}`);
  const open = source.indexOf("(", marker.index);
  const close = matchingDelimiter(source, open, "(", ")");
  return splitTopLevel(source.slice(open + 1, close))
    .map((parameter) => parameter.trim())
    .filter(Boolean)
    .map((parameter) => {
      const separator = parameter.indexOf(":");
      if (separator < 0) fail(`cannot parse ${command} parameter ${parameter}`);
      return {
        name: parameter.slice(0, separator).trim().replace(/^mut\s+/, ""),
        type: parameter.slice(separator + 1).trim(),
      };
    });
}

function invokeArgumentKeys(source, command) {
  const call = source.match(new RegExp(`invoke(?:<[^;()]+>)?\\(\\s*IPC_COMMANDS\\.${camelCase(command)}`));
  if (!call) fail(`cannot find TypeScript invoke ${command}`);
  let comma = call.index + call[0].length;
  while (/\s/.test(source[comma] ?? "")) comma += 1;
  if (source[comma] !== ",") return [];
  let open = comma + 1;
  while (/\s/.test(source[open] ?? "")) open += 1;
  if (source[open] !== "{") return [];
  const close = matchingDelimiter(source, open, "{", "}");
  return splitTopLevel(source.slice(open + 1, close))
    .map((property) => property.trim())
    .filter(Boolean)
    .map((property) => property.match(/^(?:\.\.\.)?([A-Za-z_$][\w$]*)/)?.[1])
    .filter(Boolean);
}

function tsUnion(typeName, source = frontend) {
  const match = source.match(new RegExp(`export type ${typeName} = ([^;]+);`));
  if (!match) fail(`cannot find TypeScript union ${typeName}`);
  return names(/"([^"]+)"/g, match[1]);
}

function rustStructFields(source, structName) {
  return names(/^\s*(?:pub\s+)?(\w+):/gm, blockAfter(source, `struct ${structName}`));
}

function generatedStructFields(typeName) {
  const source = read(`ui/generated/${typeName}.ts`);
  const body = source.match(new RegExp(`export type ${typeName} = \\{([\\s\\S]*?)\\};`))?.[1];
  if (body === undefined) fail(`cannot find generated struct ${typeName}`);
  return names(/(?:^|,)\s*(\w+)\??\s*:/g, body);
}

function camelCase(value) {
  return value.replace(/_([a-z])/g, (_match, letter) => letter.toUpperCase());
}

const commands = names(/#\[tauri::command\]\s*\r?\n(?:async\s+)?fn\s+(\w+)/g, backend);
const handlerBlock = backend.match(/tauri::generate_handler!\[([\s\S]*?)\]\)/)?.[1];
if (!handlerBlock) fail("cannot find tauri command handler registration");
const handler = handlerBlock
  .split(",")
  .map((name) => name.trim())
  .filter(Boolean);
assertSameSet("Tauri command registration", commands, handler);
if (!generatedIpcCommands.startsWith("// This file was generated from src-tauri/src/main.rs")) {
  fail("IpcCommands.ts must be generated from Rust command definitions");
}
const generatedCommandNames = names(/^\s+\w+:\s+"([^"]+)",$/gm, generatedIpcCommands);
const generatedCommandKeys = names(/^\s+(\w+):\s+"[^"]+",$/gm, generatedIpcCommands);
assertSameSet("generated IPC command names", commands, generatedCommandNames);
assertSameSet("generated IPC command keys", commands.map(camelCase), generatedCommandKeys);
assertSameSet("TypeScript IPC command bindings", generatedCommandKeys, names(/IPC_COMMANDS\.(\w+)/g, frontend));

// Tauri は Rust の引数名を camelCase のIPCキーとして受け取る。名前だけの集合を
// 照合すると edit の caret_before/caretBefore のような実行時だけの破綻を見逃す。
for (const command of commands) {
  const expected = rustCommandParameters(backend, command)
    .filter(({ type }) => !/\b(?:State|AppHandle|Window|WebviewWindow)\b/.test(type))
    .map(({ name }) => camelCase(name));
  assertSameSet(`${command} argument keys`, expected, invokeArgumentKeys(frontend, command));
}

const encodingBlock = blockAfter(fileio, "pub enum EncodingId");
const encodingValues = names(/#\[serde\(rename = "([^"]+)"\)\]/g, encodingBlock);
assertSameSet("Encoding wire values", encodingValues, tsUnion("Encoding", generatedEncoding));

const eolVariants = names(/^\s*(\w+),\s*$/gm, blockAfter(fileio, "pub enum Eol"))
  .map((name) => name.toLowerCase());
assertSameSet("EOL wire values", eolVariants, tsUnion("Eol", generatedEol));

const docKinds = names(/^\s*(\w+),\s*$/gm, blockAfter(documentTypes, "pub enum DocKind"))
  .map((name) => name.toLowerCase());
assertSameSet("document kind wire values", docKinds, tsUnion("DocKind", generatedDocKind));

const viewerFormats = names(/#\[serde\(rename = "([^"]+)"\)\]/g, blockAfter(backend, "enum ViewerFormat"));
assertSameSet("viewer format wire values", viewerFormats, tsUnion("ViewerFormat", generatedViewerFormat));

const fileNameMatchModes = names(/^\s*(\w+),\s*$/gm, blockAfter(workspaceSearch, "pub enum FileNameMatchMode"))
  .map((name) => name.toLowerCase());
assertSameSet(
  "file name match mode wire values",
  fileNameMatchModes,
  tsUnion("FileNameMatchMode", generatedFileNameMatchMode)
);

for (const [name, source] of [
  ["WorkspaceSearchOptions", generatedSearchOptions],
  ["WorkspaceSearchOutcome", generatedSearchOutcome],
  ["WorkspaceSearchResult", generatedSearchResult],
  ["FileNameMatchMode", generatedFileNameMatchMode],
]) {
  if (!source.startsWith("// This file was generated by")) {
    fail(`${name} must be generated from Rust`);
  }
}

// 選択肢は ui/statusbar.ts が READ_ENCODINGS/INDENT_SIZES から生成する。
// HTML に複製を置かないことで、値の追加漏れを tsc と型から検出できるようにする。

// 検索途中経過の送出頻度は backend が単独で管理する。UI は届いた batch を描く。
// 送出上限だけは DOM 上限を超えないことを検証する。
const progressMax = Number(workspaceSearch.match(/PROGRESS_MAX: usize = ([\d_]+);/)?.[1]?.replace(/_/g, ""));
const maxRenderedRows = Number(read("ui/workspace-search-panel.ts").match(/MAX_RENDERED_ROWS = ([\d_]+);/)?.[1]?.replace(/_/g, ""));
if (!progressMax || !maxRenderedRows || progressMax > maxRenderedRows) {
  fail(`search progress cap exceeds rendered rows; core=${progressMax}, ui=${maxRenderedRows}`);
}

// Rust DTO から生成した型のフィールド集合を確認する。生成物のヘッダだけを確認すると、
// 古い生成物を残したままでも通るため、追加・改名・削除の取りこぼしをここで止める。
const wireStructs = [
  [documentTypes, "DocInfo", "DocInfo"],
  [documentTypes, "PosC", "Pos"],
  [documentTypes, "EditResult", "EditResult"],
  [documentTypes, "EditManyItem", "EditManyItem"],
  [documentTypes, "EditManyResult", "EditManyResult"],
  [documentTypes, "FindResult", "FindResult"],
  [documentTypes, "FindCursor", "FindCursor"],
  [documentTypes, "WorkspaceSearchResult", "WorkspaceSearchResult"],
  [documentTypes, "ReplaceChunkResult", "ReplaceChunkResult"],
  [folder, "FolderEntry", "FolderEntry"],
  [workspaceSearch, "SearchOptions", "WorkspaceSearchOptions"],
  [workspaceSearch, "WorkspaceSearchOutcome", "WorkspaceSearchOutcome"],
  [backend, "ViewerPayload", "ViewerPayload"],
  [backend, "ViewerSelection", "ViewerSelection"],
  [backend, "EditorViewState", "EditorViewState", true],
  [backend, "WindowRequest", "WindowRequest", true],
  [backend, "WorkspaceSearchBatch", "WorkspaceSearchBatch"],
];
for (const [source, structName, typeName, renameAll] of wireStructs) {
  const fields = rustStructFields(source, structName);
  const wireFields = renameAll ? fields.map(camelCase) : fields;
  assertSameSet(`${structName} generated wire fields`, wireFields, generatedStructFields(typeName));
}

// 機械プロトコルは shared/protocol.json から生成され、Rust/TypeScript双方が同じ値を使う。
const generatedProtocolValue = (source, name, pattern) => source.match(pattern)?.[1];
const protocolValues = [
  ["archive entry separator", protocol.archiveEntrySeparator,
    generatedProtocolValue(generatedProtocol, "ARCHIVE_ENTRY_SEPARATOR", /export const ARCHIVE_ENTRY_SEPARATOR = "([^"]+)"/),
    generatedProtocolValue(rustProtocol, "ARCHIVE_ENTRY_SEPARATOR", /ARCHIVE_ENTRY_SEPARATOR: &str = "([^"]+)"/)],
  ["archive password marker", protocol.passwordErrorMarker,
    generatedProtocolValue(generatedProtocol, "PASSWORD_ERROR_MARKER", /export const PASSWORD_ERROR_MARKER = "([^"]+)"/),
    generatedProtocolValue(rustProtocol, "PASSWORD_ERROR_MARKER", /PASSWORD_ERROR_MARKER: &str = "([^"]+)"/)],
];
for (const [label, expected, ...actuals] of protocolValues) {
  if (!expected || actuals.some((actual) => actual !== expected)) {
    fail(`${label}; expected=${expected ?? "<not found>"}, actual=[${actuals.join(", ")}]`);
  }
}
for (const [label, labels] of [
  ["encoding", protocol.encodingLabels],
  ["EOL", protocol.eolLabels],
]) {
  for (const [key, expected] of Object.entries(labels)) {
    const uiValue = generatedProtocol.match(new RegExp(`\\"${key}\\": \\"([^\\"]+)\\"`))?.[1];
    const rustValue = rustProtocol.match(new RegExp(`\\"${key}\\" => \\"([^\\"]+)\\"`))?.[1];
    if (uiValue !== expected || rustValue !== expected) {
      fail(`${label} label ${key}; expected=${expected}, ui=${uiValue ?? "<not found>"}, rust=${rustValue ?? "<not found>"}`);
    }
  }
}

for (const [uiName, rustName] of [
  ["externalWindowRequest", "EVENT_EXTERNAL_WINDOW_REQUEST"],
  ["workspaceSearchBatch", "EVENT_WORKSPACE_SEARCH_BATCH"],
  ["documentLoadProgress", "EVENT_DOCUMENT_LOAD_PROGRESS"],
  ["viewerUpdate", "EVENT_VIEWER_UPDATE"],
]) {
  const rustEvent = backend.match(new RegExp(`const ${rustName}: &str = "([^"]+)"`))?.[1];
  const uiEvent = frontend.match(new RegExp(`${uiName}: "([^"]+)"`))?.[1]
    ?? (uiName === "documentLoadProgress"
      ? documentLoadProgress.match(/DOCUMENT_LOAD_PROGRESS_EVENT = "([^"]+)"/)?.[1]
      : undefined);
  if (!rustEvent || !uiEvent || rustEvent !== uiEvent) {
    fail(`event name ${uiName}; core=${rustEvent ?? "<not found>"}, ui=${uiEvent ?? "<not found>"}`);
  }
}

const readEncodingBlock = frontend.match(/export const READ_ENCODINGS = \[([^\]]+)\]/)?.[1];
if (!readEncodingBlock) fail("cannot find READ_ENCODINGS");
const readEncodings = names(/"([^"]+)"/g, readEncodingBlock);
const unsupportedReadEncodings = readEncodings.filter((encoding) => !encodingValues.includes(encoding));
if (unsupportedReadEncodings.length) {
  fail(`read encodings are not save encodings; unsupported=[${unsupportedReadEncodings.join(", ")}]`);
}
// ビューのウィンドウは動的生成のため、ラベル接頭辞が capability の許可パターンと外れると
// 権限を失ったまま静かに開いてしまう
const viewerLabelPrefix = backend.match(/format!\("([\w-]+)-\{\}"/)?.[1];
if (!viewerLabelPrefix) fail("cannot find viewer window label prefix");
if (!capabilities.windows.includes(`${viewerLabelPrefix}-*`)) {
  fail(`viewer window capability; label prefix=${viewerLabelPrefix}-, windows=[${capabilities.windows.join(", ")}]`);
}

console.log(`IPC contract OK: ${commands.length} commands, wire enums, structs, and shared constants match.`);
