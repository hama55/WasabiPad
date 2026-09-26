import { remark } from "remark";
import remarkGfm from "remark-gfm";
import remarkRehype from "remark-rehype";
import rehypeRaw from "rehype-raw";
import rehypeSanitize, { defaultSchema } from "rehype-sanitize";
import rehypeStringify from "rehype-stringify";
import type { Plugin } from "unified";
import type { ViewerSelection } from "./api";
import {
  markdownBlockSelected,
  markdownHighlightTargets,
  markdownHeadingSlug,
  placeMarkdownCaret,
  renderRawHtml,
} from "./viewer-markdown";
import { isCollapsedViewerSelection } from "./viewer-selection";
import {
  markdownCodeBlockSourceSegments,
  markdownInlineCodeSourceSegments,
  markdownTextSourceSegments,
  type MarkdownSourceSegment,
} from "./viewer-markdown-source-map";
import {
  isExternalMarkdownLink,
  isSameDocumentMarkdownLink,
  markdownFragmentOf,
} from "./viewer-assets";

export interface MarkdownRenderResult {
  article: HTMLElement;
  highlightTargets: HTMLElement[];
}

export interface MarkdownRenderOptions {
  sourcePath?: string | null;
  archivePath?: string | null;
  breaks?: boolean;
}

export const MARKDOWN_IMAGE_SOURCE_ATTRIBUTE = "data-wasabipad-src";

type SourcePosition = {
  start: { offset?: number; line: number; column: number };
  end: { offset?: number; line: number; column: number };
};

type MarkdownNode = {
  type: string;
  value?: string;
  position?: SourcePosition;
  data?: { hProperties?: Record<string, unknown> };
  children?: MarkdownNode[];
  align?: Array<"left" | "right" | "center" | null>;
};

type HastNode = {
  type: string;
  tagName?: string;
  value?: string;
  position?: SourcePosition;
  properties?: Record<string, unknown>;
  children?: HastNode[];
};

const sourceMapSanitizeSchema = {
  ...defaultSchema,
  // Existing raw HTML anchors retain id/name in this script-disabled preview iframe.
  clobberPrefix: "",
  attributes: {
    ...defaultSchema.attributes,
    "*": [
      ...(defaultSchema.attributes?.["*"] ?? []),
      "dataSourceStart",
      "dataSourceEnd",
      "dataSourceOffsetStart",
      "dataSourceOffsetEnd",
    ],
    a: [...(defaultSchema.attributes?.a ?? []), "target", "rel"],
    input: [...(defaultSchema.attributes?.input ?? []), "ariaLabel", "className"],
  },
};

function escapeMarkdownHtml(text: string): string {
  return text.replace(/[&<>\"]/g, (char) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    "\"": "&quot;",
  })[char]!);
}

function sourceLineRange(position: SourcePosition): { start: number; end: number } {
  const start = Math.max(0, position.start.line - 1);
  const end = Math.max(start + 1, position.end.line - 1 + Number(position.end.column > 1));
  return { start, end };
}

function markdownPositionTracker(
  source: string,
  startOffset: number,
  start: SourcePosition["start"],
) {
  const current = { line: start.line, column: start.column, offset: startOffset };
  return (offset: number) => {
    while (current.offset < offset) {
      if (source[current.offset] === "\r") {
        current.offset += source[current.offset + 1] === "\n" ? 2 : 1;
        current.line++;
        current.column = 1;
      } else if (source[current.offset] === "\n") {
        current.offset++;
        current.line++;
        current.column = 1;
      } else {
        current.offset += String.fromCodePoint(source.codePointAt(current.offset)!).length;
        current.column++;
      }
    }
    return { ...current };
  };
}

function markdownLineEndingLength(value: string, offset: number): number {
  if (value[offset] === "\r") return value[offset + 1] === "\n" ? 2 : 1;
  return value[offset] === "\n" ? 1 : 0;
}

