import type { ViewerSelection } from "./api";
import { scrollViewerCaret } from "./viewer-scroll";

const IMG_ATTRIBUTES = ["src", "alt", "title", "width", "height"];
const ANCHOR_ATTRIBUTES = ["id", "name"];

type SafeAnchor = HTMLAnchorElement | HTMLSpanElement;

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

function renderedPrefixForSource(source: string, sourceOffset: number, rendered: string): string {
  const renderedChars = [...rendered];
  let renderedIndex = 0;
  for (const char of [...source.slice(0, sourceOffset)]) {
    if (renderedChars[renderedIndex] === char) {
      renderedIndex += 1;
      continue;
    }
    const next = renderedChars.indexOf(char, renderedIndex);
    if (next >= 0) renderedIndex = next + 1;
  }
  return renderedChars.slice(0, renderedIndex).join("");
}

export function placeMarkdownCaret(
  sourceElements: HTMLElement[],
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
  const sourceStart = Number(target.dataset.sourceStart);
  const source = target.dataset.sourceText ?? "";
  const lines = source.split("\n");
  const relativeLine = Math.max(0, Math.min(lines.length - 1, selection.start.line - sourceStart));
  const column = Math.max(0, Math.min([...lines[relativeLine]].length, selection.start.col));
  const sourceOffset = lines
    .slice(0, relativeLine)
    .reduce((total, line) => total + line.length + 1, 0)
    + [...lines[relativeLine]].slice(0, column).join("").length;
  const renderedPrefix = renderedPrefixForSource(source, sourceOffset, target.textContent ?? "");
  const caret = document.createElement("span");
  caret.className = "viewer-markdown-caret";
  caret.setAttribute("aria-hidden", "true");
  const walker = document.createTreeWalker(target, NodeFilter.SHOW_TEXT);
  let remaining = renderedPrefix.length;
  let node: Node | null;
  while ((node = walker.nextNode())) {
    const text = node.textContent ?? "";
    if (remaining <= text.length) {
      const after = (node as Text).splitText(remaining);
      node.parentNode?.insertBefore(caret, after);
      return caret;
    }
    remaining -= text.length;
  }
  target.appendChild(caret);
  return caret;
}

export function scrollMarkdownCaret(sourceElements: HTMLElement[], selection: ViewerSelection | null) {
  scrollViewerCaret(sourceElements, selection, (element) => ({
    start: Number(element.dataset.sourceStart),
    end: Number(element.dataset.sourceEnd),
  }));
}
