import {
  isExternalMarkdownLink,
  isLocalMarkdownLinkCandidate,
  markdownLinkTargetOf,
  resolveMarkdownLinkPath,
} from "./viewer-assets";

export type MarkdownLinkAction =
  | { kind: "external"; href: string }
  | { kind: "local"; path: string; fragment: string | null; newTab: boolean }
  | { kind: "unchanged" }
  | { kind: "unresolved"; message: string };

export function markdownLinkActionOf(
  sourcePath: string | null,
  href: string,
  newTab: boolean,
): MarkdownLinkAction {
  if (isExternalMarkdownLink(href)) return { kind: "external", href };
  if (!isLocalMarkdownLinkCandidate(href)) return { kind: "unchanged" };

  const { path, fragment } = markdownLinkTargetOf(href);
  if (!path) return { kind: "unchanged" };
  const resolvedPath = resolveMarkdownLinkPath(sourcePath, href);
  if (!resolvedPath) return { kind: "unresolved", message: "ローカルMarkdownリンクを解決できません" };
  return { kind: "local", path: resolvedPath, fragment, newTab };
}
