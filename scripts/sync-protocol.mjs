import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const source = JSON.parse(readFileSync(resolve(root, "shared/protocol.json"), "utf8"));

if (!Array.isArray(source.archiveFormats) || source.archiveFormats.length === 0
  || source.archiveFormats.some((format) => typeof format !== "string" || format.length === 0)) {
  throw new Error("archiveFormats設定が不正です");
}
if (!source.events || Object.values(source.events).some((event) => typeof event !== "string" || event.length === 0)) {
  throw new Error("events設定が不正です");
}

const byteSize = source.byteSize;
if (!Number.isInteger(byteSize?.base) || byteSize.base < 2
  || !Number.isInteger(byteSize?.fractionDigits) || byteSize.fractionDigits < 0
  || !Array.isArray(byteSize?.units) || byteSize.units.length < 2
  || byteSize.units.some((unit) => typeof unit !== "string" || unit.length === 0)) {
  throw new Error("byteSize設定が不正です");
}

const mimeOwners = new Map();
for (const format of source.imageFormats) {
  const canonical = format.canonicalExtension ?? format.extensions[0];
  if (!format.extensions.includes(canonical)) {
    throw new Error(`画像形式のcanonicalExtensionがextensionsにありません: ${format.extensions.join(",")}`);
  }
  for (const mimeType of format.mimeTypes) {
    const previous = mimeOwners.get(mimeType);
    if (previous && previous !== canonical) {
      throw new Error(`画像MIMEのcanonicalExtensionが重複しています: ${mimeType}`);
    }
    mimeOwners.set(mimeType, canonical);
  }
}

