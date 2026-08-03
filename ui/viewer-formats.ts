import type { ViewerFormat } from "./api";

export interface ViewerFormatSpec {
  readonly id: ViewerFormat;
  readonly label: string;
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
    extensions: [".csv"],
    supportsDelimiter: true,
    supportsChart: true,
  },
  markdown: {
    id: "markdown",
    label: "Markdownビュー",
    extensions: [".md", ".markdown"],
    supportsDelimiter: false,
    supportsChart: false,
  },
};

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
