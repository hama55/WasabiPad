import type { ViewerSelection } from "./api";
import { scrollViewerCaret } from "./viewer-scroll";

const IMG_ATTRIBUTES = ["src", "alt", "title", "width", "height"];

export function renderRawHtml(raw: string, escape: (text: string) => string): string {
  // template の中身は不活性なので、この時点で画像取得もハンドラ実行も起きない
  const template = document.createElement("template");
  template.innerHTML = raw.trim();
  const nodes = [...template.content.childNodes];
  if (!nodes.length || nodes.some((node) => {
    if (node.nodeType === Node.TEXT_NODE) return !!node.textContent?.trim();
    return !(node instanceof HTMLImageElement);
  })) return escape(raw);
  return nodes
    .filter((node): node is HTMLImageElement => node instanceof HTMLImageElement)
    .map((img) => {
      for (const name of img.getAttributeNames()) {
        if (!IMG_ATTRIBUTES.includes(name.toLowerCase())) img.removeAttribute(name);
      }
      return img.outerHTML;
    })
    .join("\n");
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

export function scrollMarkdownCaret(sourceElements: HTMLElement[], selection: ViewerSelection | null) {
  scrollViewerCaret(sourceElements, selection, (element) => ({
    start: Number(element.dataset.sourceStart),
    end: Number(element.dataset.sourceEnd),
  }));
}
