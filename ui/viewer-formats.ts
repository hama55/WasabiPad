import type { OpenAs, ViewerFormat } from "./api";
import { IMAGE_MIME_TYPES } from "./image-formats";
import { VIDEO_EXTENSIONS } from "./generated/Protocol";
import { MENU_ICON, type MenuIconClass } from "./menu-icons";

export interface ViewerFormatSpec {
  readonly id: ViewerFormat;
  readonly label: string;
  readonly title: string;
  readonly previewOrder: number;
  readonly iconClass: MenuIconClass;
  readonly extensions: readonly string[];
  readonly supportsDelimiter: boolean;
  readonly supportsChart: boolean;
  readonly supportsDefaultBrowser: boolean;
  readonly openAs?: { readonly id: OpenAs; readonly order: number };
}

export type ViewerRenderer = (text: string) => void | Promise<void>;
export type ViewerFormatHandler = ViewerFormatSpec & { readonly render: ViewerRenderer };

export const VIEWER_FORMATS: Record<ViewerFormat, ViewerFormatSpec> = {
  csv: {
    id: "csv",
    label: "CSVビュー",
    title: "CSV",
    previewOrder: 1,
    iconClass: MENU_ICON.csv,
    extensions: [".csv"],
    supportsDelimiter: true,
    supportsChart: true,
    supportsDefaultBrowser: false,
    openAs: { id: "csv", order: 1 },
  },
  markdown: {
    id: "markdown",
    label: "Markdownビュー",
    title: "Markdown",
    previewOrder: 0,
    iconClass: MENU_ICON.markdown,
    extensions: [".md", ".markdown"],
    supportsDelimiter: false,
    supportsChart: false,
    supportsDefaultBrowser: false,
    openAs: { id: "md", order: 0 },
  },
  image: {
    id: "image",
    label: "Imageビュー",
    title: "Image",
    previewOrder: 2,
    iconClass: MENU_ICON.image,
    extensions: Object.keys(IMAGE_MIME_TYPES).map((extension) => `.${extension}`),
    supportsDelimiter: false,
    supportsChart: false,
    supportsDefaultBrowser: false,
  },
  pdf: {
    id: "pdf",
    label: "PDFビュー",
    title: "PDF",
    previewOrder: 3,
    iconClass: MENU_ICON.pdf,
    extensions: [".pdf"],
    supportsDelimiter: false,
    supportsChart: false,
    supportsDefaultBrowser: false,
    openAs: { id: "pdf", order: 3 },
  },
  html: {
    id: "html",
    label: "html(静的)",
    title: "html(静的)",
    previewOrder: 4,
    iconClass: MENU_ICON.html,
    extensions: [".html", ".htm"],
    supportsDelimiter: false,
    supportsChart: false,
    supportsDefaultBrowser: true,
    openAs: { id: "html", order: 2 },
  },
  sqlite: {
    id: "sqlite",
    label: "SQLiteビュー",
    title: "SQLite",
    previewOrder: 5,
    iconClass: MENU_ICON.sqlite,
    extensions: [".sqlite", ".sqlite3"],
    supportsDelimiter: false,
    supportsChart: false,
    supportsDefaultBrowser: false,
  },
  video: {
    id: "video",
    label: "Videoビュー",
    title: "Video",
    previewOrder: 6,
    iconClass: MENU_ICON.video,
    extensions: VIDEO_EXTENSIONS.map((extension) => `.${extension}`),
    supportsDelimiter: false,
    supportsChart: false,
    supportsDefaultBrowser: false,
  },
  git: {
    id: "git", label: "Git履歴", title: "Git履歴", previewOrder: 7,
    iconClass: MENU_ICON.expandFolder, extensions: [],
    supportsDelimiter: false, supportsChart: false, supportsDefaultBrowser: false,
  },
};

export function viewerFormatSpec(format: ViewerFormat): ViewerFormatSpec {
  return VIEWER_FORMATS[format];
}

export function isViewerFormat(value: unknown): value is ViewerFormat {
  return typeof value === "string" && Object.prototype.hasOwnProperty.call(VIEWER_FORMATS, value);
}

export function isGitPreviewPath(path: string): boolean {
  return !path.includes("::") && path.replace(/\\/g, "/").replace(/\/$/, "").split("/").at(-1) === ".git";
}

export function createViewerFormatHandlers(
  renderers: Record<ViewerFormat, ViewerRenderer>,
): Record<ViewerFormat, ViewerFormatHandler> {
  return Object.fromEntries(
    Object.values(VIEWER_FORMATS).map((spec) => [spec.id, { ...spec, render: renderers[spec.id] }]),
  ) as Record<ViewerFormat, ViewerFormatHandler>;
}

export function viewerFormatForPath(path: string): ViewerFormat | null {
  const lowerPath = path.toLowerCase();
  const format = Object.values(VIEWER_FORMATS).find((spec) =>
    spec.extensions.some((extension) => lowerPath.endsWith(extension)),
  );
  return format?.id ?? null;
}

export function isSqliteCandidatePath(path: string): boolean {
  const lowerPath = path.toLowerCase();
  return lowerPath.endsWith(".db") || lowerPath.endsWith(".sqlite") || lowerPath.endsWith(".sqlite3");
}

export type SqlitePreviewFallback = "markdown" | "clear" | "keep";

export async function resolveSqlitePreviewAction(
  sourcePath: string | null,
  fallback: SqlitePreviewFallback,
  probe: (path: string) => Promise<boolean>,
): Promise<"sqlite" | SqlitePreviewFallback> {
  if (sourcePath === null) return fallback === "keep" ? "keep" : "clear";
  return isSqliteCandidatePath(sourcePath) && await probe(sourcePath) ? "sqlite" : fallback;
}

export function viewerFormatForAutomaticPreview(path: string): ViewerFormat | null {
  return isSqliteCandidatePath(path) ? "sqlite" : viewerFormatForPath(path);
}

export function viewerFormatForPreviewToggle(path: string): ViewerFormat | null {
  return viewerFormatForAutomaticPreview(path) ?? "markdown";
}

export function isAssetViewerFormat(format: ViewerFormat | null): format is "image" | "pdf" | "video" {
  return format === "image" || format === "pdf" || format === "video";
}

export function sourcePathForViewer(
  format: ViewerFormat | null,
  savePath: string | null,
  displayPath: string,
): string | null {
  return savePath ?? (isAssetViewerFormat(format) || format === "sqlite" ? displayPath : null);
}

export function canRenderViewerFormat(format: ViewerFormat, sourcePath: string | null, archiveSource = false): boolean {
  const gitTarget = sourcePath !== null && isGitPreviewPath(sourcePath) && !archiveSource;
  if (format === "git" || gitTarget) return format === "git" && gitTarget;
  if (format === "video" && archiveSource) return false;
  if (sourcePath && isSqliteCandidatePath(sourcePath)) return format === "sqlite";
  const sourceFormat = sourcePath ? viewerFormatForPath(sourcePath) : null;
  if (sourceFormat === "sqlite") return format === "sqlite";
  if (format === "sqlite") return false;
  if (isAssetViewerFormat(format)) return sourceFormat === format;
  return !isAssetViewerFormat(sourceFormat);
}
