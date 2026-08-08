import type { ViewerFormat } from "./api";
import { MENU_ICON, type MenuIconClass } from "./menu-icons";

export interface ViewerFormatSpec {
  readonly id: ViewerFormat;
  readonly label: string;
  readonly title: string;
  readonly iconClass: MenuIconClass;
  readonly extensions: readonly string[];
  readonly supportsDelimiter: boolean;
  readonly supportsChart: boolean;
}

export type ViewerRenderer = (text: string) => void | Promise<void>;
export type ViewerFormatHandler = ViewerFormatSpec & { readonly render: ViewerRenderer };

export const VIEWER_FORMATS: Record<ViewerFormat, ViewerFormatSpec> = {
  csv: {
    id: "csv",
    label: "CSVビュー",
    title: "CSV",
    iconClass: MENU_ICON.csv,
    extensions: [".csv"],
    supportsDelimiter: true,
    supportsChart: true,
  },
  markdown: {
    id: "markdown",
    label: "Markdownビュー",
    title: "Markdown",
    iconClass: MENU_ICON.markdown,
    extensions: [".md", ".markdown"],
    supportsDelimiter: false,
    supportsChart: false,
  },
};

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

export function viewerFormatSpec(format: ViewerFormat): ViewerFormatSpec {
  return VIEWER_FORMATS[format];
}