function markdownTextNodesWithBreaks(node: MarkdownNode, source: string): MarkdownNode[] {
  const start = node.position?.start.offset;
  const end = node.position?.end.offset;
  if (start === undefined || end === undefined || node.value === undefined) return [node];
  const segments = markdownTextSourceSegments(source, start, end, node.value);
  if (!segments) return [node];
  const positionAtOffset = markdownPositionTracker(source, start, node.position!.start);
  const position = (segmentStart: number, segmentEnd: number): SourcePosition => ({
    start: positionAtOffset(segmentStart),
    end: positionAtOffset(segmentEnd),
  });

  const result: MarkdownNode[] = [];
  const appendText = (value: string, segmentStart: number, segmentEnd: number) => {
    if (value) result.push({ ...node, value, position: position(segmentStart, segmentEnd) });
  };
  const appendBreak = (segmentStart: number, segmentEnd: number) => {
    result.push({ type: "break", position: position(segmentStart, segmentEnd) });
  };

  for (const segment of segments) {
    if (!/[\r\n]/.test(segment.text)) {
      appendText(segment.text, segment.start, segment.end);
      continue;
    }
    if (segment.end - segment.start !== segment.text.length) {
      const raw = source.slice(segment.start, segment.end);
      if ((segment.text === "\n" || segment.text === "\r")
        && (raw === "\r" || raw === "\n" || raw === "\r\n")) {
        appendBreak(segment.start, segment.end);
      } else {
        appendText(segment.text, segment.start, segment.end);
      }
      continue;
    }

    let chunkStart = 0;
    for (let index = 0; index < segment.text.length;) {
      const lineEndingLength = markdownLineEndingLength(segment.text, index);
      if (!lineEndingLength) {
        index++;
        continue;
      }
      appendText(segment.text.slice(chunkStart, index), segment.start + chunkStart, segment.start + index);
      appendBreak(segment.start + index, segment.start + index + lineEndingLength);
      index += lineEndingLength;
      chunkStart = index;
    }
    appendText(segment.text.slice(chunkStart), segment.start + chunkStart, segment.end);
  }
  return result.length ? result : [node];
}

function prepareMarkdownTree(tree: MarkdownNode, source: string, breaks: boolean) {
  const visit = (node: MarkdownNode) => {
    if (node.type === "html" && node.value !== undefined) {
      const rendered = renderRawHtml(node.value, escapeMarkdownHtml);
      if (rendered === escapeMarkdownHtml(node.value)) {
        node.type = "text";
      } else {
        node.value = rendered;
      }
    }

    if (node.type === "table" && node.align) {
      node.children?.forEach((row) => row.children?.forEach((cell, index) => {
        const align = node.align?.[index];
        if (align) {
          cell.data = {
            ...cell.data,
            hProperties: { ...cell.data?.hProperties, align },
          };
        }
      }));
    }

    if (node.children) {
      node.children = node.children.flatMap((child) => {
        const children = breaks && child.type === "text" && /[\r\n]/.test(child.value ?? "")
          ? markdownTextNodesWithBreaks(child, source)
          : [child];
        children.forEach(visit);
        return children;
      });
    }
  };
  visit(tree);
}

function markdownSourceMetadataPlugin(source: string, breaks: boolean): Plugin {
  return () => (tree) => prepareMarkdownTree(tree as unknown as MarkdownNode, source, breaks);
}

function sourceSpanNode(segment: MarkdownSourceSegment): HastNode {
  return {
    type: "element",
    tagName: "span",
    properties: {
      dataSourceOffsetStart: segment.start,
      dataSourceOffsetEnd: segment.end,
    },
    children: [{ type: "text", value: segment.text }],
  };
}

function textContent(node: HastNode): string {
  if (node.type === "text") return node.value ?? "";
  return node.children?.map(textContent).join("") ?? "";
}

function markdownSourceMapNode(node: HastNode, source: string, parentTag?: string): HastNode[] {
  if (node.type === "text") {
    const start = node.position?.start?.offset;
    const end = node.position?.end?.offset;
    if (start === undefined || end === undefined || node.value === undefined) return [node];
    const segments = markdownTextSourceSegments(source, start, end, node.value);
    if (!segments?.length) return [node];
    return segments.map(sourceSpanNode);
  }

  if (node.type !== "element") {
    if (node.children) node.children = node.children.flatMap((child) => markdownSourceMapNode(child, source));
    return [node];
  }

  if (node.tagName === "br" && node.position?.start?.offset !== undefined && node.position.end?.offset !== undefined) {
    node.properties = {
      ...node.properties,
      dataSourceOffsetStart: node.position.start.offset,
      dataSourceOffsetEnd: node.position.end.offset,
    };
  }

  if (node.tagName === "code" && node.position) {
    const value = textContent(node);
    const start = node.position.start.offset;
    const end = node.position.end.offset;
    const sourceValue = parentTag === "pre" && value.endsWith("\n") ? value.slice(0, -1) : value;
    const segments = start === undefined || end === undefined
      ? null
      : parentTag === "pre"
        ? markdownCodeBlockSourceSegments(source, start, end, sourceValue)
        : markdownInlineCodeSourceSegments(source, start, end, sourceValue);
    if (segments?.length) {
      node.children = segments.map(sourceSpanNode);
      const mappedValue = segments.map((segment) => segment.text).join("");
      if (mappedValue.length < value.length) {
        node.children.push({ type: "text", value: value.slice(mappedValue.length) });
      }
    }
  } else if (node.children) {
    node.children = node.children.flatMap((child) => markdownSourceMapNode(child, source, node.tagName));
  }

  if (node.position && ["blockquote", "h1", "h2", "h3", "h4", "h5", "h6", "hr", "li", "ol", "p", "pre", "table", "ul"].includes(node.tagName ?? "")) {
    const lines = sourceLineRange(node.position);
    node.properties = {
      ...node.properties,
      dataSourceStart: lines.start,
      dataSourceEnd: lines.end,
    };
  }
  return [node];
}