function writeIfChanged(path, contents) {
  const target = resolve(root, path);
  let current = null;
  try {
    current = readFileSync(target, "utf8");
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  if (current !== contents) writeFileSync(target, contents);
}

const imageMimeTypes = Object.fromEntries(
  source.imageFormats.flatMap(({ extensions, mimeTypes }) => extensions.map((extension) => [extension, mimeTypes[0]])),
);
const imageFormats = source.imageFormats.map(({ extensions, canonicalExtension }) =>
  canonicalExtension ?? extensions[0]);
const imageExtensions = source.imageFormats.flatMap(({ extensions }) => extensions);
const imageMimeBranches = source.imageFormats
  .flatMap(({ extensions, canonicalExtension, mimeTypes }) => mimeTypes.map((mimeType) =>
    `    ${JSON.stringify(mimeType)} => Some(${JSON.stringify(canonicalExtension ?? extensions[0])}),`))
  .join("\n");

function rustLabelFunction(name, labels) {
  const branches = Object.entries(labels)
    .map(([key, value]) => `        ${JSON.stringify(key)} => ${JSON.stringify(value)},`)
    .join("\n");
  return [
    `pub(crate) fn ${name}(key: &str) -> &'static str {`,
    "    match key {",
    branches,
    '        _ => "",',
    "    }",
    "}",
  ].join("\n");
}

function screamingSnake(value) {
  return value.replace(/([a-z0-9])([A-Z])/g, "$1_$2").toUpperCase();
}

// The algorithm order lives in one template; language entries only provide syntax fragments.
const byteSizeTemplate = [
  "{{signature}}",
  "{{returnSmall}}",
  "{{initialize}}",
  "{{scale}}",
  "{{format}}",
  "}",
].join("\n");
const byteSizeRenderers = {
  typescript: {
    signature: "export function formatByteSize(bytes: number): string {",
    returnSmall: "  if (bytes < BYTE_SIZE_BASE) return `${bytes} ${BYTE_SIZE_UNITS[0]}`;",
    initialize: [
      "  let unitIndex = 1;",
      "  let value = bytes / BYTE_SIZE_BASE;",
    ],
    scale: [
      `  while (value >= BYTE_SIZE_BASE && unitIndex < ${byteSize.units.length - 1}) {`,
      "    value /= BYTE_SIZE_BASE;",
      "    unitIndex += 1;",
      "  }",
    ],
    format: "  return `${value.toFixed(BYTE_SIZE_FRACTION_DIGITS)} ${BYTE_SIZE_UNITS[unitIndex]}`;",
  },
  rust: {
    signature: "pub(crate) fn format_byte_size(bytes: u64) -> String {",
    returnSmall: "    if bytes < BYTE_SIZE_BASE {",
    initialize: [
      "        return format!(\"{bytes} {}\", BYTE_SIZE_UNITS[0]);",
      "    }",
      "    let mut unit_index = 1usize;",
      "    let mut value = bytes as f64 / BYTE_SIZE_BASE as f64;",
    ],
    scale: [
      `    while value >= BYTE_SIZE_BASE as f64 && unit_index < ${byteSize.units.length - 1} {`,
      "        value /= BYTE_SIZE_BASE as f64;",
      "        unit_index += 1;",
      "    }",
    ],
    format: `    format!(\"{value:.${byteSize.fractionDigits}} {}\", BYTE_SIZE_UNITS[unit_index])`,
  },
};

function renderByteSizeFunction(language) {
  const renderer = byteSizeRenderers[language];
  return byteSizeTemplate.replace(/\{\{(\w+)\}\}/g, (_, operation) => {
    const lines = renderer[operation];
    return Array.isArray(lines) ? lines.join("\n") : lines;
  });
}

function rustByteSizeFunction() {
  return [
    `pub(crate) const BYTE_SIZE_BASE: u64 = ${byteSize.base};`,
    `pub(crate) const BYTE_SIZE_UNITS: [&str; ${byteSize.units.length}] = ${JSON.stringify(byteSize.units)};`,
    "",
    renderByteSizeFunction("rust"),
  ].join("\n");
}

const ts = [
  "// This file was generated from shared/protocol.json by scripts/sync-protocol.mjs.",
  `export const ARCHIVE_ENTRY_SEPARATOR = ${JSON.stringify(source.archiveEntrySeparator)} as const;`,
  `export const PASSWORD_ERROR_MARKER = ${JSON.stringify(source.passwordErrorMarker)} as const;`,
  `export const ARCHIVE_FORMATS = ${JSON.stringify(source.archiveFormats)} as const;`,
  "export function isArchiveFormat(value: string | null | undefined): value is (typeof ARCHIVE_FORMATS)[number] {",
  "  return typeof value === \"string\" && ARCHIVE_FORMATS.some((format) => format === value.toLowerCase());",
  "}",
  `export const EVENT_NAMES = ${JSON.stringify(source.events, null, 2)} as const;`,
  `export const IMAGE_FORMATS = ${JSON.stringify(imageFormats)} as const;`,
  `export const IMAGE_MIME_TYPES = ${JSON.stringify(imageMimeTypes, null, 2)} as const;`,
  `export const ENCODING_LABELS = ${JSON.stringify(source.encodingLabels, null, 2)} as const;`,
  `export const EOL_LABELS = ${JSON.stringify(source.eolLabels, null, 2)} as const;`,
  "",
  `export const BYTE_SIZE_BASE = ${byteSize.base} as const;`,
  `export const BYTE_SIZE_FRACTION_DIGITS = ${byteSize.fractionDigits} as const;`,
  `export const BYTE_SIZE_UNITS = ${JSON.stringify(byteSize.units)} as const;`,
  "",
  renderByteSizeFunction("typescript"),
  "",
].join("\n");

const rust = [
  "// This file was generated from shared/protocol.json by scripts/sync-protocol.mjs.",
  `pub(crate) const ARCHIVE_ENTRY_SEPARATOR: &str = ${JSON.stringify(source.archiveEntrySeparator)};`,
  `pub(crate) const PASSWORD_ERROR_MARKER: &str = ${JSON.stringify(source.passwordErrorMarker)};`,
  ...Object.entries(source.events).map(([name, value]) =>
    `pub const EVENT_${screamingSnake(name)}: &str = ${JSON.stringify(value)};`),
  "",
  "pub(crate) fn is_archive_extension(extension: &str) -> bool {",
  `    matches!(extension.to_ascii_lowercase().as_str(), ${source.archiveFormats.map((value) => JSON.stringify(value)).join(" | ")})`,
  "}",
  "",
  "pub(crate) fn is_image_extension(extension: &str) -> bool {",
  `    matches!(extension.to_ascii_lowercase().as_str(), ${imageExtensions.map((value) => JSON.stringify(value)).join(" | ")})`,
  "}",
  "",
  "pub(crate) fn image_extension_for_mime(mime_type: &str) -> Option<&'static str> {",
  "    match mime_type.split(';').next().unwrap_or_default().trim().to_ascii_lowercase().as_str() {",
  imageMimeBranches,
  "        _ => None,",
  "    }",
  "}",
  "",
  rustLabelFunction("encoding_label", source.encodingLabels),
  "",
  rustLabelFunction("eol_label", source.eolLabels),
  "",
  rustByteSizeFunction(),
  "",
].join("\n");

writeIfChanged("ui/generated/Protocol.ts", ts);
writeIfChanged("core/src/protocol.rs", rust);
