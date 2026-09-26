import type { ViewerSelection } from "./api";
import { INLINE_PREVIEW_MESSAGES } from "./inline-preview-protocol";
import { scrollViewerCaret } from "./viewer-scroll";
import {
  MARKDOWN_SOURCE_OFFSET_END,
  MARKDOWN_SOURCE_OFFSET_START,
  markdownDisplayOffsetForSourceOffset,
  markdownSourceOffsetAtPosition,
} from "./viewer-markdown-source-map";

const IMG_ATTRIBUTES = ["src", "alt", "title", "width", "height"];
const ANCHOR_ATTRIBUTES = ["id", "name"];

type SafeAnchor = HTMLAnchorElement | HTMLSpanElement;

export function applyMarkdownHeadingUnderlinesToRoot(root: HTMLElement, enabled: boolean): boolean {
  root.classList.toggle("markdown-heading-underlines", enabled);
  return enabled;
}

export function applyMarkdownHeadingUnderlinesMessage(
  root: HTMLElement,
  current: boolean,
  data: unknown,
): boolean {
  if (!data || typeof data !== "object") return current;
  const message = data as { type?: unknown; enabled?: unknown };
  if (message.type !== INLINE_PREVIEW_MESSAGES.MARKDOWN_HEADING_UNDERLINES_MESSAGE
    || typeof message.enabled !== "boolean"
    || message.enabled === current) return current;
  return applyMarkdownHeadingUnderlinesToRoot(root, message.enabled);
}

function isSafeAnchor(node: Node): node is SafeAnchor {
  return (node instanceof HTMLAnchorElement || node instanceof HTMLSpanElement)
    && node.children.length === 0;
}

export function renderRawHtml(raw: string, escape: (text: string) => string): string {
  // template の中身は不活性なので、この時点で画像取得もハンドラ実行も起きない
  const template = document.createElement("template");
  template.innerHTML = raw.trim();
  const nodes = [...template.content.childNodes];
  if (!nodes.length || nodes.some((node) => {
    if (node.nodeType === Node.TEXT_NODE) return !!node.textContent?.trim();
    return !(node instanceof HTMLImageElement || node instanceof HTMLBRElement || isSafeAnchor(node));
  })) return escape(raw);
  return nodes
    .filter((node): node is HTMLImageElement | HTMLBRElement | SafeAnchor =>
      node instanceof HTMLImageElement || node instanceof HTMLBRElement || isSafeAnchor(node),
    )
    .map((node) => {
      if (node instanceof HTMLBRElement) return "<br>";
      const allowed = isSafeAnchor(node) ? ANCHOR_ATTRIBUTES : IMG_ATTRIBUTES;
      for (const name of node.getAttributeNames()) {
        if (!allowed.includes(name.toLowerCase())) node.removeAttribute(name);
      }
      return node.outerHTML;
    })
    .join("\n");
}

export function markdownHeadingSlug(text: string): string {
  return text
    .normalize("NFKC")
    .toLocaleLowerCase("en-US")
    .replace(/[^\p{L}\p{N}\s-]/gu, "")
    .trim()
    .replace(/\s+/gu, "-");
}

export function scrollMarkdownFragment(article: HTMLElement, fragment: string): boolean {
  const target = fragment
    ? [...article.querySelectorAll<HTMLElement>("[id], [name]")]
      .find((element) => element.id === fragment || element.getAttribute("name") === fragment)
    : article;
  if (!target) return false;
  target.scrollIntoView?.({ block: "start", inline: "nearest" });
  return true;
}

export function markdownHighlightTargets(sourceElements: HTMLElement[]): HTMLElement[] {
  return sourceElements.filter((element) => !element.querySelector("[data-source-start]"));
}

export function markdownBlockSelected(selection: ViewerSelection | null, start: number, end: number): boolean {
  if (!selection) return false;
  const { start: selectionStart, end: selectionEnd } = selection;
  const lastSelectedLine = selectionStart.line === selectionEnd.line && selectionStart.col === selectionEnd.col
    ? selectionEnd.line
    : selectionEnd.line - Number(selectionEnd.col === 0);
  return start <= lastSelectedLine && end > selectionStart.line;
}

function markdownTargetForLine(sourceElements: HTMLElement[], line: number): HTMLElement | undefined {
  return sourceElements.find((element) => {
    const start = Number(element.dataset.sourceStart);
    const end = Number(element.dataset.sourceEnd);
    return start <= line && line < end;
  });
}

export function placeMarkdownCaret(
  sourceElements: HTMLElement[],
  sourceText: string,
  selection: ViewerSelection | null,
): HTMLElement | null {
  sourceElements.forEach((element) => {
    element.querySelectorAll(".viewer-markdown-caret").forEach((caret) => caret.remove());
  });
  if (!selection || !(
    selection.start.line === selection.end.line && selection.start.col === selection.end.col
  )) return null;
  const target = markdownTargetForLine(sourceElements, selection.start.line);
  if (!target) return null;
  const sourceOffset = markdownSourceOffsetAtPosition(sourceText, selection.start);
  const mappedSpans = [...target.querySelectorAll<HTMLElement>(
    `[${MARKDOWN_SOURCE_OFFSET_START}][${MARKDOWN_SOURCE_OFFSET_END}]`,
  )];
  let best: { span: HTMLElement; offset: number; distance: number } | null = null;
  for (const span of mappedSpans) {
    const start = Number(span.getAttribute(MARKDOWN_SOURCE_OFFSET_START));
    const end = Number(span.getAttribute(MARKDOWN_SOURCE_OFFSET_END));
    const textLength = span.textContent?.length ?? 0;
    if (!Number.isFinite(start) || !Number.isFinite(end) || end < start || !textLength) continue;
    const distance = sourceOffset < start ? start - sourceOffset : sourceOffset > end ? sourceOffset - end : 0;
    const offset = markdownDisplayOffsetForSourceOffset(start, end, textLength, sourceOffset);
    if (!best || distance < best.distance) best = { span, offset, distance };
  }
  if (!best) return null;

  const caret = document.createElement("span");
  caret.className = "viewer-markdown-caret";
  caret.setAttribute("aria-hidden", "true");
  const walker = document.createTreeWalker(best.span, NodeFilter.SHOW_TEXT);
  const text = walker.nextNode();
  if (!(text instanceof Text)) return null;
  const after = text.splitText(Math.max(0, Math.min(text.length, best.offset)));
  after.parentNode?.insertBefore(caret, after);
  return caret;
}

export function scrollMarkdownCaret(sourceElements: HTMLElement[], selection: ViewerSelection | null) {
  scrollViewerCaret(sourceElements, selection, (element) => ({
    start: Number(element.dataset.sourceStart),
    end: Number(element.dataset.sourceEnd),
  }));
}
