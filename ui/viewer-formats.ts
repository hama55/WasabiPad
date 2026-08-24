import type { ViewerFormat } from "./api";
import { IMAGE_MIME_TYPES } from "./image-formats";
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
  },
};

export function viewerFormatSpec(format: ViewerFormat): ViewerFormatSpec {
  return VIEWER_FORMATS[format];
}

export function isViewerFormat(value: unknown): value is ViewerFormat {
  return typeof value === "string" && Object.prototype.hasOwnProperty.call(VIEWER_FORMATS, value);
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

export function viewerFormatForPreviewToggle(path: string, _isBinary: boolean): ViewerFormat | null {
  return viewerFormatForPath(path) ?? "markdown";
}

export function isAssetViewerFormat(format: ViewerFormat | null): format is "image" | "pdf" {
  return format === "image" || format === "pdf";
}

export function sourcePathForViewer(
  format: ViewerFormat | null,
  savePath: string | null,
  displayPath: string,
): string | null {
  return savePath ?? (isAssetViewerFormat(format) ? displayPath : null);
}

export function canRenderViewerFormat(format: ViewerFormat, sourcePath: string | null): boolean {
  const sourceFormat = sourcePath ? viewerFormatForPath(sourcePath) : null;
  if (isAssetViewerFormat(format)) return sourceFormat === format;
  return sourceFormat !== "image" && sourceFormat !== "pdf";
}
