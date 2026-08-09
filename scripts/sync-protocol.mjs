import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const source = JSON.parse(readFileSync(resolve(root, "shared/protocol.json"), "utf8"));

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

const ts = [
  "// This file was generated from shared/protocol.json by scripts/sync-protocol.mjs.",
  `export const ARCHIVE_ENTRY_SEPARATOR = ${JSON.stringify(source.archiveEntrySeparator)} as const;`,
  `export const PASSWORD_ERROR_MARKER = ${JSON.stringify(source.passwordErrorMarker)} as const;`,
  `export const IMAGE_MIME_TYPES = ${JSON.stringify(imageMimeTypes, null, 2)} as const;`,
  `export const ENCODING_LABELS = ${JSON.stringify(source.encodingLabels, null, 2)} as const;`,
  `export const EOL_LABELS = ${JSON.stringify(source.eolLabels, null, 2)} as const;`,
  "",
].join("\n");

const rust = [
  "// This file was generated from shared/protocol.json by scripts/sync-protocol.mjs.",
  `pub(crate) const ARCHIVE_ENTRY_SEPARATOR: &str = ${JSON.stringify(source.archiveEntrySeparator)};`,
  `pub(crate) const PASSWORD_ERROR_MARKER: &str = ${JSON.stringify(source.passwordErrorMarker)};`,
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
].join("\n");

writeIfChanged("ui/generated/Protocol.ts", ts);
writeIfChanged("core/src/protocol.rs", rust);
