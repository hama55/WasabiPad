import type { ViewerFormat } from "./api";
import { commandLineForFile } from "./registered-commands";
import type { DocumentSession } from "./session";
import { viewerFormatForPath } from "./viewer-formats";

export type ExternalCommandMap = Record<string, string>;

export const FILE_PLACEHOLDER = "{file}";

export function commandTemplateFor(
  commands: Readonly<ExternalCommandMap>,
  key: string,
): string | null {
  const template = commands[key]?.trim();
  return template || null;
}

export function commandLineForExternalFile(template: string, path: string): string {
  if (!template.includes(FILE_PLACEHOLDER)) {
    throw new Error(`連携コマンドには${FILE_PLACEHOLDER}が必要です`);
  }
  return commandLineForFile("", template, path);
}

export function fileExtensionOf(path: string): string | null {
  const name = path.split(/[\\/]/).pop() ?? "";
  const dot = name.lastIndexOf(".");
  if (dot <= 0 || dot === name.length - 1) return null;
  return name.slice(dot + 1).toLowerCase();
}

export function editorExtensionOf(
  path: string,
  effectiveExtension: string | null = null,
): string | null {
  const effective = effectiveExtension?.trim().replace(/^\./, "").toLowerCase();
  return effective || fileExtensionOf(path);
}

export function canUseExternalEditor(
  session: Pick<DocumentSession, "savePath" | "archivePath" | "archiveEntry">,
  path: string,
): boolean {
  return session.savePath === path
    && !session.archivePath
    && !session.archiveEntry;
}

export function canUseExternalPreview(
  sourcePath: string | null,
  format: ViewerFormat,
  archivePath: string | null,
  archiveEntry: string | null,
): boolean {
  return !!sourcePath
    && !archivePath
    && !archiveEntry
    && viewerFormatForPath(sourcePath) === format;
}