function markdownHastSourceMapPlugin(source: string): Plugin {
  return () => (tree) => {
    const root = tree as unknown as HastNode;
    if (root.children) root.children = root.children.flatMap((node) => markdownSourceMapNode(node, source));
  };
}

function deferMarkdownImageSources(article: HTMLElement) {
  article.querySelectorAll<HTMLImageElement>("img[src]").forEach((image) => {
    const source = image.getAttribute("src");
    if (source === null) return;
    image.setAttribute(MARKDOWN_IMAGE_SOURCE_ATTRIBUTE, source);
    image.removeAttribute("src");
  });
}

function decorateTaskListItems(article: HTMLElement) {
  article.querySelectorAll<HTMLLIElement>("li").forEach((item) => {
    const checkbox = item.querySelector<HTMLInputElement>("input[type=checkbox]");
    if (!checkbox) return;
    checkbox.disabled = true;
    checkbox.className = "viewer-markdown-task";
    checkbox.setAttribute("aria-label", checkbox.checked ? "完了" : "未完了");
    item.classList.add("viewer-markdown-task-list-item");
  });
}

function assignMarkdownHeadingIds(article: HTMLElement) {
  const used = new Set([...article.querySelectorAll<HTMLElement>("[id]")]
    .map((element) => element.id)
    .filter(Boolean));
  const counts = new Map<string, number>();
  article.querySelectorAll<HTMLElement>("h1, h2, h3, h4, h5, h6").forEach((heading) => {
    const base = markdownHeadingSlug(heading.textContent ?? "");
    if (!base) return;
    let suffix = counts.get(base) ?? 0;
    let id = suffix ? `${base}-${suffix}` : base;
    while (used.has(id)) {
      suffix += 1;
      id = `${base}-${suffix}`;
    }
    counts.set(base, suffix + 1);
    heading.id = id;
    used.add(id);
  });
}

function markdownLinkTitle(
  href: string,
  options: MarkdownRenderOptions,
): string {
  if (isSameDocumentMarkdownLink(options.sourcePath ?? null, href)) {
    return "クリックで同じ文書内を移動";
  }
  if (isExternalMarkdownLink(href)) {
    return "Ctrl+クリックで既定のブラウザで開く";
  }
  if (markdownFragmentOf(href) !== null && !options.archivePath) {
    return "Ctrl+クリックで新規タブを開いて該当箇所へ移動";
  }
  return "Ctrl+クリックで新規タブで開く";
}

export function renderMarkdownDocument(
  text: string,
  selection: ViewerSelection | null,
  options: MarkdownRenderOptions = {},
): MarkdownRenderResult {
  const article = document.createElement("article");
  article.dataset.markdownSource = text;
  const processor = remark().use(remarkGfm, { singleTilde: false });
  const html = processor
    .use(markdownSourceMetadataPlugin(text, options.breaks ?? true))
    .use(remarkRehype, { allowDangerousHtml: true })
    .use(rehypeRaw)
    .use(markdownHastSourceMapPlugin(text))
    .use(rehypeSanitize, sourceMapSanitizeSchema)
    .use(rehypeStringify)
    .processSync(text)
    .toString();
  article.innerHTML = html;
  // DOM挿入直後のブラウザ任せの全件読込を止め、viewer.tsの上限付きローダーへ渡す。
  deferMarkdownImageSources(article);
  decorateTaskListItems(article);
  assignMarkdownHeadingIds(article);
  const sourceElements = [...article.querySelectorAll<HTMLElement>("[data-source-start]")];
  const highlightTargets = markdownHighlightTargets(sourceElements);
  highlightTargets.forEach((element) => {
    const start = Number(element.dataset.sourceStart);
    const end = Number(element.dataset.sourceEnd);
    const selected = markdownBlockSelected(selection, start, end);
    element.classList.toggle("viewer-source-selected", !isCollapsedViewerSelection(selection) && selected);
    element.classList.toggle("viewer-caret-line", isCollapsedViewerSelection(selection) && selected);
  });
  placeMarkdownCaret(highlightTargets, text, selection);
  article.querySelectorAll("a").forEach((link) => {
    link.target = "_blank";
    link.rel = "noreferrer";
    link.title = markdownLinkTitle(link.getAttribute("href") ?? "", options);
  });
  return { article, highlightTargets };
}
